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
import { createSseProxyHandler } from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";
import {
  resolveChatAdapter,
  chatTransforms,
  chatAdapterIds,
  defaultChatId,
} from "../../../../lib/rungs/chat";
import {
  asPythonBackend,
  buildBackendUrl,
  envVarFor,
  resolveBackendBase,
} from "../../../../lib/frameworks";

export const dynamic = "force-dynamic";

/**
 * The framework ids this build serves come from the registry, not from a table here.
 *
 * A `const ADAPTER_FOR_AI = { deepagents: …, langgraph: …, langchain: … }` table needs
 * named imports that `pnpm eject` prunes out of @deepagents-nextjs/server, so a rung-1 fork
 * failed to compile on four dangling symbols. `AiBackend` is `string` for the same reason
 * lib/frameworks.ts uses `string`: the set is the manifest's to define, and a union here
 * would be a second source of truth that goes stale the moment a fork ejects.
 */
type AiBackend = string;

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
    aiRaw && chatAdapterIds().includes(aiRaw) ? aiRaw : defaultChatId()
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
  const adapter = resolveChatAdapter(aiBackend);

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
  // createSseProxyHandler, not createDeepAgentsHandler. Two independent reasons, and the
  // first one is TRUE ON THIS BRANCH AND FALSE ON MAIN — which is why it is spelled out
  // rather than asserted, because a reader who checks against main will find the opposite.
  //
  // 1. SEVERABILITY, created by this branch's own manifest split. createDeepAgentsHandler
  //    lives in packages/server/src/deepagents-handler.ts, which is rung-3-owned. On main
  //    that does not matter: rung 4 owns `apps/open-swe/**` wholesale, so this route is
  //    deleted by the same eject that deletes the wrapper and they cannot come apart. Here
  //    rung 4's owns has narrowed to specific paths (app/runs/**, app/api/open-swe/**), so
  //    this route now OUTLIVES the rung that owns the wrapper.
  //
  //    Verified by counterfactual rather than by reading: putting the wrapper back and
  //    ejecting to langgraph on this branch gives
  //      FAIL: ejecting to "langgraph" would leave 1 dangling reference(s):
  //        apps/open-swe/app/api/chat/stream/route.ts imports { createDeepAgentsHandler }
  //        from "@deepagents-nextjs/server", which no longer exports it
  //    The same counterfactual on main ejects clean, because there the route is gone too.
  //
  // 2. THE WRAPPER ADDS NOTHING THIS ROUTE USES, which holds on any tree and would justify
  //    the call on its own. Its entire behaviour is
  //    `adapter: options.adapter ?? deepagentsAdapter` followed by a delegation to
  //    createSseProxyHandler. This route passes a per-request adapter —
  //    `resolveChatAdapter(aiBackend)` above — so the default the wrapper exists to supply
  //    is never consulted. packages/server's own approval-drain-on-close.test.ts made this
  //    same migration for #17b, documenting the adapters as behaviour-identical.
  //
  // It costs no drain guarantee: the #25b drain-on-close lives IN createSseProxyHandler,
  // at its upstream-done branch. The wrapper only delegates to it.
  //
  // Transforms come from whatever rungs survived — see lib/rungs/chat.
  const handler = createSseProxyHandler({
    backendUrl,
    adapter,
    transforms: chatTransforms(),
  });
  return handler(newReq);
}
