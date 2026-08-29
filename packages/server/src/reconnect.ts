import { NextRequest, NextResponse } from "next/server";
import { lookupStream } from "./stream-registry";

export function isStreamReconnectEnabled(): boolean {
  return process.env.ENABLE_STREAM_RECONNECT === "true";
}

/**
 * Where the id lives in a resume request — and it is BOTH, because the client
 * and this handler have never agreed and the client is the one with users.
 *
 * THE MISMATCH, measured across three files rather than inferred:
 *
 *   packages/react/src/hook.ts:170   builds `${resumeEndpoint}?resumeId=${id}`
 *   packages/react/src/hook.ts:63    documents "handler accepts ?resumeId=<id>"
 *   this file, before now            read ONLY `params.resumeId`, a path segment
 *
 * So `useDeepAgentsChat` requested `/api/chat/stream/resume?resumeId=X` while the
 * only shape this handler could answer was `/api/chat/stream/resume/X`. Every
 * real auto-GET 404'd. THE REFERENCE IMPLEMENTATION'S RECONNECT HAS NEVER MADE A
 * SUCCESSFUL REQUEST TO ITS OWN RESUME ROUTE — apps/example mounts
 * `resume/[resumeId]/route.ts` and has had the identical mismatch since
 * reconnect landed.
 *
 * WHY NOTHING CAUGHT IT: every spec that exercises reconnect STUBS this
 * endpoint (`page.route("**\/api/chat/stream/resume**", 204)` — four sites in
 * e2e/shared/reconnect.spec.ts). The one page in the repo that enables
 * reconnect for real is a test harness, and its spec stubs it too. The only
 * thing that has ever talked to this route is a mock, so the disagreement was
 * invisible by construction rather than by oversight.
 *
 * READING BOTH is fixing the implementation to match its own documented
 * contract, not widening it: the query form is what the hook sends and what the
 * doc promises. The path form is kept because apps/example mounts it that way
 * and a fork may too — dropping it would trade one silent 404 for another.
 */
function resumeIdFrom(
  request: NextRequest,
  ctx?: { params?: Promise<{ resumeId?: string }> }
): Promise<string | undefined> {
  return Promise.resolve(ctx?.params)
    .then((p) => p?.resumeId)
    // Path first, query second: a route mounted at `[resumeId]` states the id
    // in its own URL, and a caller who supplied both meant the path.
    .then((fromPath) => fromPath ?? request.nextUrl.searchParams.get("resumeId") ?? undefined);
}

export function createDeepAgentsResumeHandler() {
  return async function GET(
    request: NextRequest,
    ctx?: { params?: Promise<{ resumeId?: string }> }
  ): Promise<NextResponse> {
    if (!isStreamReconnectEnabled()) {
      return new NextResponse(
        "stream reconnection disabled (set ENABLE_STREAM_RECONNECT=true)",
        { status: 503 }
      );
    }

    const resumeId = await resumeIdFrom(request, ctx);
    if (!resumeId) {
      // NOT 204. A request naming no stream is a malformed request, and 204
      // would be indistinguishable from "that stream is finished" — which is
      // how a client with a broken URL would look exactly like a client whose
      // stream had simply ended.
      return new NextResponse("resume requires a resumeId (path segment or ?resumeId=)", {
        status: 400,
      });
    }
    const record = lookupStream(resumeId);

    if (!record || record.done) {
      return new NextResponse(null, { status: 204 });
    }

    // Fallback: pipe stored ReadableStream directly.
    // (createResumableStreamContext is not available in ai@6.x at this version;
    //  registerStream stores the stream for replay when provided by the POST handler.)
    if (!record.stream) {
      // Stream registered but no ReadableStream stored — treat as completed
      return new NextResponse(null, { status: 204 });
    }

    return new NextResponse(record.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache",
      },
    });
  };
}
