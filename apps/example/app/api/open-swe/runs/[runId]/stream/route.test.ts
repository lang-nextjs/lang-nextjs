import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../../lib/langgraph-client");

// Helper to build a NextRequest for the route handler
function makeRequest(
  runId: string,
  threadId?: string
): { req: NextRequest; params: Promise<{ runId: string }> } {
  const url = threadId
    ? `http://localhost/api/open-swe/runs/${runId}/stream?threadId=${encodeURIComponent(
        threadId
      )}`
    : `http://localhost/api/open-swe/runs/${runId}/stream`;
  return {
    req: new NextRequest(url),
    // Next 15 route handlers receive `params` as a Promise.
    params: Promise.resolve({ runId }),
  };
}

describe("GET /api/open-swe/runs/[runId]/stream", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 400 when threadId query param is missing", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/threadId/i);
  });

  it("returns 502 when LANGGRAPH_PLATFORM_URL is not set", async () => {
    // LANGGRAPH_PLATFORM_URL is not stubbed — stays undefined
    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1", "thread-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/LANGGRAPH_PLATFORM_URL/i);
  });

  it("returns 200 text/event-stream when upstream responds with SSE body", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"hi"}\n\n'
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1", "thread-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("returns 502 when upstream fetch fails", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );

    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1", "thread-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(502);
  });

  it("stream isolation: runId from params is included in upstream URL", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { GET } = await import("./route");
    const { req, params } = makeRequest("my-specific-run-id", "thread-1");
    await GET(req, { params });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("my-specific-run-id"),
      expect.any(Object)
    );
  });

  it("ignores unknown query params (extra ?debug=1 does not 400)", async () => {
    // The route only reads `threadId`. Any other query params should be
    // silently ignored — they should not cause a 400, 500, or change the
    // upstream URL. If a future change decides to whitelist params, this
    // test catches the regression.
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { GET } = await import("./route");
    const url =
      "http://localhost/api/open-swe/runs/run-1/stream?threadId=thread-1&debug=1&foo=bar";
    const req = new NextRequest(url);
    const params = Promise.resolve({ runId: "run-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(200);
    // The upstream URL must still be the canonical /runs/{id}/stream path —
    // unknown params must not bleed into the upstream request.
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://fake-platform/threads/thread-1/runs/run-1/stream",
      expect.any(Object)
    );
  });

  it("stream aborts mid-event: upstream error surfaces as an SSE 'event: error' frame, not a thrown read error", async () => {
    // Adversarial: a real-world SSE failure mode where the connection succeeds
    // (status 200 + Content-Type) but the body errors out after partial data
    // has been emitted. The hardened route wraps the upstream body in a
    // ReadableStream whose start() catches mid-stream errors and emits a final
    // SSE `event: error` data frame. The client-side useRunStream hook then
    // sees a clean termination with a structured error signal, NOT a thrown
    // read rejection that would propagate to the React error boundary.
    //
    // We assert three things:
    //   (a) the route returns 200 (HTTP status cannot change after headers sent)
    //   (b) the partial event is delivered to the reader
    //   (c) a subsequent read returns the SSE error frame (NOT throws)
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    const erroringBody = new ReadableStream({
      // Realistic mid-stream failure: enqueue the partial event synchronously
      // (typical first-chunk arrival), then error on the NEXT pull. The
      // wrapped route must propagate the partial event before the SSE error
      // frame.
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"partial"}\n\n'
          )
        );
      },
      pull(controller) {
        // Error on the second pull — simulates the connection dropping after
        // the first chunk was delivered.
        controller.error(new Error("upstream connection reset mid-event"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(erroringBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-midabort", "thread-midabort");
    const res = await GET(req, { params });

    // (a) Status committed to 200 (cannot change after headers sent)
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Drain the full response body — the wrapped stream should yield the
    // partial event, then the SSE error frame, then close cleanly. No
    // thrown read errors.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value);
    }
    reader.releaseLock();

    // (b) Partial event delivered before the error
    expect(collected).toContain('"delta":"partial"');

    // (c) SSE error frame surfaces the upstream mid-stream error
    expect(collected).toMatch(/^event: error\ndata: /m);
    expect(collected).toContain('"error":"upstream stream error"');
    expect(collected).toMatch(/reset|mid-event/i);
  });

  it("stream aborted by client (reader.cancel) propagates to upstream so socket is released", async () => {
    // Verifies the cancel() handler on the wrapped ReadableStream propagates
    // cancellation to the upstream body so the upstream socket/connection
    // can be released (no FD leak on long-lived streaming endpoints).
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    let upstreamCancelCalled = false;
    let upstreamEnqueueCount = 0;
    const slowUpstream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"a"}\n\n'
          )
        );
        upstreamEnqueueCount++;
      },
      cancel() {
        upstreamCancelCalled = true;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(slowUpstream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-cancel", "thread-cancel");
    const res = await GET(req, { params });

    const reader = res.body!.getReader();
    // Drain the first event
    await reader.read();
    // Client cancels mid-stream
    await reader.cancel();

    // Upstream must see the cancellation
    expect(upstreamCancelCalled).toBe(true);
  });
});
