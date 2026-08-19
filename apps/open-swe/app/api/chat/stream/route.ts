/**
 * Live-chat stream proxy for the Lang-Next.js app.
 *
 * Routes a chat request to one of the three AI framework backends, selecting the
 * matching server adapter and forwarding to the Python host (FastAPI) that runs
 * the agent:
 *   deepagents → deepagentsAdapter   langgraph → langGraphAdapter
 *   langchain  → langchainAdapter
 *
 * Backend URL: `${FASTAPI_URL}/${aiBackend}` (FASTAPI_URL is e.g.
 * "http://localhost:8030/api/chat/stream"). DeepAgents/LangGraph/LangChain
 * compatibility is the point of this route — same UI, three wire formats.
 */
import {
  createDeepAgentsHandler,
  createDeepAgentsEnrichTransform,
  deepagentsAdapter,
  langGraphAdapter,
  langchainAdapter,
  type SseTransform,
} from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const ADAPTER_FOR_AI = {
  deepagents: deepagentsAdapter,
  langgraph: langGraphAdapter,
  langchain: langchainAdapter,
} as const;

type AiBackend = keyof typeof ADAPTER_FOR_AI;

const MAX_BODY_BYTES = 1_048_576;

export async function POST(request: NextRequest): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return Response.json(
      { error: "Payload too large", maxBytes: MAX_BODY_BYTES },
      { status: 413 }
    );
  }

  const baseUrl = process.env.FASTAPI_URL;
  if (!baseUrl) {
    return Response.json(
      { error: "FASTAPI_URL is not configured" },
      { status: 502 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const aiRaw = (body.aiBackend ?? body.adapterName) as string;
  const aiBackend: AiBackend = (
    aiRaw && aiRaw in ADAPTER_FOR_AI ? aiRaw : "deepagents"
  ) as AiBackend;

  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const backendUrl = `${root}/${aiBackend}`;
  const adapter = ADAPTER_FOR_AI[aiBackend];

  // Strip UI-only fields, then normalize AI SDK v6 parts → {role, content}.
  // NOTE: `topology` is forwarded (the backend reads body.topology to pick
  // ReAct vs plan-execute) — only adapter-selection fields are stripped.
  const {
    sessionId: _sid,
    pythonBackend: _pb,
    backend: _bb,
    aiBackend: _ai,
    adapterName: _an,
    ...forwardBody
  } = body;

  if (Array.isArray(forwardBody.messages)) {
    forwardBody.messages = (
      forwardBody.messages as Array<Record<string, unknown>>
    ).map((msg) => {
      if (Array.isArray(msg.parts) && !msg.content) {
        const text = (msg.parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("");
        return { role: msg.role, content: text };
      }
      return msg;
    });
  }

  const newReq = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(forwardBody),
  });

  // Append the enrichment transform: maps deepagents' built-in tool calls
  // (write_todos / write_file / edit_file / read_file / task) into data-* parts
  // so the chat renders the workspace (Tasks / Files / Sub-agents) cards.
  const handler = createDeepAgentsHandler({
    backendUrl,
    adapter,
    transforms: [createDeepAgentsEnrichTransform() as unknown as SseTransform],
  });
  return handler(newReq);
}
