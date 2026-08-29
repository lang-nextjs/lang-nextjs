/**
 * The router — this runtime's answer to apps/fastapi-backend/main.py.
 *
 * SAME ROUTE SHAPE, SAME STATUS CODES, SAME BODY KEYS. The reference app's
 * runtime selector only works if fastapi, django and node are interchangeable
 * behind one contract, so main.py's dispatch IS the specification and this is a
 * translation of it, not a redesign:
 *
 *   GET  /health                        status, ai_backends, topologies, llm, observability
 *   GET  /api/tools/{ai_backend}        ai_backend, topology, tools, mcps
 *   POST /api/chat/stream/{ai_backend}  SSE, topology from body.topology
 *   POST /api/chat/stream               legacy — see LEGACY_AI_BACKEND
 *
 * THE 404 BODY IS `{"detail": ...}`, MATCHING FASTAPI AND NOT DJANGO. Django's
 * view answers `{"error": ...}` for the same condition, and #329's routing
 * suite uses precisely that difference to prove which process answered a
 * request. Node is a third process and could have had a third envelope; it
 * takes FastAPI's, because these two are the ones a reader compares and an
 * arbitrary third spelling would be a difference that means nothing. If a
 * future suite needs to tell node from fastapi, it should be given something
 * that IS about node — /health already reports different topologies — rather
 * than an error-shape accident.
 *
 * NO FRAMEWORK. node:http and hand-written routing, because the whole surface
 * is four routes and a dependency here would be one more thing a forker has to
 * understand before they can read the dispatch.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AI_BACKENDS,
  DEFAULT_TOPOLOGY,
  LEGACY_AI_BACKEND,
  topologiesByBackend,
  type ChatMessage,
} from "./registry.js";
import { llmStatus } from "./common/llm.js";
import { observabilityStatus } from "./common/observability.js";
import { guardedStream } from "./common/guardedStream.js";
import { withRunAxes } from "./common/runAxes.js";
import { TOOLS } from "./common/tools.js";

/** This process's runtime axis — a third value beside "fastapi" and "django". */
export const RUNTIME = "node";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://frontend:3001",
  "http://frontend:3002",
]);

const MAX_BODY_BYTES = 1_048_576;

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded before the buffer grows, not after — an unbounded read is a
    // memory DoS on a route that takes an unauthenticated POST.
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

class PayloadTooLarge extends Error {}

function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .map((m) => ({
      role: typeof m.role === "string" ? m.role : "user",
      content: typeof m.content === "string" ? m.content : "",
    }));
}

async function handleChatStream(
  aiBackend: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const module = AI_BACKENDS[aiBackend];
  if (module === undefined) {
    json(res, 404, {
      detail: `unknown ai_backend '${aiBackend}'; expected one of ${JSON.stringify(
        Object.keys(AI_BACKENDS)
      )}`,
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      json(res, 413, { detail: "Payload too large", maxBytes: MAX_BODY_BYTES });
      return;
    }
    throw err;
  }

  const topology =
    typeof body.topology === "string" && body.topology
      ? body.topology
      : DEFAULT_TOPOLOGY;
  const streamFn = module.TOPOLOGIES[topology];
  if (streamFn === undefined) {
    json(res, 404, {
      detail: `unknown topology '${topology}' for ai_backend '${aiBackend}'; expected one of ${JSON.stringify(
        Object.keys(module.TOPOLOGIES)
      )}`,
    });
    return;
  }

  const messages = normalizeMessages(body.messages);
  const userText = messages.length > 0 ? messages[messages.length - 1].content : "";
  const inputMessages: ChatMessage[] = [{ role: "user", content: userText }];

  // WHAT THIS RUN IS, recorded once, here — the only place that knows all
  // three axes plus the session. Same four fields the Python dispatches record,
  // with `runtime` fixed to this process rather than read from the request:
  // a node deployment of the same frameworks is what a person is comparing
  // against, and it cannot tell you so from anywhere else.
  const session =
    typeof body.sessionId === "string" ? body.sessionId : undefined;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Nginx and friends buffer text/event-stream by default, which turns a
    // token-by-token stream into one delivery at the end. Both Python runtimes
    // set this for the same reason.
    "X-Accel-Buffering": "no",
  });

  // WRAPPED, NOT RAW — see common/guardedStream.ts. The response head is
  // already flushed by the time the agent can fail, so an unguarded throw
  // closes the socket with no terminal frame and the proxy correctly, and
  // uselessly, calls that a mid-stream disconnect.
  const stream = withRunAxes(
    { runtime: RUNTIME, framework: aiBackend, topology, session },
    () => guardedStream(streamFn(inputMessages))
  );

  for await (const chunk of stream) {
    // Backpressure: if the socket's buffer is full, wait for it to drain rather
    // than queueing the whole run in memory.
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  }
  res.end();
}

