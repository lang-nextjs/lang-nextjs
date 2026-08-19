import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const STREAM_TIMEOUT_MS = 30_000; // initial connect timeout only; stream itself is unbounded

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return new Response(
      JSON.stringify({
        error:
          "LANGGRAPH_PLATFORM_URL is not set. Copy .env.example to .env.local and configure it.",
      }),
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    const upstreamUrl = `${platformUrl}/threads/${threadId}/runs/${runId}/stream`;
    const apiKey = process.env.LANGGRAPH_API_KEY;

    upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "text/event-stream",
        ...(apiKey && { "X-Api-Key": apiKey }),
      },
    });

    clearTimeout(timeoutId);

    if (!upstreamResponse.ok) {
      const text = await upstreamResponse.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "LangGraph Platform error", detail: text }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!upstreamResponse.body) {
      return new Response(null, { status: 204 });
    }
  } catch (err) {
    clearTimeout(timeoutId);
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

  // Pipe the upstream SSE stream to the browser, but wrap it so a mid-stream
  // upstream error surfaces as a final `event: error` SSE frame instead of
  // becoming a thrown read error on the client. HTTP status is already 200 at
  // this point (we committed when we read the headers) so we cannot upgrade
  // to 502 mid-stream — but we can ensure the client-side useRunStream hook
  // sees a clean termination rather than a `reader.read()` rejection.
  //
  // Note: this does NOT change the contract that LangGraph Platform sends
  // `data: [DONE]` as an end-of-stream sentinel — that path is preserved.
  const upstream = upstreamResponse.body;
  // Shared state between start() and cancel() handlers. Holding the
  // upstream reader in a closure-scoped variable lets the cancel handler
  // release the lock BEFORE calling upstream.cancel() — otherwise Node throws
  // ERR_INVALID_STATE because you can't cancel a locked stream.
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let clientCancelled = false;
  const wrappedBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      upstreamReader = upstream.getReader();
      try {
        while (!clientCancelled) {
          const { value, done } = await upstreamReader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        // Mid-stream upstream failure: emit an SSE error frame so the client
        // gets a structured signal rather than an unhandled read rejection,
        // then close the response cleanly.
        console.error("[open-swe/stream] mid-stream upstream error:", err);
        const message =
          err instanceof Error ? err.message : "upstream stream error";
        controller.enqueue(
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({
              error: "upstream stream error",
              detail: message,
            })}\n\n`
          )
        );
        controller.close();
      } finally {
        try {
          upstreamReader.releaseLock();
        } catch {
          // ignore — may already be released
        }
        upstreamReader = undefined;
      }
    },
    cancel() {
      // Client disconnected mid-stream — release the upstream reader lock
      // first (Node throws ERR_INVALID_STATE otherwise), then propagate
      // cancellation to upstream so the upstream socket/connection can be
      // released. The read loop in start() sees clientCancelled on its next
      // iteration and exits via controller.close().
      clientCancelled = true;
      try {
        upstreamReader?.releaseLock();
      } catch {
        // ignore
      }
      try {
        upstream.cancel();
      } catch {
        // ignore — upstream may already be closed or in an errored state
      }
    },
  });

  return new Response(wrappedBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
