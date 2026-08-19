/**
 * Chat stream route for apps/example.
 *
 * Routing model:
 *   The 6-cell matrix is (pythonBackend × aiBackend) where:
 *     pythonBackend ∈ {django, fastapi}        — the web framework hosting the agent
 *     aiBackend     ∈ {deepagents, langgraph, langchain} — the agent framework + wire format
 *
 *   Adapter is implied by aiBackend (not user-selectable):
 *     deepagents → deepagentsAdapter (AI SDK v6 native — minimal transform)
 *     langgraph  → langGraphAdapter  (raw astream_events v2 → AI SDK v6)
 *     langchain  → langchainAdapter  (LangChain native SSE → AI SDK v6)
 *
 * Backend URL construction:
 *   ${baseUrl}/${aiBackend}    for FastAPI
 *   ${baseUrl}/${aiBackend}/   for Django (Django requires trailing slashes)
 *   where baseUrl is e.g. "http://localhost:8001/api/chat/stream"
 *
 * Environment variables (see .env.example):
 *   DJANGO_URL  / DJANGO_AUTH_TOKEN   — Django base URL
 *   FASTAPI_URL / FASTAPI_AUTH_TOKEN  — FastAPI base URL
 */
import {
  createDeepAgentsHandler,
  deepagentsAdapter,
  langGraphAdapter,
  langchainAdapter,
} from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";
import { validateApiKey } from "@/lib/api-key-store";
import { POST as mockPOST } from "./route.mock";

export const dynamic = "force-dynamic";

const ADAPTER_FOR_AI = {
  deepagents: deepagentsAdapter,
  langgraph: langGraphAdapter,
  langchain: langchainAdapter,
} as const;

type AiBackend = keyof typeof ADAPTER_FOR_AI;
// TODO(matrix): extend with "flask" (or "quart" for async-native) to grow the
// matrix to 3×3. Steps:
//   1. apps/flask-backend/ — copy apps/fastapi-backend/, swap main.py for an
//      `app.py` using Flask 2.0+. Bridge our async generators to Flask's sync
//      streaming with `asgiref.sync.async_to_sync`. Quart skips this step.
//   2. Pick a port (8003), update docker-compose.yml, add FLASK_URL to env.
//   3. Add "flask" to this PythonBackend union, extend resolveBackendBase()
//      with a third arm reading process.env.FLASK_URL.
//   4. Add the button in apps/example/app/page.tsx's PythonBackend selector
//      and update /api/config to advertise availability.
// Reference: ARCHITECTURE.md (todo) — for now, the existing django/fastapi
// modules under apps/{django,fastapi}-backend/ai_backends/ are the template.
type PythonBackend = "django" | "fastapi";

function resolveBackendBase(name: PythonBackend): {
  url: string | undefined;
  token: string | undefined;
  isLegacy: boolean;
} {
  // Single-backend fallback for legacy deployments and CI: if FASTAPI_URL or
  // DJANGO_URL isn't set, fall through to BACKEND_URL. The original example
  // app used a single BACKEND_URL env var; e2e.yml still sets that.
  //
  // When falling back, we treat BACKEND_URL as the COMPLETE endpoint URL
  // (legacy semantics — used as-is, no aiBackend path append). The matrix
  // semantics only apply when FASTAPI_URL/DJANGO_URL are explicitly set.
  const specific =
    name === "fastapi" ? process.env.FASTAPI_URL : process.env.DJANGO_URL;
  const fallback = process.env.BACKEND_URL;
  if (specific) {
    return {
      url: specific,
      token:
        name === "fastapi"
          ? process.env.FASTAPI_AUTH_TOKEN
          : process.env.DJANGO_AUTH_TOKEN,
      isLegacy: false,
    };
  }
  return {
    url: fallback,
    token: undefined,
    isLegacy: !!fallback,
  };
}

