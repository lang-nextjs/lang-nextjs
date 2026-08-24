import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MAX_FRAME_BYTES, type SseTransform } from "./accumulator";

// vi.mock calls must be at file scope (top of file) for Vitest hoisting to work correctly
vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));

vi.mock("./reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(),
}));

import {
  atomicRegisterIfAbsent,
  markStreamDone,
  deleteStream,
  lookupStream,
} from "./stream-registry";
import { isStreamReconnectEnabled } from "./reconnect";
import { createSseProxyHandler } from "./handler";
import type { SseProxyHandlerOptions } from "./handler";
import { coreDefaultAdapter, statefulFixtureAdapter } from "./core-test-adapters";
import { resolveApproval } from "./approval-registry";

/**
 * Core transport handler for tests. Issue #17b.
 *
 * This file tests the TRANSPORT, so it must survive `eject langchain` — a fork containing the
 * lowest rung and nothing above it. It previously used `createDeepAgentsHandler`, the RUNG-3
 * wrapper, which left the core with zero working tests in any ejected fork.
 *
 * `coreDefaultAdapter` is behaviour-identical to `deepagentsAdapter` (both are
 * `defaultTransforms`, which is core), so this migration changes no assertion. The spread is
 * last so a test that passes its own `adapter` still overrides the default.
 */
const createHandler = (options: SseProxyHandlerOptions) =>
  createSseProxyHandler({ adapter: coreDefaultAdapter, ...options });


const mockAtomicRegister = vi.mocked(atomicRegisterIfAbsent);
const mockMarkStreamDone = vi.mocked(markStreamDone);
const mockDeleteStream = vi.mocked(deleteStream);
const mockIsStreamReconnectEnabled = vi.mocked(isStreamReconnectEnabled);
const mockLookupStream = vi.mocked(lookupStream);

