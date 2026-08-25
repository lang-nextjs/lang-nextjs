/**
 * Live-chat stream proxy for the Lang-Next.js app.
 *
 * Routes a chat request to one of the three AI framework backends, selecting the
 * matching server adapter and forwarding to the Python host (FastAPI) that runs
 * the agent:
 *   deepagents → deepagentsAdapter   langgraph → langGraphAdapter
 *   langchain  → langchainAdapter
 *
 * Backend URL: `${FASTAPI_URL|DJANGO_URL}/${aiBackend}[/]`, chosen per request
 * from `body.pythonBackend`. Django's URLconf requires the trailing slash;
 * FastAPI does not want one. DeepAgents/LangGraph/LangChain compatibility is
 * the point of this route — same UI, three wire formats, two runtimes.
 */
import {
  createDeepAgentsHandler,
  createApprovalGatingTransform,
  createDeepAgentsEnrichTransform,
  deepagentsAdapter,
  langGraphAdapter,
  langchainAdapter,
  type SseTransform,
} from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";
import { approvalPolicy } from "../../../../lib/approval-policy";
import {
  asPythonBackend,
  buildBackendUrl,
  envVarFor,
  resolveBackendBase,
} from "../../../../lib/frameworks";

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

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const aiRaw = (body.aiBackend ?? body.adapterName) as string;
  const aiBackend: AiBackend = (
    aiRaw && aiRaw in ADAPTER_FOR_AI ? aiRaw : "deepagents"
  ) as AiBackend;

  // The runtime is a per-request choice, not a deployment constant. This field
  // used to be destructured into `_pb` and thrown away while the route always
  // forwarded to FASTAPI_URL — so a runtime selector in the UI would have been
  // a control that changed nothing.
  const pythonBackend = asPythonBackend(body.pythonBackend ?? body.backend);
  const { url: baseUrl, token } = resolveBackendBase(pythonBackend);
  if (!baseUrl) {
    // Name the variable for the runtime that was actually asked for. Falling
    // back to the other runtime's URL would make the selector lie: you would
    // pick django and be served by fastapi.
    return Response.json(
      {
        error: `${envVarFor(pythonBackend)} is not configured`,
        pythonBackend,
      },
      { status: 502 }
    );
  }

  const backendUrl = buildBackendUrl(pythonBackend, baseUrl, aiBackend);
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

    /*
     * WORKSPACE SYSTEM PROMPT — injected as a leading system message rather
     * than forwarded as a field.
     *
     * The obvious route would be passing `system_prompt` through to the Python
     * backends, but their agents are lazily-built SINGLETONS: `create_deep_agent
     * (system_prompt=…)` bakes the prompt at graph construction, so a per-request
     * value would mean rebuilding the graph on every message. Prepending a
     * system-role message costs nothing and every one of the three frameworks
     * already accepts one, because it is just a message.
     *
     * Stripped from the body afterwards so it is not ALSO forwarded as an
     * unknown field — the spread below would otherwise send it twice, in two
     * shapes, and a backend that grew a `systemPrompt` reader later would
     * silently start disagreeing with this one.
     */
    const wsPrompt =
      typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";
    if (wsPrompt) {
      forwardBody.messages = [
        { role: "system", content: wsPrompt },
        ...(forwardBody.messages as Array<Record<string, unknown>>),
      ];
    }
  }
  delete (forwardBody as Record<string, unknown>).systemPrompt;

  // Forward the selected runtime's auth token, if it has one. Each runtime
  // carries its own (DJANGO_AUTH_TOKEN / FASTAPI_AUTH_TOKEN), so this has to
  // follow the per-request choice too.
  const upstreamHeaders = new Headers(request.headers);
  if (token) upstreamHeaders.set("Authorization", `Bearer ${token}`);

  const newReq = new NextRequest(request.url, {
    method: request.method,
    headers: upstreamHeaders,
    body: JSON.stringify(forwardBody),
  });

  // Append the enrichment transform: maps deepagents' built-in tool calls
  // (write_todos / write_file / edit_file / read_file / task) into data-* parts
  // so the chat renders the workspace (Tasks / Files / Sub-agents) cards.
  /*
   * THE APPROVAL GATE (#160 gap 1).
   *
   * Ordered AFTER enrichment on purpose: enrichment maps deepagents' built-in
   * tool calls into data-* parts, and the gate needs to see the tool-input-start
   * frames that survive that. Putting the gate first would have it deciding on
   * frames the enricher is about to rewrite.
   *
   * The policy comes from lib/approval-policy.ts rather than living here or in
   * packages/server: which tools mutate is a fact about open-swe's tool
   * inventory, and a list inside the shared transform would be a second source
   * of truth inherited by every rung.
   *
   * createDeepAgentsHandler calls hasPending()/drainOnClose() at upstream close
   * (#39), so a decision that arrives after the backend has finished still
   * releases the buffered frames instead of dropping them silently. That is the
   * #25b guarantee this gate depends on.
   */
  const handler = createDeepAgentsHandler({
    backendUrl,
    adapter,
    transforms: [
      createDeepAgentsEnrichTransform() as unknown as SseTransform,
      createApprovalGatingTransform({
        getApprovalConfig: approvalPolicy,
      }) as unknown as SseTransform,
    ],
  });
  return handler(newReq);
}
