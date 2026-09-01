import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  CircuitOpenError,
  CircuitState,
} from "../../../../../../lib/circuit-breaker";

// Provide a circuitBreaker mock with pass-through execute by default.
// Individual tests can override circuitBreaker.execute to simulate failures.
const circuitBreakerMock = {
  execute: (fn: () => Promise<any>) => fn(),
};

vi.mock("../../../../../../lib/langgraph-client", () => ({
  circuitBreaker: circuitBreakerMock,
  CircuitOpenError,
}));

// Helper to build a NextRequest for the route handler.
// Next.js 15 makes dynamic route params async — `params` must be a Promise
// to match the route handler's expected signature `(req, ctx: { params: Promise<...> })`.
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

  /*
   * DELIVERY, NOT SHAPE (#586).
   *
   * DASH-03 claims this endpoint "delivers live SSE agent output", and was cited to an e2e
   * test that `page.route(...).fulfill(...)`s THIS VERY PATH — so the route handler never
   * executed and what was proven is that the client renders what a stub sent it. That
   * instrument was already condemned in writing when E2E-11 was rewritten (#501): a
   * route.fulfill "cannot hold a stream open mid-way, so the interruption was fiction". The
   * fix went to the instance, not the class, and the citation one row over kept using it.
   *
   * route.fulfill is not wrong everywhere. It is wrong when the thing being stubbed IS THE
   * SUBJECT OF THE CLAIM. Here the upstream platform is stubbed — someone else's dependency,
   * legitimately — and the route under test runs for real.
   *
   * WHY THE CASE ABOVE IS NOT ENOUGH. It asserts status 200 and Content-Type
   * text/event-stream and never reads the body, so a response correctly SHAPED like SSE and
   * carrying nothing passes it. That is #532's distinction one level up: an assertion on the
   * envelope stays green while the payload is dropped. Watched: emptying the transformed
   * stream leaves that case green and reddens this one.
   */
  it("DELIVERS the agent output: the SSE payload reaches the caller, not just the headers", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","id":"t1","delta":"hi-from-agent"}\n\n'
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })));
    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1", "thread-1");
    const res = await GET(req, { params });
    const text = await new Response(res.body).text();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // The payload itself, through the real handler and its adapter transforms.
    expect(text).toContain('"delta":"hi-from-agent"');
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

  it("ADV: upstream SSE abort mid-event is gracefully handled (status already 200)", async () => {
    // The route returns 200 + text/event-stream with the transformed body.
    // If the upstream ReadableStream rejects mid-flight AFTER headers are sent,
    // there is no way to change the HTTP status. Verify the handler does NOT
    // crash the process, does NOT throw out of the response body, and that
    // any error path closes/aborts the stream rather than hanging the client.
    // Correct behaviour: the response body either closes cleanly OR emits an
    // error frame; in neither case should the test process observe an
    // unhandled rejection.
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    const failingStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"part-1"}\n\n'
          )
        );
        controller.error(new Error("upstream RST mid-event"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(failingStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    try {
      const { GET } = await import("./route");
      const { req, params } = makeRequest("run-1", "thread-1");
      const res = await GET(req, { params });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      // Consuming the response body must not hang the test forever — give it
      // a bounded read. If the handler crashed silently, this read would
      // reject with an unhandled error.
      const reader = res.body!.getReader();
      const readResult = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 250)
        ),
      ]);
      // Either a frame arrived or the stream closed — both are acceptable.
      expect((readResult as { done: boolean }).done !== undefined).toBe(true);
      try {
        await reader.cancel();
      } catch {
        // ignore cancel races
      }
      // Allow microtasks to flush before inspecting unhandled rejections.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled.length).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ADV: upstream emits malformed JSON inside an SSE data: field — must not 500 the route", async () => {
    // The upstream LangGraph stream occasionally sends a frame whose payload
    // is truncated (TCP RST mid-write, server crash during emit). The route's
    // transformSseStream may forward the bytes verbatim to the browser — but
    // if the client tries to JSON.parse(evt.data) and fails, the browser
    // surfaces a console error but the stream itself stays open. The route
    // contract is: respond 200 with text/event-stream, do NOT throw, do NOT
    // 500, and let the malformed frame pass through (the browser adapter
    // handles parse failures gracefully).
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    const malformed = new ReadableStream({
      start(controller) {
        // Valid frame followed by a truncated JSON frame
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"ok"}\n\n'
          )
        );
        controller.enqueue(new TextEncoder().encode("data: {truncated\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(malformed, {
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

    // Reading must not throw — read with a bounded timeout so a hung stream
    // doesn't deadlock the test.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    const readAll = async () => {
      while (true) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((res) =>
            setTimeout(() => res({ done: true, value: undefined }), 200)
          ),
        ]);
        if (r.done) break;
        accumulated += decoder.decode(r.value, { stream: true });
      }
    };
    await readAll();
    try {
      await reader.cancel();
    } catch {
      /* ignore cancel races */
    }
    // Both the valid frame and the malformed payload should appear in the
    // bytes forwarded to the client. The route is a pass-through for SSE
    // bytes — JSON parsing is the client's job.
    expect(accumulated).toContain('"delta":"ok"');
    expect(accumulated).toContain("{truncated");
  });

  it("returns 503 with Retry-After when circuit breaker is open", async () => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");
    circuitBreakerMock.execute = vi
      .fn()
      .mockRejectedValue(new CircuitOpenError(30, CircuitState.OPEN));

    const { GET } = await import("./route");
    const { req, params } = makeRequest("run-1", "thread-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const json = await res.json();
    expect(json.error).toMatch(/temporarily unavailable/i);
    expect(json.retryAfter).toBe(30);

    // Restore pass-through for subsequent tests
    circuitBreakerMock.execute = (fn) => fn();
  });
});