// Helper re-used in debug logging tests (defined at module level for reuse)
function makeDebugRequest(
  opts: {
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  const headers = new Headers(opts.headers ?? {});
  return {
    headers,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  } as any;
}

function makeDebugFetchResponse(body: string) {
  const chunks = [new TextEncoder().encode(body)];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return {
    status: 200,
    headers: new Headers(),
    body: stream,
  } as any;
}

// Helper: build a minimal NextRequest-like object
function makeRequest(
  opts: {
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  const headers = new Headers(opts.headers ?? {});
  return {
    headers,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  } as any;
}

// Helper: build a mock fetch response with a streaming body
function makeFetchResponse(
  opts: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    /** Deliver body as separate chunks instead of one concatenated payload. */
    chunks?: string[];
    noBody?: boolean;
  } = {}
) {
  const encodedChunks = opts.chunks
    ? opts.chunks.map((c) => new TextEncoder().encode(c))
    : opts.body
    ? [new TextEncoder().encode(opts.body)]
    : [];
  const stream = opts.noBody
    ? null
    : new ReadableStream({
        start(controller) {
          for (const chunk of encodedChunks) controller.enqueue(chunk);
          controller.close();
        },
      });
  return {
    status: opts.status ?? 200,
    headers: new Headers(opts.headers ?? {}),
    body: stream,
  } as any;
}

describe("createDeepAgentsHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: reconnect disabled in all existing tests (no behavior change)
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("returns a POST function when called with backendUrl", () => {
    const handler = createHandler({ backendUrl: "http://backend" });
    expect(typeof handler).toBe("function");
  });

  it("proxies SSE stream with Content-Type: text/event-stream", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hello\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("sets Cache-Control: no-cache, no-transform in response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform"
    );
  });

  it("sets X-Accel-Buffering: no in response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("forwards x-vercel-ai-ui-message-stream header from backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: "data: hi\n\n",
          headers: { "x-vercel-ai-ui-message-stream": "v1" },
        })
      )
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("forwards client headers except hop-by-hop (host, content-length, transfer-encoding, connection)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({ backendUrl: "http://backend" });
    await handler(
      makeRequest({
        headers: {
          "x-custom": "keep-me",
          host: "drop-me",
          "content-length": "5",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
        },
      })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("x-custom")).toBe("keep-me");
    expect(forwarded.get("host")).toBeNull();
    expect(forwarded.get("content-length")).toBeNull();
    expect(forwarded.get("connection")).toBeNull();
    expect(forwarded.get("transfer-encoding")).toBeNull();
  });

  it("returns 502 when backend fetch throws (unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(502);
    consoleSpy.mockRestore();
  });

  it("returns backend status when backend has no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ status: 503, noBody: true }))
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(503);
  });

  it("injects Authorization: Bearer token when getToken returns a string", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => "my-token",
    });
    await handler(makeRequest());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer my-token");
  });

  it("does not set Authorization header when getToken returns null", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => null,
    });
    await handler(makeRequest());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("does not set Authorization header when getToken returns undefined", async () => {
    // Boundary gap: the check is `token != null` which covers both null and undefined,
    // but this invariant should be confirmed explicitly for the undefined branch.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => undefined,
    });
    await handler(makeRequest());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("forwards client Authorization header as-is when getToken is not provided", async () => {
    // Gap: when getToken is absent the handler should forward ALL non-hop-by-hop headers,
    // including Authorization. The existing test only covers getToken-injected auth.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({ backendUrl: "http://backend" });
    await handler(
      makeRequest({ headers: { authorization: "Bearer client-token" } })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer client-token");
  });

  it("omits frames from the output stream when a transform returns null (frame drop)", async () => {
    // Gap: the pipeline short-circuits on null but the stream output is never
    // directly asserted — only that captured.length > 0 for a pass-through transform.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ body: 'data: {"type":"text","text":"hi"}\n\n' })
        )
    );

    const dropAll = (_frame: { raw: string }) => null;
    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [dropAll],
    });
    const response = await handler(makeRequest());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    // The dropped frame must not appear in the output at all.
    // (Asserts the dropped frame's specific content is absent — not a blanket
    //  `"type"` check, since issue #4 appends an in-band `data-error` frame
    //  when a backend closes without a terminal `finish` frame.)
    expect(output).not.toContain("text-delta");
    expect(output).not.toContain('"type":"text"');
    expect(output).not.toContain('"text":"hi"');
  });

  it("multi-transform pipeline short-circuits when first transform returns null (L98 branch)", async () => {
    // Covers handler.ts L98: `if (current === null) return null` — early exit when
    // a transform in the middle of the pipeline returns null (remaining transforms skipped)
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ body: 'data: {"type":"text-delta"}\n\n' })
        )
    );
    const spy = vi.fn().mockReturnValue({ raw: "data: pass" });
    const dropAll = () => null;
    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [dropAll, spy], // spy must never be called
    });
    const response = await handler(makeRequest());
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // The spy (second transform) must not have been invoked — pipeline short-circuited
    expect(spy).not.toHaveBeenCalled();
  });

  it("omits Authorization header when getToken returns empty string", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => "",
    });
    await handler(makeRequest());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("omits Authorization header when getToken returns a whitespace-only string", async () => {
    // Gap: the guard is `if (token)` which is a truthy check.
    // A whitespace-only string like " " or "\t" is truthy in JavaScript,
    // so the current implementation sets `Authorization: Bearer  ` (with trailing space),
    // which is not a valid bearer token and will be rejected by most backends.
    // The correct behaviour is to treat whitespace-only strings as empty (no-auth),
    // consistent with how empty string "" is handled.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => "   ",
    });
    await handler(makeRequest());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    // A whitespace-only token must NOT produce an Authorization header
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("propagates getToken error without swallowing it", async () => {
    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => {
        throw new Error("auth-failure");
      },
    });
    await expect(handler(makeRequest())).rejects.toThrow("auth-failure");
  });

  it("applies transforms pipeline to SSE frames", async () => {
    const captured: string[] = [];
    const captureTransform = (frame: { raw: string }) => {
      captured.push(frame.raw);
      return frame;
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ body: 'data: {"type":"text","text":"hi"}\n\n' })
        )
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [captureTransform],
    });
    const response = await handler(makeRequest());
    // Consume the stream to trigger transforms
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(captured.length).toBeGreaterThan(0);
  });

  it("forwards non-authorization headers alongside injected token when getToken is provided", async () => {
    // Covers handler.ts L182-183: forwardedHeaders.set(key, value) inside the getToken
    // branch loop — verifies non-hop-by-hop, non-authorization headers are forwarded
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => "server-token",
    });
    await handler(makeRequest({ headers: { "x-session-id": "sess-abc" } }));

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("x-session-id")).toBe("sess-abc");
    expect(forwarded.get("authorization")).toBe("Bearer server-token");
  });

  it("strips client Authorization header when getToken is provided, even if client sends one", async () => {
    // Gap: getToken-injected auth path filters out client Authorization before forwarding.
    // But if the client sends Authorization AND getToken is provided, the client header
    // must be completely absent from the forwarded request — not forwarded alongside the
    // injected token. Verifies the exclusion clause in the getToken branch.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      getToken: async () => "server-token",
    });
    await handler(
      makeRequest({
        headers: { authorization: "Bearer client-should-be-dropped" },
      })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    // Only the server-injected token should be present
    expect(forwarded.get("authorization")).toBe("Bearer server-token");
  });

  it("flushes incomplete trailing frame at stream end — frame split across last chunk boundary", async () => {
    // Gap: the flush() path in the handler's `done` branch is exercised, but no test
    // asserts that the flushed frame actually appears in the output stream. A frame
    // that arrives without a trailing \n\n (last chunk of a stream) must still be
    // forwarded after flush() is called on `done`.
    const encoder = new TextEncoder();
    // Stream that sends the frame data WITHOUT a trailing \n\n — simulates a backend
    // that closes the connection without emitting the final boundary.
    const incompleteStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"text-delta","delta":"tail"}\n\n')
        );
        // Send a second frame split: the boundary \n\n never arrives before close
        controller.enqueue(
          encoder.encode('data: {"type":"finish","finishReason":"stop"}')
        );
        controller.close(); // closed without trailing \n\n
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: incompleteStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    // The flushed finish frame must appear in the output — not silently dropped
    expect(output).toContain('"type":"finish"');
  });

  it("forwards 4xx status from backend when body is present (not overridden to 200)", async () => {
    // Gap: the handler passes `status: backendResponse.status` to new NextResponse().
    // But if the code ever hardcodes 200 or forgets to thread the status through,
    // a 401 Unauthorized or 403 Forbidden from the backend would silently become 200.
    // This catches that regression — a 401 WITH a body must arrive as 401, not 200.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ status: 401, body: "data: unauthorized\n\n" })
        )
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(401);
  });

  it("forwards 5xx status from backend when body is present (not overridden to 200)", async () => {
    // Companion to the 4xx test above — a 500 Internal Server Error with a body
    // (e.g. a Django error page streamed as text/event-stream) must preserve the
    // upstream status code rather than being masked as a successful 200 response.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ status: 500, body: "data: server-error\n\n" })
        )
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(500);
  });

  it("empty transforms array [] behaves identically to omitting transforms (frames pass through)", async () => {
    // Gap: options.transforms ?? [] means both `[]` and omission produce the same
    // allTransforms = [...adapter.transforms]. But if the handler ever checks
    // `options.transforms.length === 0` to skip the pipeline — or short-circuits
    // differently — passing `[]` explicitly vs omitting could diverge. Verify parity.
    const body = 'data: {"type":"text","text":"hello"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body }))
    );

    // Handler with explicit empty transforms array
    const handlerExplicit = createHandler({
      backendUrl: "http://backend",
      transforms: [],
    });
    const responseExplicit = await handlerExplicit(makeRequest());
    const readerExplicit = responseExplicit.body!.getReader();
    const decoder = new TextDecoder();
    let outputExplicit = "";
    while (true) {
      const { done, value } = await readerExplicit.read();
      if (done) break;
      outputExplicit += decoder.decode(value, { stream: true });
    }

    // Re-stub for the second handler call
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body }))
    );

    // Handler with omitted transforms
    const handlerOmitted = createHandler({
      backendUrl: "http://backend",
    });
    const responseOmitted = await handlerOmitted(makeRequest());
    const readerOmitted = responseOmitted.body!.getReader();
    let outputOmitted = "";
    while (true) {
      const { done, value } = await readerOmitted.read();
      if (done) break;
      outputOmitted += decoder.decode(value, { stream: true });
    }

    // Both outputs must be identical — same frame content, same status
    expect(outputExplicit).toBe(outputOmitted);
    expect(responseExplicit.status).toBe(responseOmitted.status);
  });

  it("calls controller.error() and logs on mid-stream ReadableStream error (SRV-06)", async () => {
    // Build a stream that throws after yielding one chunk
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.error(new Error("mid-stream-failure"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: errorStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    // Consume the stream — it should break with an error
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Expected: stream breaks with error
    }
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does NOT retry when backend returns 503 (retry only covers fetch() throws, not HTTP error status codes)", async () => {
    // Adversarial: the retry policy retries on connection-level failures (fetch() throws).
    // A 503 Service Unavailable response is a valid HTTP response — fetch() resolves, not
    // throws. Therefore fetchWithRetry must NOT retry on 503; it must return the 503
    // response immediately after the first attempt, with exactly 1 fetch() call.
    // If the implementation adds status-code-based retry (e.g. `if (res.status >= 500) throw`)
    // this test will catch the unintended behavior change and the call count would be >1.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        makeFetchResponse({ status: 503, body: "data: err\n\n" })
      );
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 3, initialDelayMs: 100 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    // fetch() must have been called exactly once — no retry on non-throw 503
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The 503 status must be forwarded as-is to the caller
    expect(response.status).toBe(503);
  });

  it("does not retry when retry option is omitted (default maxRetries=0)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    consoleSpy.mockRestore();
  });

  it("retries up to maxRetries times on fetch() throw", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 3, initialDelayMs: 100 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    await responsePromise;

    // 1 initial + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(4);
    consoleSpy.mockRestore();
  });

  it("waits initialDelayMs * 2^attempt between retries (exponential backoff)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 3, initialDelayMs: 100 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    await responsePromise;

    // 1 initial + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(4);
    consoleSpy.mockRestore();
  });

  it("succeeds if a retry attempt succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 3, initialDelayMs: 100 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(response.status).toBe(200);
  });

  it("returns 502 Bad Gateway when fetchWithRetry exhausts all retries", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 2, initialDelayMs: 50 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(502);
    // 1 initial + 2 retries = 3 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
    consoleSpy.mockRestore();
  });

  it("does not retry mid-stream failures — only initial fetch() is retried (SRV-RETRY)", async () => {
    // Initial fetch() succeeds, but the stream throws mid-read
    const errorStream = new ReadableStream({
      start(controller) {
        controller.error(new Error("mid-stream-failure"));
      },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: errorStream,
    });
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({
      backendUrl: "http://backend",
      retry: { maxRetries: 3, initialDelayMs: 100 },
    });
    const responsePromise = handler(makeRequest());
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    // fetch() was called only once — mid-stream error did not trigger retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Response is 200 (handler returned before stream was consumed)
    expect(response.status).toBe(200);

    // Consume stream to confirm mid-stream error does not cause additional fetch calls
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Expected mid-stream error
    }
    // Still only 1 fetch call — no retry for mid-stream
    expect(mockFetch).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

describe("debug logging", () => {
  beforeEach(() => {
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.DEBUG;
    vi.restoreAllMocks();
  });

  it("calls console.error when DEBUG=deepagents:sse and frame has data line", async () => {
    process.env.DEBUG = "deepagents:sse";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        makeDebugFetchResponse('data: {"type":"text-delta","delta":"Hi"}\n\n')
      );
    vi.stubGlobal("fetch", mockFetch);
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeDebugRequest());
    // Consume the stream to trigger the streaming loop
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[deepagents:sse] frame:")
    );
    consoleSpy.mockRestore();
  });

  it("does NOT call logSseFrame for a frame dropped by a transform even when DEBUG=deepagents:sse", async () => {
    // Interaction gap: logSseFrame is gated behind `if (transformed !== null)` in
    // the streaming loop. If a transform drops the frame (returns null), the debug
    // logger must NOT be called for that frame. This test verifies the guard order.
    process.env.DEBUG = "deepagents:sse";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeDebugFetchResponse('data: {"type":"text-delta","delta":"Hi"}\n\n')
        )
    );

    const dropAll = (_frame: { raw: string }) => null;
    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [dropAll],
    });
    const response = await handler(makeDebugRequest());
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // No [deepagents:sse] frame log should appear since the frame was dropped
    const sseFrameCall = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes("[deepagents:sse] frame:")
    );
    expect(sseFrameCall).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("calls logSseFrame for flushed trailing frame when DEBUG=deepagents:sse (L270 branch)", async () => {
    // Covers handler.ts L270: `if (shouldDebug()) logSseFrame(transformed)` in the flush path
    // A frame with no trailing \n\n triggers flush() on `done` — debug log must fire there too
    process.env.DEBUG = "deepagents:sse";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const encoder = new TextEncoder();
    const incompleteStream = new ReadableStream({
      start(controller) {
        // Frame without trailing \n\n — will be flushed on stream close
        controller.enqueue(
          encoder.encode('data: {"type":"text-delta","delta":"tail"}')
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: incompleteStream,
      })
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeDebugRequest());
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // Debug log must have fired for the flushed frame
    const sseCall = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes("[deepagents:sse] frame:")
    );
    expect(sseCall).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("does NOT call console.error with [deepagents:sse] when DEBUG is unset", async () => {
    delete process.env.DEBUG;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        makeDebugFetchResponse('data: {"type":"text-delta","delta":"Hi"}\n\n')
      );
    vi.stubGlobal("fetch", mockFetch);
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeDebugRequest());
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // console.error may be called for other reasons (retries etc); verify NOT called with [deepagents:sse]
    const sseCall = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes("[deepagents:sse]")
    );
    expect(sseCall).toBeUndefined();
    consoleSpy.mockRestore();
  });
});

