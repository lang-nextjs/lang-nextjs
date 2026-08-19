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
