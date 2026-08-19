import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCloudflareHandler } from "./cloudflare-handler";
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

describe("createCloudflareHandler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Test 1: Returns 503 when backendUrl is empty string
  it("returns 503 when backendUrl is empty string", async () => {
    const handler = createCloudflareHandler({ backendUrl: "" });
    const response = await handler(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("BACKEND_URL");
  });

  // Test 2: Returns 503 when backendUrl is falsy
  it("returns 503 when backendUrl is falsy", async () => {
    // @ts-expect-error — testing runtime guard
    const handler = createCloudflareHandler({ backendUrl: undefined });
    const response = await handler(makeRequest());
    expect(response.status).toBe(503);
  });

  // Test 3: Returns 502 on fetch failure
  it("returns 502 when backend fetch throws", async () => {
    vi.stubGlobal("fetch", makeFailingFetch(new Error("ECONNREFUSED")));
    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    expect(response.status).toBe(502);
  });

  // Test 4: Returns backendResponse.status when body is null
  it("returns backendResponse.status when backend body is null", async () => {
    const backendResponse = new Response(null, { status: 204 });
    vi.stubGlobal("fetch", makeFetch(backendResponse));
    const handler = createCloudflareHandler({
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
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      // Empty string is falsy — should be treated the same as null
      getToken: async (_request: Request) => "",
    });

    await handler(makeRequest());
    // "Bearer " with an empty token would be a malformed auth header — must not appear
    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  // Test 17: a throwing transform propagates as a stream error (not a silent hang)
  it("propagates stream error when a transform throws", async () => {
    const boom: SseTransform = (_frame: SseFrame) => {
      throw new Error("transform explosion");
    };

    const stream = makeStream(["data: trigger\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      transforms: [boom],
    });

    const response = await handler(makeRequest());
    // The response object itself is returned before the stream errors
    expect(response.status).toBe(200);

    // Reading the stream body must surface an error, not silently succeed or hang
    const reader = response.body!.getReader();
    let caughtError: unknown = null;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
  });

  // Test 18: second transform is NOT invoked when first transform drops the frame
  it("does not call subsequent transforms when an earlier transform returns null", async () => {
    // applyTransforms short-circuits on null — the second transform should never
    // be called. If the guard is missing (e.g. `current = t(current)` without the
    // null check) then calling t(null) would throw a runtime error, which is a
    // different kind of failure — this test catches both the silent-call and the crash.
    const secondTransformSpy = vi.fn((_frame: SseFrame) => ({
      raw: "should-not-appear",
    }));

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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      adapter: { transforms: [(_frame: SseFrame) => null] }, // first transform drops
      transforms: [secondTransformSpy], // second must not be called
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    // The frame was dropped — output must be empty
    expect(text).toBe("");
    // The second transform must never have been invoked
    expect(secondTransformSpy).not.toHaveBeenCalled();
  });

  // Test 19: getToken that throws → handler must return 502 (not propagate unhandled rejection)
  // The Cloudflare handler wraps getToken in a try/catch identical to the Deno handler.
  // If that guard is ever removed or misplaced, the handler rejects instead of returning
  // a Response, which crashes the Worker.
  it("returns 502 (or any non-crash response) when getToken throws", async () => {
    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      getToken: async (_request: Request) => {
        throw new Error("auth service unavailable");
      },
    });

    // If the implementation is buggy this line throws instead of returning a Response.
    const response = await handler(makeRequest());
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // Test 20: getToken defined but returns undefined → client Authorization header stripped
  // When getToken is provided the handler enters the "strip client auth, inject token" branch.
  // If getToken returns undefined (which the type allows), the injection is skipped because
  // undefined is falsy — but the client's Authorization header has already been stripped.
  // This is a silent footgun; this test pins the behaviour so regressions surface immediately.
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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      getToken: async (_request: Request) => undefined,
    });

    await handler(
      makeRequest({
        headers: { authorization: "Bearer client-should-be-stripped" },
      })
    );

    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  // Test 21: handler always proxies as POST regardless of incoming request method
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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    // Issue a GET request (which is unusual for a chat endpoint but legal at the edge layer)
    const getRequest = new Request("https://example.com/api/chat", {
      method: "GET",
    });
    await handler(getRequest);
    expect(capturedMethod).toBe("POST");
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

    const handler = createCloudflareHandler({
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

  // Test 22: no timeout by default — handler streams to completion when streamTimeoutMs is omitted
  it("no timeout by default — handler streams to completion when streamTimeoutMs is omitted", async () => {
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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      // No streamTimeoutMs specified
    });

    const response = await handler(makeRequest());
    expect(response.status).toBe(200);
    const text = await readResponseText(response);
    expect(text).toContain("data: hello");
  });

  // Test 23: returns 504 when the backend does not respond before streamTimeoutMs
  it("returns 504 when the backend does not respond before streamTimeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        // Simulate timeout by checking the abort signal
        const signal = init.signal;
        if (signal instanceof AbortSignal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.reject(new DOMException("aborted", "AbortError"));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      streamTimeoutMs: 10,
    });

    const response = await handler(makeRequest());
    expect(response.status).toBe(504);
    const text = await response.text();
    expect(text).toContain("Gateway Timeout");
  });

  // Test 24: errors the stream when streamTimeoutMs elapses mid-stream
  it("errors the stream when streamTimeoutMs elapses mid-stream", async () => {
    // Create a hanging stream that never closes
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: start\n\n"));
        // Never close — simulate mid-stream hanging
      },
    });

    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(hangingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      streamTimeoutMs: 50, // Very short timeout
    });

    const response = await handler(makeRequest());
    expect(response.status).toBe(200);

    // Read the stream and expect it to error after timeout
    const reader = response.body!.getReader();
    let caughtError: unknown = null;
    let dataReceived = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Got some data before timeout
        dataReceived = true;
      }
    } catch (err) {
      caughtError = err;
    }

    // Either we got data initially and then an error, or error happened immediately
    // The key assertion: the stream eventually errors (does not hang forever)
    expect(caughtError).toBeInstanceOf(Error);
  });

  // Test 25: streamTimeoutMs does not interfere with a sub-timeout stream
  it("streamTimeoutMs does not interfere with a normal fast stream", async () => {
    const stream = makeStream(["data: complete\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      streamTimeoutMs: 60000, // Generous timeout
    });

    const response = await handler(makeRequest());
    expect(response.status).toBe(200);
    const text = await readResponseText(response);
    expect(text).toContain("data: complete");
  });

  // Test 26 / ADVERSARIAL 1: Empty stream chunk followed by frame — tests off-by-one in chunk boundary handling
  it("handles empty chunks without dropping subsequent valid frames", async () => {
    // Some decoders/readers might emit empty chunks; the handler must not lose frames after an empty chunk
    const stream = makeStream(["", "data: after-empty\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toContain("data: after-empty");
  });

  // Test 27 / ADVERSARIAL 2: Transform returns empty string frame — tests type coercion (should not drop)
  it("does not drop frame when transform returns empty string (empty raw field)", async () => {
    const returnEmpty: SseTransform = (_frame: SseFrame) => ({ raw: "" });

    const stream = makeStream(["data: something\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      transforms: [returnEmpty],
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    // Empty frame should still produce \n\n (frame delimiter), not be silently dropped
    expect(text).toBe("\n\n");
  });

  // Test 28 / ADVERSARIAL 3: Header with mixed case — tests case sensitivity in hop-by-hop filtering
  it("filters hop-by-hop headers case-insensitively (Content-Length vs content-length)", async () => {
    const capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers as Headers) {
            capturedHeaders[k.toLowerCase()] = v;
          }
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    // Send with mixed-case header
    await handler(
      makeRequest({
        headers: { "Content-Length": "999", "X-Custom": "allowed" },
      })
    );

    expect(capturedHeaders["content-length"]).toBeUndefined();
    expect(capturedHeaders["x-custom"]).toBe("allowed");
  });

  // Test 29 / ADVERSARIAL 4: Chunk boundary splits frame mid-data — tests accumulator resilience
  it("correctly reassembles frames split across multiple chunks", async () => {
    // Split a single frame across 3 chunks to test streaming accumulation
    const chunks = ["data: ", "hello-", "world\n\n"];
    const stream = makeStream(chunks);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);
    expect(text).toContain("data: hello-world");
  });

  // Test 30 / ADVERSARIAL 5: Multiple transforms, one returns null — tests early termination
  it("stops processing remaining transforms after first returns null", async () => {
    let secondTransformWasCalled = false;

    const dropFirst: SseTransform = (_frame: SseFrame) => null;
    const recordSecond: SseTransform = (_frame: SseFrame) => {
      secondTransformWasCalled = true;
      return { raw: "should-not-appear" };
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

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      adapter: { transforms: [dropFirst] },
      transforms: [recordSecond],
    });

    const response = await handler(makeRequest());
    const text = await readResponseText(response);

    expect(text).toBe("");
    expect(secondTransformWasCalled).toBe(false);
  });

  // Test 31 / ADVERSARIAL 6: Backend returns 4xx status with SSE body — handler must still proxy the stream
  it("proxies backend 4xx response body as SSE stream (not treated as error)", async () => {
    const stream = makeStream(["data: error-message\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 400,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());

    expect(response.status).toBe(400);
    const text = await readResponseText(response);
    expect(text).toContain("data: error-message");
  });

  // Test 32 / ADVERSARIAL 7: Unicode in SSE frame content — tests encoding round-trip
  it("correctly handles Unicode characters in frame content", async () => {
    const stream = makeStream(["data: Hello 你好 مرحبا 🚀\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);

    expect(text).toContain("Hello 你好 مرحبا 🚀");
  });

  // Test 33 / ADVERSARIAL 8: Very fragmented stream (1 byte per chunk) — stress test accumulator
  it("handles extremely fragmented chunks (1 byte at a time)", async () => {
    const frameStr = "data: fragmented\n\n";
    const chunks = frameStr.split("");
    const stream = makeStream(chunks);

    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);

    expect(text).toContain("data: fragmented");
  });

  // Test 34 / ADVERSARIAL 9: Multiple frames in single chunk with no gaps — frame boundary parsing
  it("correctly splits multiple frames in a single chunk", async () => {
    const stream = makeStream(["data: frame1\n\ndata: frame2\n\n"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    const text = await readResponseText(response);

    expect(text).toContain("data: frame1");
    expect(text).toContain("data: frame2");
  });

  // ADVERSARIAL 35: Duplicate Content-Type header (comma-joined) — sibling server/remix
  // handlers reject this with 400 to avoid combining into "text/event-stream, application/json"
  // which most strict backends (Django/FastAPI) refuse. The edge handler currently does
  // NOT validate this — a malicious client can smuggle a second Content-Type through.
  it("rejects duplicate Content-Type header (comma-joined values) with 400", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const evilRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        // RFC 7230 combines duplicate single-value headers via ", " — the resulting
        // "text/event-stream, application/json" is malformed per RFC 7231 §3.1.1.
        "content-type": "text/event-stream, application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    const response = await handler(evilRequest);
    // The handler MUST short-circuit on the bad header. Sibling server/remix handlers
    // return 400 here; if the edge handler forwards to fetch instead, this test fails
    // because fetchCalled will be true OR the status will be 200.
    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  // ADVERSARIAL 37 (iter 2): Duplicate Authorization header (comma-joined). Sibling
  // handlers also short-circuit on comma-joined Authorization — a hostile client
  // could otherwise smuggle a second bearer token via RFC 7230 join semantics and
  // confuse a strict backend into accepting either side.
  it("rejects duplicate Authorization header (comma-joined values) with 400", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const evilRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // RFC 7230 comma-joins → "Bearer real-token, Bearer attacker-token"
        authorization: "Bearer real-token, Bearer attacker-token",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    const response = await handler(evilRequest);
    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  // ADVERSARIAL 38 (iter 2): POST with Transfer-Encoding: chunked and no Content-Length.
  // A pre-read size check cannot fire because Content-Length is absent; the post-read
  // guard (which compares body.byteLength against maxBodyBytes) must catch it.
  it("rejects oversized chunked-encoded request body via the post-read guard with 413", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
      // Tight cap so the test stays small but still triggers post-read guard.
      maxBodyBytes: 1024,
    });
    // 2KB body, no Content-Length, Transfer-Encoding: chunked.
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

  // ADVERSARIAL (iter 3): Backend returns 502 with a body. The handler must surface
  // the 502 status unchanged — a buggy impl could either treat the body as a valid
  // SSE stream and silently re-label it 200, or fail to pass through the status code.
  it("surfaces backend 502 status when the upstream returns 502 with a body", async () => {
    const stream = makeStream(["upstream gateway error"]);
    vi.stubGlobal(
      "fetch",
      makeFetch(
        new Response(stream, {
          status: 502,
          headers: { "content-type": "text/plain" },
        })
      )
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    const response = await handler(makeRequest());
    // 502 must pass through verbatim; otherwise the Worker masks upstream errors.
    expect(response.status).toBe(502);
  });

  // ADVERSARIAL 36: Oversized request body — server/remix handlers enforce a 1MB cap
  // (configurable via maxBodyBytes). The edge handler reads the entire body into an
  // ArrayBuffer with no guard, allowing a hostile client to exhaust edge-runtime memory.
  it("rejects oversized request body (>1MB) with 413", async () => {
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );

    const handler = createCloudflareHandler({
      backendUrl: "http://backend.local/chat",
    });
    // 2MB body — exceeds the server-side default cap of 1_048_576 bytes.
    const oversized = "x".repeat(2 * 1024 * 1024);
    const bigRequest = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    const response = await handler(bigRequest);
    // Server/remix return 413 Payload Too Large; edge currently reads the full
    // ArrayBuffer into memory and calls fetch. Both fetchCalled=true and any
    // non-413 status prove the body-size guard is missing.
    expect(response.status).toBe(413);
    expect(fetchCalled).toBe(false);
  });

  // Cookie header handling — documents the design decision NOT to apply the
  // comma-strict-rejection pattern (used for Content-Type/Authorization) to
  // Cookie. Cookie values can legitimately contain commas (URL-encoded as
  // %2C), and the Fetch API joins duplicate Cookie headers with "; " per
  // RFC 6265 §4.2.1 — both behaviors make a comma-detection heuristic
  // unreliable. Pin the correct pass-through contract.
  it("Cookie with two values joined by '; ' (per RFC 6265) is forwarded verbatim — no comma rejection", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream(["data: hi\n\n"]), {
        headers: { "content-type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const headers = new Headers();
    headers.append("cookie", "session=abc");
    headers.append("cookie", "tracking=xyz");

    const handler = createCloudflareHandler({ backendUrl: "http://backend" });
    const request = new Request("http://localhost/chat", {
      method: "POST",
      headers,
      body: "{}",
    });
    await handler(request);

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("session=abc; tracking=xyz");
  });

  it("Cookie with a URL-encoded comma value (%2C) passes through unchanged", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream(["data: hi\n\n"]), {
        headers: { "content-type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const handler = createCloudflareHandler({ backendUrl: "http://backend" });
    const request = new Request("http://localhost/chat", {
      method: "POST",
      headers: { cookie: "data=%2C" },
      body: "{}",
    });
    await handler(request);

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("data=%2C");
  });
});