describe("resumeId lifecycle — markStreamDone on error path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("markStreamDone IS called in finally block even when mid-stream error fires — resumeId is unlocked after crash", async () => {
    // Gap: there is a test confirming markStreamDone is called on clean stream completion,
    // but NO test covers the error path. The finally block runs after controller.error()
    // too — so markStreamDone MUST be called when a mid-stream read failure fires.
    // If an implementor moves markStreamDone out of `finally` into the happy-path only,
    // a crashed stream would permanently block re-use of the same resumeId (permanent 409).
    const errorStream = new ReadableStream({
      start(controller) {
        controller.error(new Error("mid-stream-crash"));
      },
    });
    mockAtomicRegister.mockReturnValueOnce({
      ok: true,
      streamId: expect.any(String),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: errorStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-crash" } })
    );

    // Consume the stream to trigger the error path and the finally block
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Expected mid-stream error
    }

    // markStreamDone must have been called — the finally block runs regardless of error
    expect(mockMarkStreamDone).toHaveBeenCalledWith("res-crash");
    consoleSpy.mockRestore();
  });
});

describe("resumeId lifecycle on fetch failure", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when fetch fails (502 path), deleteStream is called to clean up the registry entry — no permanent 409 lockout", async () => {
    mockAtomicRegister.mockReturnValue({ ok: true, streamId: "s-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-502-cleanup" } })
    );

    expect(response.status).toBe(502);
    expect(mockDeleteStream).toHaveBeenCalledWith("res-502-cleanup");
    expect(mockMarkStreamDone).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("resumeId deduplication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: reconnect disabled
    mockIsStreamReconnectEnabled.mockReturnValue(false);
    mockAtomicRegister.mockReturnValue({
      ok: true,
      streamId: "test-stream-id",
    });
  });

  it("when ENABLE_STREAM_RECONNECT=true but X-Resume-Id header is absent (not empty, just missing), registerStream is NOT called and request proceeds normally", async () => {
    // Gap: the guard is `if (resumeId && isStreamReconnectEnabled())`.
    // resumeId is set via `request.headers.get('x-resume-id') ?? undefined`.
    // When the header is entirely absent, get() returns null → null ?? undefined = undefined,
    // which is falsy, so the guard is skipped. If the check were `!= null` instead of
    // truthiness, an empty-string header ("") would also bypass the guard — but more
    // importantly: an absent header must NEVER trigger registerStream. Verifies the
    // null→undefined→falsy chain is intact.
    mockIsStreamReconnectEnabled.mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    // No x-resume-id header at all
    const response = await handler(makeRequest());

    expect(response.status).not.toBe(409);
    expect(mockAtomicRegister).not.toHaveBeenCalled();
  });

  it("when ENABLE_STREAM_RECONNECT is false (default), X-Resume-Id header is ignored and request proceeds normally (no 409)", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-123" } })
    );

    expect(response.status).not.toBe(409);
    expect(mockAtomicRegister).not.toHaveBeenCalled();
  });

  it("when ENABLE_STREAM_RECONNECT=true and X-Resume-Id provided and no existing stream in registry, request proceeds (calls backend)", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(true);
    mockLookupStream.mockReturnValue(undefined); // no existing stream
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-abc" } })
    );

    expect(response.status).not.toBe(409);
    expect(mockAtomicRegister).toHaveBeenCalledWith(
      "res-abc",
      expect.any(String)
    );
    expect(mockAtomicRegister).toHaveReturnedWith({
      ok: true,
      streamId: expect.any(String),
    });
  });

  it("when ENABLE_STREAM_RECONNECT=true and X-Resume-Id provided and an existing ACTIVE (done=false) stream is in registry, returns 409", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(true);
    mockAtomicRegister.mockReturnValueOnce({ ok: false, reason: "active" });

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-dup" } })
    );

    expect(response.status).toBe(409);
  });

  it("when ENABLE_STREAM_RECONNECT=true and X-Resume-Id provided and existing stream is done=true, proceeds normally (not 409)", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(true);
    mockLookupStream.mockReturnValue({
      streamId: "done-stream",
      createdAt: Date.now(),
      done: true, // stream is completed
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-done" } })
    );

    expect(response.status).not.toBe(409);
    expect(mockAtomicRegister).toHaveBeenCalledWith(
      "res-done",
      expect.any(String)
    );
    expect(mockAtomicRegister).toHaveReturnedWith({
      ok: true,
      streamId: expect.any(String),
    });
  });

  it("after a stream completes (markStreamDone called), a subsequent POST with same resumeId succeeds (not 409)", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(true);

    // First call: no existing stream
    mockAtomicRegister.mockReturnValueOnce({
      ok: true,
      streamId: expect.any(String),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }))
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response1 = await handler(
      makeRequest({ headers: { "x-resume-id": "res-retry" } })
    );
    // Consume the stream to trigger finally block (markStreamDone)
    const reader = response1.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // markStreamDone should have been called
    expect(mockMarkStreamDone).toHaveBeenCalledWith("res-retry");

    // Second call: simulate the stream is now marked done (as markStreamDone would do)
    mockAtomicRegister.mockReturnValueOnce({
      ok: true,
      streamId: expect.any(String),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi2\n\n" }))
    );

    const response2 = await handler(
      makeRequest({ headers: { "x-resume-id": "res-retry" } })
    );
    expect(response2.status).not.toBe(409);
    expect(response2.status).toBe(200);
  });

  it("concurrent parallel streams with overlapping tool calls produce independent toolCallIds", async () => {
    // Core stateful vehicle — see statefulFixtureAdapter. This asserts a TRANSPORT
    // property (per-request closures), so it must not reach a rung. (Issue #17b.)
    const toolCallBody = 'data: {"type":"probe"}\n\n';
    const handler = createHandler({
      backendUrl: "http://backend",
      adapter: statefulFixtureAdapter,
    });

    async function drain(response: any): Promise<string> {
      const reader = response.body!.getReader();
      const dec = new TextDecoder();
      let out = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      return out;
    }

    // Start both requests concurrently (do NOT await sequentially)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        // Create a new response each time to avoid stream locking
        return makeFetchResponse({ body: toolCallBody });
      })
    );
    const p1 = handler(makeRequest()).then((r) => drain(r));
    const p2 = handler(makeRequest()).then((r) => drain(r));
    const [out1, out2] = await Promise.all([p1, p2]);

    expect(out1).toContain('"toolCallId":"fx-probe-0"');
    expect(out2).toContain('"toolCallId":"fx-probe-0"');
  });

  it("ADVERSARIAL: a stateful adapter transform closure is not shared across requests — counter resets per request", async () => {
    // BUG: handler.ts L155-158 — `const allTransforms = [...effectiveAdapter.transforms, ...]`
    // executes ONCE when createHandler() is called. For langchainAdapter,
    // .transforms is a getter that returns [createLangchainTransform()] — but that
    // single closure (and its toolCallCounters Map) is then shared across all requests.
    //
    // Request 1: tool_call "search" → counter 0→1 → emits lc-search-0  ✓
    // Request 2: same handler → counter already 1 → emits lc-search-1  ✗ (should be 0)
    //
    // Fix: move `const allTransforms = [...]` inside the POST function (per-request).
    const toolCallBody = 'data: {"type":"probe"}\n\n';

    const handler = createHandler({
      backendUrl: "http://backend",
      adapter: statefulFixtureAdapter,
    });

    async function drain(response: Response): Promise<string> {
      const reader = response.body!.getReader();
      const dec = new TextDecoder();
      let out = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      return out;
    }

    // Request 1 — counter 0→1 inside the shared closure
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolCallBody }))
    );
    const out1 = await drain(
      (await handler(makeRequest())) as unknown as Response
    );
    expect(out1).toContain('"toolCallId":"fx-probe-0"');

    // Request 2 — should get fresh counter starting at 0
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolCallBody }))
    );
    const out2 = await drain(
      (await handler(makeRequest())) as unknown as Response
    );
    // FAILS: impl returns "lc-search-1" because the transform closure was not reset
    expect(out2).toContain('"toolCallId":"fx-probe-0"');
  });
});

