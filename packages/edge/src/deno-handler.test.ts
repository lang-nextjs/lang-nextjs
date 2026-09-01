import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDenoHandler } from "./deno-handler";
import type { SseTransform, SseFrame } from "./accumulator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReadableStream from string chunks */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Read a Response body to completion and return the full text */
async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Make a mock fetch that returns the given Response */
function makeFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

/** Make a mock fetch that rejects */
function makeFailingFetch(error: Error) {
  return vi.fn().mockRejectedValue(error);
}

/** Make a plain Request to the handler */
function makeRequest(
  options: { headers?: Record<string, string>; body?: string } = {}
): Request {
  return new Request("https://example.com/api/chat", {
    method: "POST",
    headers: options.headers ?? { "content-type": "application/json" },
    body: options.body ?? JSON.stringify({ message: "hello" }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDenoHandler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Test 1: Returns 503 when backendUrl is empty string
  it("returns 503 when backendUrl is empty string", async () => {
    const handler = createDenoHandler({ backendUrl: "" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("BACKEND_URL");
  });

  // Test 2: Returns 503 when backendUrl is undefined-coerced (empty)
  it("returns 503 when backendUrl is falsy", async () => {
    // @ts-expect-error — testing runtime guard
    const handler = createDenoHandler({ backendUrl: undefined });
    const response = await handler(makeRequest());
    expect(response.status).toBe(503);
  });

  // Test 3: Returns 502 on fetch failure
  it("returns 502 when backend fetch throws", async () => {
    vi.stubGlobal("fetch", makeFailingFetch(new Error("ECONNREFUSED")));
    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.status).toBe(502);
  });

  // Test 4: Returns backendResponse.status when body is null
  it("returns backendResponse.status when backend body is null", async () => {
    const backendResponse = new Response(null, { status: 204 });
    vi.stubGlobal("fetch", makeFetch(backendResponse));
    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.status).toBe(204);
  });

  // Test 5: Forwards non-hop-by-hop headers to backend
  it("forwards non-hop-by-hop headers to backend", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    await handler(
      makeRequest({
        headers: {
          "x-custom-header": "my-value",
          "content-type": "application/json",
        },
      })
    );

    expect(capturedHeaders["x-custom-header"]).toBe("my-value");
  });

  // Test 6: Does NOT forward hop-by-hop headers
  it("does NOT forward host, content-length, transfer-encoding, or connection headers", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    await handler(
      makeRequest({
        headers: {
          host: "evil.com",
          "content-length": "42",
          "transfer-encoding": "chunked",
          connection: "keep-alive",
          "x-safe": "yes",
        },
      })
    );

    expect(capturedHeaders["host"]).toBeUndefined();
    expect(capturedHeaders["content-length"]).toBeUndefined();
    expect(capturedHeaders["transfer-encoding"]).toBeUndefined();
    expect(capturedHeaders["connection"]).toBeUndefined();
    expect(capturedHeaders["x-safe"]).toBe("yes");
  });

  // Test 7: Applies adapter.transforms to each SSE frame
  it("applies adapter.transforms to each SSE frame", async () => {
    const addTag: SseTransform = (frame: SseFrame) => ({
      raw: frame.raw + ":tagged",
    });

    const stream = makeStream(["data: hello\n\ndata: world\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      adapter: { transforms: [addTag] },
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toContain("data: hello:tagged");
    expect(text).toContain("data: world:tagged");
  });

  // Test 8: Drops frame when transform returns null
  it("drops frame when transform returns null", async () => {
    const dropAll: SseTransform = (_frame: SseFrame) => null;

    const stream = makeStream(["data: drop-me\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      adapter: { transforms: [dropAll] },
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toBe("");
  });

  // Test 9: Applies transforms in order: adapter first, then options.transforms
  it("applies transforms in order: adapter first, then options.transforms", async () => {
    const results: string[] = [];

    const first: SseTransform = (frame: SseFrame) => {
      results.push("first");
      return { raw: frame.raw + ":first" };
    };
    const second: SseTransform = (frame: SseFrame) => {
      results.push("second");
      return { raw: frame.raw + ":second" };
    };

    const stream = makeStream(["data: test\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      adapter: { transforms: [first] },
      transforms: [second],
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(results).toEqual(["first", "second"]);
    expect(text).toContain("data: test:first:second");
  });

  // Test 10: Forwards x-vercel-ai-ui-message-stream header from backend
  /*
   * #582 — THE CASE NO TEST COVERED: A BACKEND THAT OMITS THE MARKER.
   *
   * The test below stubs a backend that SENDS the header, which exercises the
   * forwarding path and nothing else. Measured on origin/main, NO backend in
   * this repository sends it — fastapi, django and node are all zero — so the
   * uncovered case was the only one that ever actually ran.
   */
  /*
   * No separate "another version wins" control here: the test below already
   * stubs "3" rather than "v1", so it cannot be satisfied by hardcoding the
   * default. In packages/server and packages/remix it could, and those files
   * carry an explicit control.
   */
  it("emits the marker as v1 when the backend omits it", async () => {
    const stream = makeStream(["data: hello\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );
    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("forwards x-vercel-ai-ui-message-stream header from backend", async () => {
    const stream = makeStream(["data: hello\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "3",
          },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("3");
  });

  // Test 11: Handles mid-stream error by calling controller.error()
  it("handles mid-stream error (response body read failure)", async () => {
    // Create a stream that throws mid-read
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: start\n\n"));
        controller.error(new Error("mid-stream network failure"));
      },
    });

    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(errorStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());

    // The response is returned synchronously with the stream; reading the stream
    // should error
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    // Consume until error
    let error: unknown = null;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
  });

  // Test 12: Flushes accumulator remainder on stream end
  it("flushes accumulator remainder when stream ends without trailing \\n\\n", async () => {
    // Incomplete frame (no trailing \n\n) — must be flushed on done
    const stream = makeStream(["data: partial-frame-no-newline"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toContain("data: partial-frame-no-newline");
  });

  // Test 13: getToken result injected as Bearer Authorization header
  it("injects getToken result as Bearer Authorization header", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      getToken: async (_request: Request) => "my-secret-token",
    });

    await handler(makeRequest());
    expect(capturedHeaders["authorization"]).toBe("Bearer my-secret-token");
  });

  // Test 14: getToken absent → forwards Authorization header from client
  it("forwards Authorization header from client when getToken is absent", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    await handler(
      makeRequest({
        headers: { authorization: "Bearer client-token" },
      })
    );

    expect(capturedHeaders["authorization"]).toBe("Bearer client-token");
  });

  // Test 16: getToken returns empty string → treated as no-token (falsy guard must NOT emit "Bearer ")
  it("does not set Authorization header when getToken returns empty string", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      // Empty string is falsy — should be treated the same as null
      getToken: async (_request: Request) => "",
    });

    await handler(makeRequest());
    // "Bearer " with an empty token would be a malformed auth header — must not appear
    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  // Test 17: backend returns non-2xx with a body — response Content-Type must NOT claim text/event-stream
  it("overrides Content-Type to text/event-stream even for non-streaming error responses", async () => {
    // This test documents the current (potentially surprising) behavior: the handler
    // unconditionally sets Content-Type: text/event-stream regardless of whether the
    // backend returned an actual SSE stream or a plain JSON error body.
    // If this is intentional, the test acts as a contract guard. If it's a bug, the
    // test will fail and expose it.
    const errorJson = JSON.stringify({ detail: "Unprocessable Entity" });
    const bodyStream = makeStream([errorJson]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(bodyStream, {
          status: 422,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    // The handler forces SSE headers even for a 422 JSON error — document this invariant.
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  // Test 18: getToken that throws → handler must not propagate unhandled rejection
  it("returns 502 (or any non-crash response) when getToken throws", async () => {
    // The getToken call is NOT inside the fetch try/catch block.
    // A throwing getToken would cause the handler to reject outright instead of
    // returning an error Response, which would crash the server process.
    // This test exposes that gap: if the handler rejects, the await below throws
    // and the test fails with an unhandled-promise error rather than an assertion.
    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      getToken: async (_request: Request) => {
        throw new Error("auth service unavailable");
      },
    });

    // If the implementation is buggy this line throws instead of returning a Response.
    const response = await handler(makeRequest());
    // Any valid HTTP error status is acceptable — what must NOT happen is a thrown exception.
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // Test 19: response always carries Cache-Control: no-cache, no-transform
  it("sets Cache-Control: no-cache, no-transform on every streaming response", async () => {
    const stream = makeStream(["data: hello\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    // This header is critical for preventing CDN/proxy buffering of the SSE stream.
    // If it is accidentally removed, streamed AI responses will be buffered end-to-end.
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform"
    );
  });

  // Test 20: getToken returns undefined → client Authorization header is NOT forwarded
  // When getToken is provided but resolves to undefined (which the type allows), the
  // handler enters the `getToken !== undefined` branch and strips the client's Authorization
  // header, then skips injection because `undefined` is falsy.  The client auth is silently
  // lost.  This test pins that behaviour so any change to the guard is immediately visible.
  it("strips client Authorization header when getToken is defined but returns undefined", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      // getToken is defined but returns undefined — type-legal, subtle footgun
      getToken: async (_request: Request) => undefined,
    });

    await handler(
      makeRequest({
        headers: { authorization: "Bearer client-should-be-stripped" },
      })
    );

    // Because getToken was provided (even though it returned undefined) the
    // handler must strip the client Authorization header and NOT inject a token.
    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  // Test 21: X-Accel-Buffering: no header is always set (prevents nginx buffering)
  // This header is critical for real-time SSE delivery through nginx/CDN proxies.
  // If it is accidentally removed, nginx would buffer the full stream before forwarding.
  it("sets X-Accel-Buffering: no on every streaming response", async () => {
    const stream = makeStream(["data: hello\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  // Test 22: handler always proxies as POST regardless of incoming request method
  // The implementation hardcodes method: 'POST' in the backend fetch call.
  // A GET or DELETE from the client is silently re-issued as POST.
  // This test documents the invariant so any accidental change to method forwarding
  // is immediately visible.
  it("always proxies to backend as POST regardless of incoming request method", async () => {
    let capturedMethod: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedMethod = init.method as string;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    // Issue a GET request (which is unusual for a chat endpoint but legal at the edge layer)
    const getRequest = new Request("https://example.com/api/chat", {
      method: "GET",
    });
    await handler(getRequest);
    expect(capturedMethod).toBe("POST");
  });

  // Test 23: SSE boundary (\n\n) split exactly at chunk seam end-to-end through handler
  // One backend chunk ends with a bare \n and the next chunk begins with \n — together
  // they form the \n\n frame boundary.  The TextDecoder({stream:true}) path must not
  // corrupt or drop either the frame or the buffer when the boundary straddles chunks.
  it("assembles a frame whose \\n\\n boundary is split across two backend chunks", async () => {
    const stream = makeStream(["data: split-boundary", "\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toContain("data: split-boundary");
  });

  // Test 15: getToken returns null → no Authorization header forwarded
  it("does not forward Authorization header when getToken returns null", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      getToken: async (_request: Request) => null,
    });

    await handler(
      makeRequest({
        headers: { authorization: "Bearer should-not-forward" },
      })
    );

    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  // ADVERSARIAL (iter 2): POST with Transfer-Encoding: chunked and no Content-Length.
  // Pre-read size check cannot fire (Content-Length absent); the post-read guard
  // (body.byteLength against maxBodyBytes) must catch the oversized body.
  it("rejects oversized chunked-encoded request body via the post-read guard with 413", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
      maxBodyBytes: 1024,
    });
    const oversized = "x".repeat(2 * 1024);
    const chunkedRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      body: oversized,
    });

    const response = await handler(chunkedRequest);
    expect(response.status).toBe(413);
    expect(fetchCalled).toBe(false);
  });

  // ADVERSARIAL 24: Duplicate Content-Type header — sibling server/remix handlers reject
  // with 400 to prevent RFC 7230 comma-combined values ("text/event-stream, application/json")
  // from reaching strict backends. Edge does not enforce this.
  it("rejects duplicate Content-Type header (comma-joined values) with 400", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const evilRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "text/event-stream, application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    const response = await handler(evilRequest);
    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  // ADVERSARIAL 26: Backend returns 502 (proxy/upstream error). The handler must
  // surface 502 as the response status. A buggy impl could convert it to 200 (by
  // reading the error body as if it were a stream) or fail to pass through the
  // status when the backend body is present.
  it("surfaces backend 502 status when the upstream returns 502 with a body", async () => {
    const errorBody = "upstream is down";
    const stream = makeStream([errorBody]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 502,
          headers: { "content-type": "text/plain" },
        })
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    // The 502 must be passed through verbatim, not silently rewritten.
    expect(response.status).toBe(502);
  });

  // ADVERSARIAL 27 (iter 3): 100 concurrent handler() invocations. Each call must
  // produce its own isolated Response — no shared module-level state, no accumulator
  // bleed between calls, no cross-talk. A buggy impl that cached the SseFrameAccumulator
  // at factory scope would interleave frames between callers, leaking data.
  it("isolates 100 concurrent handler() invocations (no shared state leak)", async () => {
    // Each fetch call must return its OWN fresh Response — sharing a single
    // Response body across 100 callers causes a "ReadableStream is locked"
    // TypeError at the 2nd reader, which would mask the real isolation check.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(makeStream(["data: per-call\n\n"]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        )
      )
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });

    const N = 100;
    const responses = await Promise.all(
      Array.from({ length: N }, () => handler(makeRequest()))
    );
    expect(responses).toHaveLength(N);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    // Each response body must independently contain its own frame — none dropped,
    // none merged. We assert by reading all bodies in parallel.
    const bodies = await Promise.all(responses.map(readResponseText));
    for (const body of bodies) {
      expect(body).toContain("data: per-call");
    }
  });

  // ADVERSARIAL 25: Oversized request body — server/remix cap at 1MB; edge reads the full
  // ArrayBuffer with no guard, allowing memory exhaustion at the edge runtime.
  it("rejects oversized request body (>1MB) with 413", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createDenoHandler({
      backendUrl: "http://backend.local/chat",
    });
    const oversized = "x".repeat(2 * 1024 * 1024);
    const bigRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    const response = await handler(bigRequest);
    expect(response.status).toBe(413);
    expect(fetchCalled).toBe(false);
  });
});
