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
 * THE 404 BODY IS `{"detail": ..., "runtime": "node"}`. The `detail` key matches FastAPI and
 * not Django — Django's view answers `{"error": ...}` for the same condition, and #329's
 * routing suite uses precisely that difference to prove which process answered a request.
 * Node took FastAPI's key because those two are the ones a reader compares and an arbitrary
 * third spelling would be a difference that means nothing.
 *
 * `runtime` IS THE PART THAT IDENTIFIES THIS PROCESS, added when a suite finally needed to
 * tell node from fastapi (#360). This paragraph used to end by saying that when that day
 * came, node should be given "something that IS about node … rather than an error-shape
 * accident" — so it was, rather than a third envelope key.
 *
 * The distinction is not stylistic. The routing suite's own header admits its django/fastapi
 * discriminator is an accident it cannot defend: nothing stops someone harmonising the two
 * envelopes, and on that day every assertion keeps passing while distinguishing nothing. A
 * third spelling would be a fourth thing to harmonise. A field whose VALUE is the runtime
 * cannot be harmonised away without changing what it says.
 *
 * NO FRAMEWORK. node:http and hand-written routing, because the whole surface
 * is four routes and a dependency here would be one more thing a forker has to
 * understand before they can read the dispatch.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

/**
 * The dev CORS allowlist. A DEFAULT, not the policy (#349).
 *
 * Declared once in scripts/fixtures/cors-origins.json; check-cors-parity.mjs
 * asserts all three backends still agree with it. Before that file each backend
 * hardcoded its own copy and the copies had already drifted — django omitted
 * http://localhost:3000 that this one and fastapi allowed. Nobody decided that.
 */
const DEV_DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://frontend:3001",
  "http://frontend:3002",
] as const;

/**
 * The allowlist, from the environment, defaulting to the dev origins.
 *
 * FOLLOWS THE `DJANGO_SECRET_KEY` PRECEDENT: a dev default, an environment
 * override, and a name that says which it is. CORS was the one value in this
 * repo with a dev default and NO override — and it is the one that silently
 * keeps working in production when it is wrong.
 *
 * EMPTY MEANS EMPTY. `CORS_ALLOWED_ORIGINS=""` allows nothing; only an UNSET
 * variable falls back to the dev list. An operator who deliberately empties an
 * allowlist and silently gets a developer's laptop back has no way to say what
 * they meant.
 *
 * READ PER APP, NOT AT MODULE LOAD. It was a module constant, which is one
 * import-order away from being unconfigurable and — more immediately — makes
 * the env-driven behaviour untestable, since the module is cached before any
 * test can set the variable.
 */
export function corsAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined) return new Set(DEV_DEFAULT_ORIGINS);
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
}

const MAX_BODY_BYTES = 1_048_576;

/**
 * CORS — an echo, but only of an origin already on a closed list.
 *
 * `Access-Control-Allow-Origin` takes ONE origin or `*`, never a list, so any
 * server that serves several origins must echo the request's. What makes that
 * safe or not is whether the echo is guarded, and here it is: membership of
 * ALLOWED_ORIGINS is checked first, and that set is a module constant. This is
 * the same thing FastAPI's `CORSMiddleware(allow_origins=[...])` does in
 * apps/fastapi-backend/main.py, with the same five origins.
 *
 * Semgrep flags the echo (javascript.express.security.cors-misconfiguration) —
 * it cannot see the Set membership guard. Triaged by name in
 * .github/workflows/semgrep_triage.py rather than silenced here, and the
 * assessment found a REAL defect beside the false one: `Vary: Origin` was
 * missing. See below.
 *
 * REACHABILITY, because "it is a dev server" is the reasoning that survives to
 * production. This backend is reached by the same Next.js proxy that reaches
 * django and fastapi, so whatever it allows is allowed from wherever that proxy
 * runs. Two things bound that, and neither is "nobody will deploy it":
 *
 *   - THE PRODUCTION PATH DOES NOT USE CORS AT ALL. The proxy calls this
 *     backend with a server-side fetch() from packages/server/src/handler.ts —
 *     no Origin header, no preflight. What is configured here governs only
 *     DIRECT browser access, which is the development affordance.
 *   - Deployed anyway, the set is still five literal origins, and the attack
 *     CORS actually prevents — a page on another origin using a victim's
 *     browser to READ a response from a host only that browser can reach — is
 *     blocked for everything outside it.
 *
 * THE RESIDUAL, so nobody has to rediscover it: the list contains
 * localhost:3000-3002, so deployed, a page on a victim's OWN machine at those
 * ports could read this backend. Narrow, and true of all three runtimes rather
 * than introduced here — diverging in the scaffold would give three
 * interchangeable runtimes three different CORS policies. Filed as #349.
 *
 * NO `Access-Control-Allow-Credentials`, deliberately. These endpoints are
 * unauthenticated and the browser never needs to send cookies to them, so the
 * header is absent — which also means a mistaken origin could not carry
 * credentials even if the guard above were wrong.
 *
 * server.test.ts asserts all three properties, so the triage entry's premise is
 * a checked fact rather than a claim.
 */