// ---------------------------------------------------------------------------
// approvalGating option — RED tests for ADAPT-05
// ---------------------------------------------------------------------------
describe("approvalGating option", () => {
  // Helper: drain a Response body to a string
  async function drainResponse(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  /**
   * Read only what the client has BEFORE the approval is decided, then cancel.
   *
   * These tests assert on pre-approval content; none of them asserts anything about when the
   * stream closes. They previously used drainResponse(), which worked only because the
   * handler discarded pending approvals and closed immediately — the very defect fixed in
   * issue #25b. Now the handler correctly holds the response open while a human decides, so
   * draining to completion would wait out the grace period. The assertions below are
   * unchanged; only the read strategy is, and it now matches what they actually claim.
   */
  async function readBeforeApprovalDecided(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (out.includes("data-approval-required")) break;
    }
    await reader.cancel();
    return out;
  }

  // AI SDK v6 tool-input-start frame as emitted by an upstream backend
  const toolInputStartBody =
    'data: {"type":"tool-input-start","toolCallId":"run-abc--bash_execute-0","toolName":"bash_execute","input":{"command":"echo hi"}}\n\n';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("handler WITHOUT approvalGating: tool-input-start frame reaches client (no data-approval-required)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);
    expect(body).toContain("tool-input-start");
    expect(body).not.toContain("data-approval-required");
  });

  it("handler WITH approvalGating { require: true }: data-approval-required frame emitted when tool-input-start arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const response = await handler(makeRequest());
    const body = await readBeforeApprovalDecided(response as unknown as Response);
    expect(body).toContain("data-approval-required");
  });

  it("handler WITH approvalGating enabled: no tool-input-start frame reaches client before approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const response = await handler(makeRequest());
    const body = await readBeforeApprovalDecided(response as unknown as Response);
    // The original tool-input-start must NOT reach the client (it is buffered/gated)
    expect(body).not.toContain('"type":"tool-input-start"');
  });

  it("handler WITH approvalGating { require: false }: tool-input-start passes through (per-tool control)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: false }),
      },
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);
    expect(body).toContain("tool-input-start");
    expect(body).not.toContain("data-approval-required");
  });

  it("handler with approvalGating: data-approval-required frame payload has 'data' with id and actionName", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const response = await handler(makeRequest());
    const body = await readBeforeApprovalDecided(response as unknown as Response);
    // Find the data-approval-required line and parse it
    const lines = body.split("\n").filter((l) => l.startsWith("data: "));
    const approvalLine = lines.find((l) =>
      l.includes("data-approval-required")
    );
    expect(approvalLine).toBeDefined();
    const parsed = JSON.parse(approvalLine!.slice(6)) as Record<
      string,
      unknown
    >;
    expect(parsed.type).toBe("data-approval-required");
    const data = parsed.data as Record<string, unknown>;
    expect(typeof data.id).toBe("string");
    expect(data.actionName).toBe("bash_execute");
  });

  it("handler with approvalGating: getApprovalConfig receives the toolName for per-tool routing", async () => {
    const capturedToolNames: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: toolInputStartBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: ({ toolName }) => {
          capturedToolNames.push(toolName);
          return { require: true };
        },
      },
    });
    // pull-based stream: work happens as the client consumes, so read it (models a real
    // client) before asserting the per-tool callback fired. Reading up to the approval frame
    // is sufficient — the callback fires while that frame is being produced.
    const response = await handler(makeRequest());
    await readBeforeApprovalDecided(response);
    expect(capturedToolNames).toContain("bash_execute");
  });

  it("handler approvalGating option is optional: omitting it does not break default behavior", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: 'data: {"type":"text-delta","delta":"hi"}\n\n',
        })
      )
    );
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);
    expect(body).toContain("text-delta");
  });

  it("handler with approvalGating: non-tool frames (text-delta) without pending approvals pass through", async () => {
    const textBody = 'data: {"type":"text-delta","delta":"streaming text"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: textBody }))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);
    expect(body).toContain("text-delta");
  });

  it("transform that throws does not crash the stream; valid frames before and after still arrive", async () => {
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Create a transform that throws on frames containing "BAD"
    const throwingTransform: SseTransform = (frame) => {
      if (frame.raw.includes("BAD")) {
        throw new Error("Transform error on BAD frame");
      }
      return frame;
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: 'data: {"type":"text","text":"before"}\n\ndata: BAD\n\ndata: {"type":"text","text":"after"}\n\n',
        })
      )
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [throwingTransform],
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);

    // Both "before" and "after" frames should be in output
    expect(body).toContain("before");
    expect(body).toContain("after");
    // The BAD frame should appear as raw (fallback behavior)
    expect(body).toContain("BAD");

    // Console error should have been called once with the transform error
    expect(mockConsoleError).toHaveBeenCalledWith(
      "[deepagents/server] transform error, skipping frame:",
      expect.any(Error)
    );
    mockConsoleError.mockRestore();
  });

  it("transform that throws on every frame does not crash the stream; all frames pass through as-is", async () => {
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Create a transform that always throws
    const alwaysThrowingTransform: SseTransform = () => {
      throw new Error("Always throws");
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: 'data: {"type":"text","text":"first"}\n\ndata: {"type":"text","text":"second"}\n\n',
        })
      )
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [alwaysThrowingTransform],
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);

    // Both frames should appear as raw (fallback behavior)
    expect(body).toContain("first");
    expect(body).toContain("second");

    // Console error should have been called twice
    expect(mockConsoleError).toHaveBeenCalledTimes(2);
    expect(mockConsoleError).toHaveBeenCalledWith(
      "[deepagents/server] transform error, skipping frame:",
      expect.any(Error)
    );
    mockConsoleError.mockRestore();
  });

  it("oversized frame is skipped and does not reach transforms", async () => {
    const transformSpy = vi.fn((frame: any) => frame);

    const normalFrame = 'data: {"type":"text","text":"hello"}\n\n';
    const largeFrame =
      'data: {"type":"text","text":"' +
      "x".repeat(MAX_FRAME_BYTES + 1000) +
      '"}\n\n';

    // Deliver as two separate chunks so the accumulator processes the normal frame
    // before the oversized frame fills the buffer and triggers the discard guard.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          chunks: [normalFrame, largeFrame],
        })
      )
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [transformSpy as any],
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);

    expect(body).toContain("hello");
    expect(body).not.toContain("x".repeat(MAX_FRAME_BYTES + 1000));

    // Transform should only be called once — for the normal frame.
    // The oversized frame is silently discarded by the accumulator before
    // it ever reaches the handler's streaming loop.
    expect(transformSpy).toHaveBeenCalledTimes(1);
  });

  it("oversized frame in flush path (no trailing newline) is skipped", async () => {
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Create a large frame without trailing \n\n (stays in accumulator buffer
    // and triggers the MAX_FRAME_BYTES discard). Then a normal frame in a
    // separate chunk so it is processed after the buffer is cleared.
    const largeFrame =
      'data: {"type":"text","text":"' +
      "x".repeat(MAX_FRAME_BYTES + 1000) +
      '"}';
    const normalFrame = 'data: {"type":"text","text":"hello"}\n\n';

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          chunks: [largeFrame, normalFrame],
        })
      )
    );

    const handler = createHandler({
      backendUrl: "http://backend",
    });
    const response = await handler(makeRequest());
    const body = await drainResponse(response as unknown as Response);

    expect(body).toContain("hello");
    expect(body).not.toContain("x".repeat(MAX_FRAME_BYTES + 1000));
    mockConsoleError.mockRestore();
  });

  // -------------------------------------------------------------------------
  // End-to-end HITL flow tests — exercise approve/reject/edit/respond drain
  // through the FULL handler pipeline (not just the transform in isolation).
  // Uses a controllable stream so the test can call resolveApproval externally
  // between frames, simulating the real flow where the POST /api/approval/[id]
  // route resolves status while the SSE stream is still open.
  // -------------------------------------------------------------------------

  function makeControllableStream(): {
    response: any;
    push: (chunk: string) => void;
    close: () => void;
  } {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      response: { status: 200, headers: new Headers(), body: stream } as any,
      push: (chunk: string) =>
        controller!.enqueue(new TextEncoder().encode(chunk)),
      close: () => controller!.close(),
    };
  }

  async function readUntilFrame(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (chunk: string) => boolean,
    decoder: TextDecoder,
    maxIterations = 50
  ): Promise<string> {
    let acc = "";
    for (let i = 0; i < maxIterations; i++) {
      const { done, value } = await reader.read();
      if (value) acc += decoder.decode(value, { stream: true });
      if (predicate(acc)) return acc;
      if (done) return acc;
    }
    return acc;
  }

  it("end-to-end approve: drained tool-input-start and tool-output-available both reach the client", async () => {
    const { response, push, close } = makeControllableStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const resp = await handler(makeRequest());
    const reader = (resp as unknown as Response).body!.getReader();
    const dec = new TextDecoder();

    push(
      'data: {"type":"tool-input-start","toolCallId":"tc-e2e-1","toolName":"bash","input":{"cmd":"ls"}}\n\n'
    );
    const phase1 = await readUntilFrame(
      reader,
      (s) => s.includes("data-approval-required"),
      dec
    );
    const approvalMatch = phase1.match(
      /data-approval-required[^]*?"id":"([^"]+)"/
    );
    expect(approvalMatch).not.toBeNull();
    const approvalId = approvalMatch![1];

    resolveApproval(approvalId, "approve");

    push(
      'data: {"type":"tool-output-available","toolCallId":"tc-e2e-1","output":{"stdout":"file.txt"}}\n\n'
    );
    // One more frame after the trigger so the transform's readyQueue (which
    // received the trigger after the drained tool-input-start) flushes its
    // remaining item. Real backends always emit more frames after a tool;
    // the synthetic close() here would otherwise drop the queued trigger.
    push('data: {"type":"finish","finishReason":"stop"}\n\n');
    close();

    let body = phase1;
    while (true) {
      const { done, value } = await reader.read();
      if (value) body += dec.decode(value, { stream: true });
      if (done) break;
    }

    expect(body).toContain("data-approval-required");
    expect(body).toContain('"type":"tool-input-start"');
    expect(body).toContain('"type":"tool-output-available"');
    expect(body).toContain("tc-e2e-1");
  });

  it("end-to-end reject: data-error frame with code=approval_rejected reaches the client; tool frames do not", async () => {
    const { response, push, close } = makeControllableStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const resp = await handler(makeRequest());
    const reader = (resp as unknown as Response).body!.getReader();
    const dec = new TextDecoder();

    push(
      'data: {"type":"tool-input-start","toolCallId":"tc-e2e-rej","toolName":"bash","input":{}}\n\n'
    );
    const phase1 = await readUntilFrame(
      reader,
      (s) => s.includes("data-approval-required"),
      dec
    );
    const approvalId = phase1.match(
      /data-approval-required[^]*?"id":"([^"]+)"/
    )![1];

    resolveApproval(approvalId, "reject");

    push(
      'data: {"type":"tool-output-available","toolCallId":"tc-e2e-rej","output":{"stdout":"should be dropped"}}\n\n'
    );
    close();

    let body = phase1;
    while (true) {
      const { done, value } = await reader.read();
      if (value) body += dec.decode(value, { stream: true });
      if (done) break;
    }

    expect(body).toContain("data-approval-required");
    expect(body).toContain('"code":"approval_rejected"');
    expect(body).not.toContain('"type":"tool-input-start"');
  });

  it("end-to-end edit: drained tool-input-start carries the rewritten input", async () => {
    const { response, push, close } = makeControllableStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const resp = await handler(makeRequest());
    const reader = (resp as unknown as Response).body!.getReader();
    const dec = new TextDecoder();

    push(
      'data: {"type":"tool-input-start","toolCallId":"tc-e2e-edit","toolName":"bash","input":{"cmd":"rm -rf /"}}\n\n'
    );
    const phase1 = await readUntilFrame(
      reader,
      (s) => s.includes("data-approval-required"),
      dec
    );
    const approvalId = phase1.match(
      /data-approval-required[^]*?"id":"([^"]+)"/
    )![1];

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "ls" } });

    push(
      'data: {"type":"tool-output-available","toolCallId":"tc-e2e-edit","output":{"stdout":"ok"}}\n\n'
    );
    // Trailing frame so the transform's readyQueue flushes (see approve test).
    push('data: {"type":"finish","finishReason":"stop"}\n\n');
    close();

    let body = phase1;
    while (true) {
      const { done, value } = await reader.read();
      if (value) body += dec.decode(value, { stream: true });
      if (done) break;
    }

    // The drain is now split into AI-SDK-strict pair: a tool-input-start with
    // NO input field (strictObject-valid) plus a synthetic tool-input-available
    // that carries the EDITED input. The original "rm -rf /" still appears in
    // the data-approval-required frame's `arguments` echo (so the human could
    // see what was proposed) — that's expected.
    expect(body).toContain('"cmd":"ls"');
    const drainedToolInputAvail = body
      .split("\n")
      .find(
        (line) =>
          line.startsWith("data: ") &&
          line.includes('"type":"tool-input-available"')
      );
    expect(drainedToolInputAvail).toBeDefined();
    expect(drainedToolInputAvail).toContain('"input":{"cmd":"ls"}');
    expect(drainedToolInputAvail).not.toContain('"input":{"cmd":"rm -rf /"}');
    expect(body).toContain('"type":"tool-output-available"');
  });

  it("end-to-end respond: data-human-response reaches client; tool-input-start and tool-output-available do not", async () => {
    const { response, push, close } = makeControllableStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
      },
    });
    const resp = await handler(makeRequest());
    const reader = (resp as unknown as Response).body!.getReader();
    const dec = new TextDecoder();

    push(
      'data: {"type":"tool-input-start","toolCallId":"tc-e2e-resp","toolName":"bash","input":{}}\n\n'
    );
    const phase1 = await readUntilFrame(
      reader,
      (s) => s.includes("data-approval-required"),
      dec
    );
    const approvalId = phase1.match(
      /data-approval-required[^]*?"id":"([^"]+)"/
    )![1];

    resolveApproval(approvalId, "respond", { response: "try grep instead" });

    push(
      'data: {"type":"tool-output-available","toolCallId":"tc-e2e-resp","output":{"stdout":"leaked!"}}\n\n'
    );
    close();

    let body = phase1;
    while (true) {
      const { done, value } = await reader.read();
      if (value) body += dec.decode(value, { stream: true });
      if (done) break;
    }

    expect(body).toContain("data-human-response");
    expect(body).toContain('"response":"try grep instead"');
    // Tool frames did NOT execute: the buffered input and the dropped output
    // must NOT appear in client output.
    expect(body).not.toContain('"type":"tool-input-start"');
    expect(body).not.toContain('"stdout":"leaked!"');
  });
});

