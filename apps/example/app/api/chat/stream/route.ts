/**
 * Chat stream route for apps/example.
 *
 * Routing model:
 *   The matrix is (pythonBackend × aiBackend) where:
 *     pythonBackend ∈ {django, fastapi}  — the web framework hosting the agent
 *     aiBackend     — a conversation-shaped RUNG ID, from the manifest, not a list here
 *
 *   Adapter is implied by aiBackend (not user-selectable) and resolved through
 *   @/lib/rungs/adapters, so the set of cells is whatever rungs.json declares and eject
 *   retained. Naming the rungs in this comment is how it would go stale; the registry is
 *   the answer to "which backends does this build serve".
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
import { createSseProxyHandler } from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";
import { validateApiKey } from "@/lib/api-key-store";
import { POST as mockPOST } from "./route.mock";
import {
  adapterIds,
  resolveAdapter,
  defaultRungId,
} from "@/lib/rungs/adapters";

export const dynamic = "force-dynamic";

/**
 * The adapter table used to live here as a literal over three named imports. It could not
 * survive eject: those names are exactly what gets pruned out of `@deepagents-nextjs/server`
 * when a rung is dropped, so a fork failed to compile. You cannot conditionally import.
 *
 * @/lib/rungs/adapters is a barrel of rung-OWNED modules; eject deletes the module and prunes
 * the re-export, so the registry shrinks to whatever the fork retained without anything here
 * knowing which rungs exist. `AiBackend` is a plain string for the same reason — a union
 * literal is a second list of rung names that goes stale silently.
 */
type AiBackend = string;
// TODO(matrix): extend with "flask" (or "quart" for async-native) to grow the
// matrix to 3×3. Steps:
//   1. apps/flask-backend/ — copy apps/fastapi-backend/, swap main.py for an
//      `app.py` using Flask 2.0+. Bridge our async generators to Flask's sync
//      streaming with `asgiref.sync.async_to_sync`. Quart skips this step.
//   2. Pick a port (8003), update docker-compose.yml, add FLASK_URL to env.
//   3. Add "flask" to this Runtime union, extend resolveBackendBase()
//      with a third arm reading process.env.FLASK_URL.
//   4. Add the button in apps/example/app/page.tsx's Runtime selector
//      and update /api/config to advertise availability.
// Reference: ARCHITECTURE.md (todo) — for now, the existing django/fastapi
// modules under apps/{django,fastapi}-backend/ai_backends/ are the template.
/*
 * #360 — THREE RUNTIMES, AND A SECOND COPY OF THIS AXIS.
 *
 * apps/open-swe has its own `RUNTIMES`, its own env-var map and its own
 * trailing-slash rule, and this file has always had a parallel set. That
 * duplication is not cosmetic: the two copies had DIFFERENT DEFAULTS — open-swe
 * coerced junk to fastapi, this route coerced it to django — so the same
 * malformed request was answered by different planes depending on which surface
 * sent it, and neither surface said so.
 *
 * Extracting one shared module is the right end state and is deliberately NOT
 * done here: it crosses an app boundary and has a severability question of its
 * own (which package owns it, and does an ejected fork still need it). Filed
 * rather than smuggled in. What IS fixed here is the divergence in BEHAVIOUR —
 * both copies now refuse rather than coerce, and neither has a silent default.
 */
const RUNTIMES = ["django", "fastapi", "node"] as const;
type Runtime = (typeof RUNTIMES)[number];

const URL_ENV: Record<Runtime, string> = {
  django: "DJANGO_URL",
  fastapi: "FASTAPI_URL",
  node: "NODE_URL",
};

const TOKEN_ENV: Record<Runtime, string> = {
  django: "DJANGO_AUTH_TOKEN",
  fastapi: "FASTAPI_AUTH_TOKEN",
  node: "NODE_AUTH_TOKEN",
};

/** Django requires the trailing slash; FastAPI and Node 404 on it. */
const TRAILING_SLASH: Record<Runtime, string> = {
  django: "/",
  fastapi: "",
  node: "",
};

function parseRuntime(
  value: unknown
):
  | { ok: true; runtime: Runtime }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unknown"; received: string } {
  if (value == null || value === "") return { ok: false, reason: "missing" };
  if ((RUNTIMES as readonly string[]).includes(value as string)) {
    return { ok: true, runtime: value as Runtime };
  }
  const received = String(value);
  return {
    ok: false,
    reason: "unknown",
    received: received.length > 64 ? `${received.slice(0, 64)}…` : received,
  };
}

function resolveBackendBase(name: Runtime): {
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
  // Records, not ternaries: with two runtimes `fastapi ? A : B` is a choice;
  // with three it is "everything that is not fastapi", and node would have
  // silently received django's URL and django's trailing slash.
  const specific = process.env[URL_ENV[name]];
  const fallback = process.env.BACKEND_URL;
  if (specific) {
    return {
      url: specific,
      token: process.env[TOKEN_ENV[name]],
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
  pythonBackend: Runtime,
  baseUrl: string,
  aiBackend: AiBackend
): string {
  const root = trimTrailingSlash(baseUrl);
  return `${root}/${aiBackend}${TRAILING_SLASH[pythonBackend]}`;
}

// Body-size cap for the playground route, mirroring the transport core's
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
  /*
   * REFUSES, AND ACCEPTS THE OLD KEY FOR ONE TRANSITION (#360).
   *
   * This was `=== "fastapi" ? "fastapi" : "django"` — every unrecognised value
   * AND an absent one became django, while open-swe's copy made them fastapi.
   * So `pythonBackend: "node"` was answered by a Python plane, and which one
   * depended on where you sent it.
   *
   * `runtime` is read first; `pythonBackend` and `backend` follow so a client
   * mid-deploy is not broken by the rename. Removing them is its own commit.
   */
  const parsedRuntime = parseRuntime(
    body.runtime ?? body.pythonBackend ?? body.backend
  );
  if (!parsedRuntime.ok) {
    return Response.json(
      {
        error:
          parsedRuntime.reason === "missing"
            ? "no runtime was named"
            : `unknown runtime: ${parsedRuntime.received}`,
        reason: parsedRuntime.reason,
        runtimes: RUNTIMES,
      },
      { status: 400 }
    );
  }
  const pythonBackend: Runtime = parsedRuntime.runtime;

  const aiBackendRaw = (body.aiBackend ?? body.adapterName) as string;
  // Falls back to whatever this build defaults to, not to a hardcoded "deepagents": in a
  // rung-1 fork that name resolves to nothing, so an unrecognised request would have picked
  // a rung the fork does not contain.
  const aiBackend: AiBackend =
    aiBackendRaw && adapterIds().includes(aiBackendRaw)
      ? aiBackendRaw
      : defaultRungId();

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
  const adapter = resolveAdapter(aiBackend);

  // `sessionId` IS NOT STRIPPED (#171). It was, as `_sid`, so the backend
  // received no session identity — and would have received a useless one if it
  // had, because this surface sent the constant "example-session".
  //
  // The Python side has been ready the whole time: langfuse_trace_metadata()
  // turns it into `langfuse_session_id` and groups a conversation's turns.
  // open-swe forwards it since #171; this app kept the defect, which is why the
  // same backend traced one app's turns as a conversation and the other's as
  // unrelated singletons.
  //
  // The fields below are stripped because they select the ADAPTER — answered by
  // the time the request leaves this route.
  const {
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

  const handler = createSseProxyHandler({
    backendUrl,
    adapter,
    ...(authToken ? { getToken: () => authToken } : {}),
  });
  return handler(newReq);
}
