import { NextRequest, NextResponse } from "next/server";
import { lookupStream } from "./stream-registry";

export function isStreamReconnectEnabled(): boolean {
  return process.env.ENABLE_STREAM_RECONNECT === "true";
}

export function createDeepAgentsResumeHandler() {
  return async function GET(
    _: NextRequest,
    { params }: { params: Promise<{ resumeId: string }> }
  ): Promise<NextResponse> {
    if (!isStreamReconnectEnabled()) {
      return new NextResponse(
        "stream reconnection disabled (set ENABLE_STREAM_RECONNECT=true)",
        { status: 503 }
      );
    }

    const { resumeId } = await params;
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