/** Strip a single trailing slash so we can safely re-append our own. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Django requires trailing slashes; FastAPI does not. */
function buildBackendUrl(
  pythonBackend: PythonBackend,
  baseUrl: string,
  aiBackend: AiBackend
): string {
  const root = trimTrailingSlash(baseUrl);
  const trailing = pythonBackend === "django" ? "/" : "";
  return `${root}/${aiBackend}${trailing}`;
}

// Body-size cap for the playground route, mirroring createDeepAgentsHandler's
// default (1 MiB). The handler enforces the same limit internally, but this
// route can resolve to the in-process mock (when no backend URL is configured,
// e.g. the mocked E2E job) — a path that never constructs the handler. Guarding
// here makes the reference app DoS-safe at its public boundary regardless of
// which downstream path a request takes. 0 disables.
const MAX_BODY_BYTES = 1_048_576;

function payloadTooLarge(observed?: number): Response {
  return new Response(
    JSON.stringify({
      error: "Payload too large",
      maxBytes: MAX_BODY_BYTES,
      ...(observed !== undefined ? { actual: observed } : {}),
    }),
    { status: 413, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  // Reject oversized bodies before reading them. Honest clients send
  // Content-Length; reject those up front without buffering.
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
  }

  const authHeader = request.headers.get("authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  if (match) {
    const meta = validateApiKey(match[1]);
    if (!meta) {
      return new Response(
        JSON.stringify({ error: "invalid or revoked API key" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  // Resolve the (pythonBackend, aiBackend) cell. Both fields are required from
  // the example UI; default to a reasonable cell if either is missing.
  const pythonBackend: PythonBackend =
    body.pythonBackend === "fastapi" || body.backend === "fastapi"
      ? "fastapi"
      : "django";

  const aiBackendRaw = (body.aiBackend ?? body.adapterName) as string;
  const aiBackend: AiBackend = (
    aiBackendRaw && aiBackendRaw in ADAPTER_FOR_AI ? aiBackendRaw : "deepagents"
  ) as AiBackend;

  const {
    url: baseUrl,
    token: authToken,
    isLegacy,
  } = resolveBackendBase(pythonBackend);

  if (!baseUrl) {
    // No backend URL configured — fall through to the in-process mock route.
    // Lets `pnpm dev` work zero-config and lets the e2e-mocked CI job run
    // without booting a real backend. Production deployments must set
    // FASTAPI_URL, DJANGO_URL, or BACKEND_URL.
    return mockPOST();
  }

  // Legacy mode (BACKEND_URL fallback): treat baseUrl as the complete endpoint
  // URL — don't append /{aiBackend}. This preserves the original single-backend
  // semantics for E2E tests and deployments that haven't migrated to the matrix.
  const backendUrl = isLegacy
    ? baseUrl
    : buildBackendUrl(pythonBackend, baseUrl, aiBackend);
  const adapter = ADAPTER_FOR_AI[aiBackend];

  // Strip playground-specific fields before forwarding to the backend.
  const {
    sessionId: _sid,
    pythonBackend: _pb,
    backend: _bb,
    aiBackend: _ai,
    adapterName: _an,
    ...forwardBody
  } = body;

  // AI SDK v6 sends messages in parts format: { role, parts: [{ type, text }] }
  // Backends expect simple format: { role, content }. Convert here.
  if (Array.isArray(forwardBody.messages)) {
    forwardBody.messages = (
      forwardBody.messages as Array<Record<string, unknown>>
    ).map((msg) => {
      if (Array.isArray(msg.parts) && !msg.content) {
        const textParts = (msg.parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text);
        return { role: msg.role, content: textParts.join("") };
      }
      return msg;
    });
  }

  const newReq = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(forwardBody),
  });

  const handler = createDeepAgentsHandler({
    backendUrl,
    adapter,
    ...(authToken ? { getToken: () => authToken } : {}),
  });
  return handler(newReq);
}