function handleTools(aiBackend: string, url: URL, res: ServerResponse): void {
  const module = AI_BACKENDS[aiBackend];
  if (module === undefined) {
    json(res, 404, { detail: `unknown ai_backend '${aiBackend}'` });
    return;
  }
  const topology = url.searchParams.get("topology") ?? DEFAULT_TOPOLOGY;
  // No builtin-tool expansion: that branch exists in main.py only for the
  // deepagents rung, whose middleware injects tools that are not in the list we
  // pass. This runtime has no such rung, and main.py keys that branch on a
  // declared capability rather than probing, precisely so a runtime without it
  // reports only what it actually wired.
  const mcpEnv = (process.env.MCP_SERVERS ?? "").trim();
  const mcps = mcpEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  json(res, 200, {
    ai_backend: aiBackend,
    topology,
    tools: describeTools(),
    mcps,
  });
}

/** The shared tools, in main.py's `describe()` shape. */
function describeTools(): Array<{
  name: string;
  description: string;
  source: string;
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    // FIRST LINE ONLY, like main.py's `describe()`. Tool docstrings carry usage
    // notes below the summary and the UI renders this in a chip.
    description: (t.description ?? "").split("\n")[0],
    source: "custom",
  }));
}

export function createApp() {
  return createServer((req, res) => {
    void (async () => {
      cors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      try {
        if (req.method === "GET" && path === "/health") {
          json(res, 200, {
            status: "ok",
            ai_backends: Object.keys(AI_BACKENDS),
            topologies: topologiesByBackend(),
            // Presence only, never the key.
            llm: llmStatus(),
            observability: observabilityStatus(),
            // NOT IN THE PYTHON PAYLOAD, and additive rather than a rename:
            // a reader looking at three /health responses should not have to
            // infer which process answered from the shape of the rest.
            runtime: RUNTIME,
          });
          return;
        }

        const toolsMatch = /^\/api\/tools\/([^/]+)$/.exec(path);
        if (req.method === "GET" && toolsMatch) {
          handleTools(decodeURIComponent(toolsMatch[1]), url, res);
          return;
        }

        const streamMatch = /^\/api\/chat\/stream\/([^/]+)$/.exec(path);
        if (req.method === "POST" && streamMatch) {
          await handleChatStream(decodeURIComponent(streamMatch[1]), req, res);
          return;
        }

        if (req.method === "POST" && path === "/api/chat/stream") {
          await handleChatStream(LEGACY_AI_BACKEND, req, res);
          return;
        }

        json(res, 404, { detail: `no route for ${req.method} ${path}` });
      } catch (err) {
        // The head may already be flushed on the streaming path, in which case
        // guardedStream has already said what happened and there is nothing
        // left to write. Only a pre-head failure can still become a response.
        if (!res.headersSent) {
          json(res, 500, {
            detail: err instanceof Error ? err.message : "internal error",
          });
        } else {
          res.end();
        }
      }
    })();
  });
}