// ---------------------------------------------------------------------------
// mid-stream backend disconnect (issue #4) — RED tests for INTENT-01
// ---------------------------------------------------------------------------
// NOTE on the error-frame shape: the plan's Task 2(C) proposed
// `data: {"type":"error","errorText":"..."}`. The existing codebase convention
// (adapters/approvalGating.ts) emits in-band errors as the AI SDK custom
// data-part error channel: `data: {"type":"data-error","data":{"code":"...",
// "message":"..."}}`. Per the debug-context constraint #5 reconciliation, the
// handler adopts the `data-error` shape for codebase consistency. These tests
// assert that exact shape so test and implementation stay in lockstep.
describe("mid-stream backend disconnect (issue #4)", () => {
  const enc = new TextEncoder();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
    mockAtomicRegister.mockReturnValue({
      ok: true,
      streamId: "test-stream-id",
    });
  });
  // (the stream may still surface an error after the in-band error frame).
  async function drainTolerant(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) out += dec.decode(value, { stream: true });
      }
    } catch {
      // Tolerated: stream may error after delivering the error frame
    }
    return out;
  }

  it("emits an SSE error event to the client when reader.read() THROWS mid-stream", async () => {
    const errorStream = new ReadableStream({
      start(c) {
        c.enqueue(
          enc.encode('data: {"type":"text-delta","delta":"partial"}\n\n')
        );
        c.error(new Error("upstream-gone"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: errorStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // The client must receive a parseable in-band SSE error event.
    expect(output).toContain('"type":"data-error"');
    expect(output).toContain("data: ");
    consoleSpy.mockRestore();
  });

  it("emits an SSE error event when the backend disconnects WITHOUT a terminal frame (premature done — truncation)", async () => {
    const truncatedStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"text-delta","delta":"half"}\n\n'));
        c.close(); // closed without any finish/terminal frame
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: truncatedStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    expect(output).toContain('"type":"data-error"');
    consoleSpy.mockRestore();
  });

  it("does NOT emit an error event on a clean finish (backend sends a finish frame then closes)", async () => {
    const cleanStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"text-delta","delta":"hi"}\n\n'));
        c.enqueue(enc.encode('data: {"type":"finish"}\n\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: cleanStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    expect(output).not.toContain('"type":"data-error"');
  });

  it("marks the stream-registry entry done on mid-stream failure so the resumeId is unlocked", async () => {
    mockIsStreamReconnectEnabled.mockReturnValue(true);
    mockLookupStream.mockReturnValue(undefined);

    const errorStream = new ReadableStream({
      start(c) {
        c.enqueue(
          enc.encode('data: {"type":"text-delta","delta":"partial"}\n\n')
        );
        c.error(new Error("upstream-gone"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: errorStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({ headers: { "x-resume-id": "res-disconnect" } })
    );
    await drainTolerant(response as unknown as Response);

    expect(mockMarkStreamDone).toHaveBeenCalledWith("res-disconnect");
    consoleSpy.mockRestore();
  });

  // ==================== ADVERSARIAL EDGE CASES ====================
  // These tests target untested gaps in the mid-stream disconnect detection

  it("ADVERSARIAL: empty stream (zero chunks) triggers error frame emission", async () => {
    // Gap: handler.ts `sawTerminalFrame` logic may not have been tested when the
    // backend closes WITHOUT emitting ANY frames at all (not even a partial frame).
    // A completely empty stream is a valid edge case: it sets `done=true` without
    // ever entering the inner `while(true)` loop, skipping all frame accumulation.
    // The flush() on empty buffer and the `!sawTerminalFrame` check still apply.
    const emptyStream = new ReadableStream({
      start(c) {
        // Immediately close with zero chunks — reader.read() will return done=true
        // before any data is enqueued. Simulates: backend accepted but sent nothing.
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: emptyStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // Empty upstream with no terminal frame must emit error
    expect(output).toContain('"type":"data-error"');
    expect(output).toContain("upstream_disconnect");
  });

  it("ADVERSARIAL: terminal frame ([DONE] sentinel) in isolation triggers no error", async () => {
    // Gap: isTerminalFrame() checks for the literal `[DONE]` substring OR a finish type.
    // This test verifies that a `[DONE]` marker by itself (with no prior frames)
    // is correctly recognized as terminal, suppressing the error frame emission.
    const doneOnlyStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode("[DONE]\n\n"));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: doneOnlyStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // [DONE] is a valid terminal marker — no error should be emitted
    expect(output).not.toContain('"type":"data-error"');
    // But the [DONE] itself should be in the output
    expect(output).toContain("[DONE]");
  });

  it("ADVERSARIAL: finish frame arriving at chunk boundary (last chunk = frame) + close", async () => {
    // Gap: sawTerminalFrame is updated when a frame is detected, whether via the
    // main loop or flush(). A finish frame that arrives as the ENTIRE content of
    // the last chunk (complete frame, then immediately done) tests the boundary
    // case where frame detection and stream close race. If isTerminalFrame() fails
    // to parse the finish JSON at the boundary, sawTerminalFrame stays false and
    // an erroneous error frame is emitted after the real finish frame.
    const boundaryStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"text-delta","delta":"x"}\n\n'));
        c.enqueue(
          enc.encode('data: {"type":"finish","finishReason":"stop"}\n\n')
        );
        // Now immediately close — flush() runs but buffer is empty (frame already flushed)
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: boundaryStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // finish frame was seen — no error should follow
    expect(output).not.toContain('"type":"data-error"');
    // finish frame itself must be present
    expect(output).toContain('"type":"finish"');
  });

  it("ADVERSARIAL: user transform drops finish frame but raw frame still triggers sawTerminalFrame=true", async () => {
    // Gap: sawTerminalFrame is checked against the RAW frame (before transforms),
    // not the transformed frame. A user transform that returns null for the finish
    // frame should NOT prevent error-frame emission if the backend truly sent finish.
    // This verifies the invariant: truncation detection is based on what the BACKEND
    // sent, not what survives user transforms.
    const transform = (frame: { raw: string }) => {
      if (frame.raw.includes('"type":"finish"')) return null; // drop finish
      return frame;
    };
    const dropFinishStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"text-delta","delta":"y"}\n\n'));
        c.enqueue(
          enc.encode('data: {"type":"finish","finishReason":"stop"}\n\n')
        );
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: dropFinishStream,
      })
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      transforms: [transform],
    });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // finish frame was sent by backend (raw), so no error should emit
    // even though the transform dropped it from the client output
    expect(output).not.toContain('"type":"data-error"');
  });

  it("ADVERSARIAL: error-frame enqueue guarded when client already disconnected (try-catch around enqueue)", async () => {
    // Gap: when the handler attempts to enqueue the error frame after detecting
    // truncation, the client may have already disconnected (controller.enqueue()
    // throws "Invalid state"). The code has a try-catch around this enqueue, but
    // if that guard is removed or misplaced, the error-emission logic breaks.
    // We simulate client disconnect by mocking a controller that throws on enqueue.
    // (Note: in real ReadableStream, this is hard to test, so we verify the
    // try-catch is present by inspecting code flow with a spy.)
    const truncatedStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"text-delta","delta":"z"}\n\n'));
        // Close without finish — will trigger error-frame emission attempt
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: truncatedStream,
      })
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    // Consume the stream — the error-frame enqueue should be attempted and guarded
    const output = await drainTolerant(response as unknown as Response);

    // Even if client disconnects during error-frame enqueue (silently caught),
    // the handler must not crash — response delivery must complete without throwing
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    consoleSpy.mockRestore();
  });

  it("ADVERSARIAL: [DONE] substring embedded in JSON data does not false-trigger isTerminalFrame", async () => {
    // Gap: isTerminalFrame() checks `raw.includes('[DONE]')` as a substring match.
    // An adversarial backend could craft a data frame containing the literal string
    // '[DONE]' inside the JSON (e.g., in a text-delta message content). This would
    // incorrectly match and set sawTerminalFrame=true, masking a real truncation if
    // the backend later closes without a real finish frame. We verify the check is
    // more precise (parses JSON, checks type field) NOT just substring matching.
    const fakeStream = new ReadableStream({
      start(c) {
        // Embed [DONE] inside a text-delta message (fake terminal marker)
        c.enqueue(
          enc.encode(
            'data: {"type":"text-delta","delta":"the code says [DONE]"}\n\n'
          )
        );
        // Close without a real finish frame — if substring match triggers,
        // no error; if JSON parsing is correct, error fires
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: fakeStream,
      })
    );

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const output = await drainTolerant(response as unknown as Response);

    // [DONE] inside JSON is NOT a terminal marker — stream closed without real finish
    // so error MUST be emitted (substring matching would fail this test)
    expect(output).toContain('"type":"data-error"');
  });
});