// ---------------------------------------------------------------------------
// Ported from apps/example/app/api/open-swe/runs/[runId]/stream/route.test.ts
// (#19). apps/example embedded a duplicate open-swe rung, deleted in PR #29.
// These three had no counterpart here.
//
// The abort case is deliberately STRONGER than the existing ADV abort test
// above: that one accepts "either closes cleanly OR emits an error frame", so
// this route could stop emitting the frame and still pass it. This pins the
// frame's presence, its payload, and delivery of the partial event before it.
// ---------------------------------------------------------------------------
describe("GET /api/open-swe/runs/[runId]/stream — ported coverage (#19)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ignores unknown query params (extra ?debug=1 does not 400)", async () => {
    // The route reads only `threadId`. Unknown params must not 400, and must
    // not bleed into the upstream URL.
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
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://fake-platform/threads/thread-1/runs/run-1/stream",
      expect.any(Object)
    );
  });

  it("stream aborts mid-event: upstream error surfaces as an SSE 'event: error' frame, not a thrown read error", async () => {
    // (a) status committed to 200  (b) partial event delivered before the error
    // (c) a structured `event: error` frame follows  (d) reads never throw.
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    const erroringBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","id":"t1","delta":"partial"}\n\n'
          )
        );
      },
      pull(controller) {
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

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value);
    }
    reader.releaseLock();

    // (b) partial event reached the client before the failure
    expect(collected).toContain('"delta":"partial"');

    // (c)(d) structured error frame, and the drain above never threw.
    // Payload is this route's own: {"message":"upstream stream aborted"}.
    expect(collected).toMatch(/^event: error\ndata: /m);
    expect(collected).toContain('"message":"upstream stream aborted"');
  });

  // ⚠ SKIPPED — FAILS AGAINST THE CURRENT ROUTE. THIS IS A DEFECT, NOT A BAD PORT.
  //
  // `route.ts:163-168` does `cancel(reason) { try { inner.cancel(reason) } catch {} }`,
  // but `inner` is already locked by the reader taken in `start()` (route.ts:122).
  // `ReadableStream.cancel()` on a locked stream REJECTS — it does not throw
  // synchronously — so the `try/catch` never catches it. Two consequences:
  //   1. cancellation never reaches the upstream body → the upstream socket is
  //      never released → FD leak on every client disconnect.
  //   2. `ERR_INVALID_STATE` escapes as an unhandled rejection.
  //
  // Observed: `expected false to be true` (upstreamCancelCalled), plus
  // "TypeError: Invalid state: ReadableStream is locked" at route.ts:165.
  //
  // apps/example's route handled this by releasing the reader lock BEFORE
  // cancelling upstream. Deleting apps/example without this port would have
  // silently dropped the only test that catches the leak.
  //
  // The assertion below is UNMODIFIED. Un-skipped: the route fix landed in #37 (the reader is
  // hoisted to closure scope, cancel() releases the lock and RETURNS inner.cancel), and this
  // passes against it. It should have been un-skipped with that fix and was not — it sat off for
  // days inside a suite reporting "325 passed | 10 skipped", where a skipped test and a passing
  // one look identical at the summary. scripts/assert-no-silent-skips.mjs now makes that
  // impossible to leave behind quietly.
  it("stream aborted by client (reader.cancel) propagates to upstream so socket is released", async () => {
    // Guards against an FD leak on a long-lived streaming endpoint: when the
    // client goes away, the upstream connection must be released.
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", "http://fake-platform");

    let upstreamCancelCalled = false;
    const slowUpstream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","id":"t1","delta":"a"}\n\n'
          )
        );
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
    await reader.read();
    await reader.cancel();

    expect(upstreamCancelCalled).toBe(true);
  });
});
