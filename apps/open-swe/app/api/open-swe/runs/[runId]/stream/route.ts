import { NextRequest } from "next/server";
import { transformSseStream, openSweAdapter } from "@deepagents-nextjs/server";
import {
  circuitBreaker,
  CircuitOpenError,
} from "../../../../../../lib/langgraph-client";

export const dynamic = "force-dynamic";

const STREAM_TIMEOUT_MS = 30_000; // initial connect timeout only; stream itself is unbounded

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return new Response(
      JSON.stringify({ error: "LANGGRAPH_PLATFORM_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const threadId = request.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return new Response(
      JSON.stringify({ error: "threadId query param is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { runId } = await params;

  // Connect-timeout only: abort if the upstream doesn't RESPOND within the
  // window. We deliberately do NOT keep this signal attached to the streaming
  // body — once headers arrive we clear the timer, because an SSE run streams
  // for minutes and the AbortController must not tear the body down (which
  // truncated the stream to just the first frame).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await circuitBreaker.execute(async () => {
      const upstreamUrl = `${platformUrl}/threads/${threadId}/runs/${runId}/stream`;
      const apiKey = process.env.LANGGRAPH_API_KEY;

      const resp = await fetch(upstreamUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          ...(apiKey && { "X-Api-Key": apiKey }),
        },
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`LangGraph Platform error: ${text}`);
      }

      return resp;
    });

    clearTimeout(timeoutId);

    if (!upstreamResponse.body) {
      return new Response(null, { status: 204 });
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof CircuitOpenError) {
      return new Response(
        JSON.stringify({
          error: "Service temporarily unavailable",
          retryAfter: err.retryAfterSeconds,
        }),
        {
          status: 503,
          headers: {
            "Retry-After": String(err.retryAfterSeconds),
            "Content-Type": "application/json",
          },
        }
      );
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: "LangGraph Platform request timed out" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("[open-swe/stream] upstream fetch error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to connect to LangGraph Platform" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Run the upstream LangGraph astream_events v2 stream through the open-swe
  // adapter server-side: stage 1 normalizes tool events → AI SDK v6 tool
  // frames, stage 2 fans out DeepAgents `data-*` parts (plan/file/sub-agent/
  // approval). The browser then receives ready-to-render text-delta, tool-*,
  // and data-* frames — no client-side normalization needed.
  //
  // `[DONE]` is forwarded as-is by the transform (the client treats it as the
  // stream terminator).
  //
  // Defense-in-depth: the upstream can RST the TCP socket mid-event (network
  // blip, server restart, etc.). transformSseStream catches the read error
  // and calls controller.error(err) on its OUTGOING controller — but that
  // surfaces as an unhandled promise rejection on any reader that hasn't yet
  // attached (or on Next.js's internal consumer). We re-wrap the transformed
  // stream with a tee'd consumer that swallows rejections so the upstream
  // abort degrades to "stream closed early" rather than crashing the route
  // process or the test harness.
  const inner = transformSseStream(
    upstreamResponse.body,
    openSweAdapter.transforms
  );
  const transformed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = inner.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        // Upstream aborted or transform errored. End the client stream
        // cleanly with an SSE error frame so the client can recover, instead
        // of letting the rejection bubble as unhandled.
        try {
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({
                message: "upstream stream aborted",
              })}\n\n`
            )
          );
        } catch {
          // controller may already be errored — fall through to close.
        }
        try {
          controller.close();
        } catch {
          // already closed or errored — ignore.
        }
        // Log server-side so operators see the abort cause. The original
        // error is intentionally swallowed here to prevent an unhandled
        // rejection escaping the route handler.
        console.warn("[open-swe/stream] upstream aborted, closing client stream:", err);
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore cancel races with upstream close.
        }
      }
    },
    cancel(reason) {
      try {
        inner.cancel(reason);
      } catch {
        // ignore — upstream may already be closed.
      }
    },
  });
  return new Response(transformed, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