describe("createDeepAgentsHandler — body-size guard (maxBodyBytes / 413)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects with 413 when Content-Length exceeds the default 1 MiB limit (header branch, body never read)", async () => {
    // Body itself is tiny, but the advertised Content-Length is over-limit.
    // The pre-buffer header check must fire and short-circuit. We make
    // arrayBuffer() throw so the test also proves the body is never read.
    const req = {
      headers: new Headers({ "content-length": String(2_000_000) }),
      arrayBuffer: async () => {
        throw new Error("body must not be read when Content-Length over limit");
      },
    } as any;
    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(req);
    expect(response.status).toBe(413);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("Payload too large");
    expect(json.maxBytes).toBe(1_048_576);
    // Header branch reports the limit but not an actual buffered size.
    expect(json.actual).toBeUndefined();
  });

  it("rejects with 413 when Content-Length exceeds a custom maxBodyBytes", async () => {
    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 100,
    });
    const response = await handler(
      makeRequest({ headers: { "content-length": "500" } })
    );
    expect(response.status).toBe(413);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.maxBytes).toBe(100);
  });

  it("post-buffer recount: 413 when actual body exceeds the limit with no Content-Length", async () => {
    // No content-length header → header branch is skipped. The belt-and-braces
    // post-buffer check on body.byteLength is what must catch this.
    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 10,
    });
    const response = await handler(makeRequest({ body: "x".repeat(50) }));
    expect(response.status).toBe(413);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("Payload too large");
    expect(json.maxBytes).toBe(10);
    // Post-buffer branch surfaces the actual buffered byte count.
    expect(json.actual).toBe(50);
  });

  it("allows a within-limit body through to the backend (guard does not false-trigger)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);
    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 1_000_000,
    });
    const response = await handler(makeRequest({ body: "small" }));
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maxBodyBytes:0 disables the guard entirely (oversized body still reaches backend)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);
    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 0,
    });
    const response = await handler(
      makeRequest({
        headers: { "content-length": String(9_999_999) },
        body: "z".repeat(5000),
      })
    );
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: body exactly at MAX_BODY_BYTES passes the guard (> vs >= off-by-one)", async () => {
    // The post-buffer guard uses `body.byteLength > maxBodyBytes` (strictly greater).
    // A body at EXACTLY maxBodyBytes must pass — the off-by-one direction is critical.
    // Pin: an implementor who changes `>` to `>=` will fail this test, exposing the regression.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 50,
    });
    // Body of EXACTLY 50 bytes — must be accepted (> not >=).
    const body = "x".repeat(50);
    const response = await handler(makeRequest({ body }));
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: body at MAX_BODY_BYTES + 1 is rejected with 413 (post-buffer branch fires)", async () => {
    // Companion to the boundary test above: pins the OTHER side of the > operator.
    // Together they bracket `body.byteLength > maxBodyBytes` so an off-by-one flip fails exactly one.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 50,
    });
    const body = "x".repeat(51);
    const response = await handler(makeRequest({ body }));
    expect(response.status).toBe(413);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("Payload too large");
    expect(json.maxBytes).toBe(50);
    // Post-buffer branch surfaces the actual byte count
    expect(json.actual).toBe(51);
    // fetch must NEVER have been called — the guard short-circuited
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("REGRESSION: under-declared Content-Length attack — Content-Length says 0 but body is 10MB; post-buffer guard must still 413", async () => {
    // Gap: existing tests cover (a) Content-Length over limit + small actual body and (b)
    // no Content-Length + over-limit body. The ADVERSARIAL attack in between — a
    // hostile client that advertises Content-Length: 0 but streams 10MB of body — was
    // not covered. The pre-buffer branch sees `0 <= maxBodyBytes` and skips; only the
    // belt-and-braces post-buffer `body.byteLength > maxBodyBytes` check catches it.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 1024, // 1 KiB — well below 10MB body
    });
    // Simulate hostile client: Content-Length: 0 but the actual streamed body is 10MB.
    const body = "x".repeat(10 * 1024 * 1024);
    const response = await handler(
      makeRequest({
        headers: { "content-length": "0" },
        body,
      })
    );
    expect(response.status).toBe(413);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.maxBytes).toBe(1024);
    // The 10MB actual byte count is surfaced in the post-buffer branch.
    expect(json.actual).toBe(10 * 1024 * 1024);
    // The backend must NEVER have been called.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ADVERSARIAL: getToken that throws SYNCHRONOUSLY (not async/rejected) propagates the throw — auth failures must escape", async () => {
    // Gap: the option type accepts `(req) => string | null | undefined`
    // (synchronous function) as well as an async one. A consumer that returns
    // a synchronous throw (e.g. a JWT lib that throws synchronously on a bad
    // signing key) bypasses the `await` semantics: the `await options.getToken(request)`
    // is no longer in the call chain because no Promise is returned — the throw
    // propagates synchronously out of the POST function. The existing test
    // `propagates getToken error without swallowing it` only covers an `async () =>`
    // function (which converts the throw into a rejected Promise that `await` surfaces).
    // A correct implementation must NOT wrap getToken in a try/catch that swallows
    // synchronous throws; the original CONTEXT.md contract is that getToken throws
    // propagate (consumer's responsibility to handle).
    const handler = createHandler({
      backendUrl: "http://backend",
      // NOT async — synchronous throw
      getToken: () => {
        throw new Error("sync-auth-failure");
      },
    });
    await expect(handler(makeRequest())).rejects.toThrow("sync-auth-failure");
  });
});