function cors(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>
): void {
  const origin = req.headers.origin;

  // `Vary: Origin` IS SET UNCONDITIONALLY, and that is not a detail.
  //
  // The response body is identical for every origin but the CORS headers are
  // NOT, so a shared cache that keys only on the URL can hand a response
  // carrying `Access-Control-Allow-Origin: http://localhost:3000` to a request
  // from :3001 — or hand the no-CORS-headers version to an allowed origin and
  // break it intermittently. FastAPI's CORSMiddleware sets this for exactly
  // this reason and this port had omitted it, so "mirrors the Python" was not
  // yet true. Found by taking the Semgrep finding seriously rather than
  // excepting it on sight.
  //
  // UNCONDITIONAL rather than inside the branch: the *absence* of CORS headers
  // is origin-dependent too, so a response to a disallowed origin is just as
  // unsafe to reuse as one to an allowed origin.
  res.setHeader("Vary", "Origin");

  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
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

/**
 * An error body that NAMES THE PROCESS THAT WROTE IT (#360).
 *
 * The header above predicted this and prescribed its shape: if a suite ever needs to tell
 * node from fastapi, give it "something that IS about node … rather than an error-shape
 * accident". So `detail` is unchanged — a client parsing FastAPI's shape still works, which
 * is the interchangeability the runtime selector depends on — and `runtime` is added beside
 * it.
 *
 * WHY NOT A THIRD ENVELOPE KEY. Because the routing suite's own header already says the
 * django/fastapi discriminator is an accident it cannot defend: "nothing stops someone
 * harmonising the two error envelopes — and on the day they do, every assertion would keep
 * passing while distinguishing nothing." A third arbitrary spelling would be a fourth thing
 * to harmonise. A field whose VALUE is the runtime cannot be harmonised away without
 * changing what it says, and it is checkable rather than inferable.
 *
 * EVERY error body, not only the 404 the probe happens to hit. A discriminator present on one
 * error path and absent on the others tells you which process answered exactly when the
 * request failed the way you expected, which is not when you need it.
 */
function errorBody(detail: string, extra: Record<string, unknown> = {}) {
  return { detail, runtime: RUNTIME, ...extra };
}

async function readBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
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
    .filter(
      (m): m is Record<string, unknown> => Boolean(m) && typeof m === "object"
    )
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
    json(
      res,
      404,
      errorBody(
        `unknown ai_backend '${aiBackend}'; expected one of ${JSON.stringify(
          Object.keys(AI_BACKENDS)
        )}`
      )
    );
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      json(
        res,
        413,
        errorBody("Payload too large", { maxBytes: MAX_BODY_BYTES })
      );
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
    json(
      res,
      404,
      errorBody(
        `unknown topology '${topology}' for ai_backend '${aiBackend}'; expected one of ${JSON.stringify(
          Object.keys(module.TOPOLOGIES)
        )}`
      )
    );
    return;
  }

  const messages = normalizeMessages(body.messages);
  const userText =
    messages.length > 0 ? messages[messages.length - 1].content : "";
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
    json(res, 404, errorBody(`unknown ai_backend '${aiBackend}'`));
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
  /*
   * Resolved ONCE per app, not per request and not at module load.
   *
   * Per module load is what it was, and it made the environment unreadable to a
   * test — the module is cached before any case can set the variable. Per
   * request would re-parse on every call and, worse, let the allowlist change
   * under a running server, which is a policy that cannot be reasoned about.
   */
  const allowedOrigins = corsAllowedOrigins();
  return createServer((req, res) => {
    void (async () => {
      cors(req, res, allowedOrigins);
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

        json(res, 404, errorBody(`no route for ${req.method} ${path}`));
      } catch (err) {
        // The head may already be flushed on the streaming path, in which case
        // guardedStream has already said what happened and there is nothing
        // left to write. Only a pre-head failure can still become a response.
        if (!res.headersSent) {
          json(
            res,
            500,
            errorBody(err instanceof Error ? err.message : "internal error")
          );
        } else {
          res.end();
        }
      }
    })();
  });
}
