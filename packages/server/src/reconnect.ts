import { NextRequest, NextResponse } from "next/server";
import { lookupStream } from "./stream-registry";

export function isStreamReconnectEnabled(): boolean {
  return process.env.ENABLE_STREAM_RECONNECT === "true";
}

/**
 * The resume id comes from the QUERY STRING, because that is what the client
 * sends and what this package documents.
 *
 *   packages/react/src/hook.ts:170   builds `${resumeEndpoint}?resumeId=${id}`
 *   packages/react/src/hook.ts:63    documents "handler accepts ?resumeId=<id>"
 *   this handler, before now         read ONLY `params.resumeId`, a path segment
 *
 * So `useDeepAgentsChat` asked for `/api/chat/stream/resume?resumeId=X` while
 * the only shape this could answer was `/api/chat/stream/resume/X`. Every real
 * auto-GET 404'd. THE REFERENCE IMPLEMENTATION'S RECONNECT HAD NEVER MADE A
 * SUCCESSFUL REQUEST TO ITS OWN RESUME ROUTE — apps/example had the identical
 * mismatch since reconnect landed, and nothing noticed because every reconnect
 * spec STUBS this endpoint. The only thing that had ever talked to it was a mock.
 *
 * ── ONE PARAMETER, DELIBERATELY ────────────────────────────────────────────
 *
 * This handler takes the request and nothing else. Next passes a second
 * context argument and JavaScript discards it, and a function declaring FEWER
 * parameters is assignable to a type expecting more — so this satisfies Next's
 * route signature without naming it.
 *
 * That matters because the first attempt declared an OPTIONAL context, and
 * Next 15.5 rejected it on EVERY route, static or dynamic:
 *
 *     Type "{ params?: … } | undefined" is not a valid type for the function's
 *     second argument. Expected "RouteContext", got "undefined".
 *
 * It was objecting to the parameter being absent, not to what was inside it.
 * Declaring it optional in a library binds that library to a framework type it
 * does not depend on — and the next release can move that constraint again.
 * Declaring one parameter cannot conflict with a signature it never mentions.
 *
 * THE PATH FORM IS NOT READ, and does not need to be: the route may not be
 * mounted under a dynamic segment at all. resume-url-contract.test.ts fails any
 * app that tries, so `/resume/<id>` is unreachable by construction rather than
 * unsupported by omission.
 */
export function createDeepAgentsResumeHandler() {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    if (!isStreamReconnectEnabled()) {
      return new NextResponse(
        "stream reconnection disabled (set ENABLE_STREAM_RECONNECT=true)",
        { status: 503 }
      );
    }

    const resumeId = request.nextUrl.searchParams.get("resumeId");
    if (!resumeId) {
      // NOT 204. A request naming no stream is malformed, and 204 would be
      // indistinguishable from "that stream is finished" — so a client with a
      // broken URL would look exactly like one whose stream had simply ended.
      // That is how this bug hid.
      return new NextResponse("resume requires ?resumeId=", { status: 400 });
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
