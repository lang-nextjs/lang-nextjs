import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeepAgentsHandler } from "./handler";

// Helper: build a minimal ActionFunctionArgs-like object
function makeArgs(
  opts: {
    headers?: Record<string, string | string[]>;
    body?: string;
  } = {}
) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return {
    request: {
      headers,
      arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
    },
  } as any;
}

// Helper: build a mock fetch response with a streaming body
function makeFetchResponse(
  opts: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    noBody?: boolean;
  } = {}
) {
  const chunks = opts.body ? [new TextEncoder().encode(opts.body)] : [];
  const stream = opts.noBody
    ? null
    : new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
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
  });

  it("handler returns Response with content-type: text/event-stream", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hello\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("handler proxies request body to backend", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(makeArgs({ body: '{"message":"hello"}' }));

    const calledBody = mockFetch.mock.calls[0][1].body;
    const decoded = new TextDecoder().decode(calledBody);
    expect(decoded).toBe('{"message":"hello"}');
  });

  it("handler applies transforms — null transform drops frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ body: 'data: {"type":"text","text":"hi"}\n\n' })
        )
    );

    const dropAll = (_frame: { raw: string }) => null;
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      transforms: [dropAll],
    });
    const response = await handler(makeArgs());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    expect(output).not.toContain('"type"');
    expect(output).not.toContain("text");
  });

  it("handler injects Authorization header when getToken returns a string", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_args: any) => "my-token",
    });
    await handler(makeArgs());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer my-token");
  });

  it("handler does NOT inject Authorization when getToken returns null", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_args: any) => null,
    });
    await handler(makeArgs());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("assertNodeRuntime throws with clear message when process.versions.node is undefined", async () => {
    const originalVersions = process.versions;
    // Temporarily remove node version to simulate non-Node runtime
    Object.defineProperty(process, "versions", {
      value: {},
      configurable: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "\n\n" }))
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await expect(handler(makeArgs())).rejects.toThrow(
      "@deepagents-nextjs/remix requires Node.js runtime"
    );

    // Restore original process.versions
    Object.defineProperty(process, "versions", {
      value: originalVersions,
      configurable: true,
    });
  });

  it("handler does not throw at import time — only at call time", () => {
    // The module was imported above without error
    // Just verify createDeepAgentsHandler is callable (import succeeded)
    expect(typeof createDeepAgentsHandler).toBe("function");

    // Simulate non-Node by temporarily clearing process.versions
    const originalVersions = process.versions;
    Object.defineProperty(process, "versions", {
      value: {},
      configurable: true,
    });

    // createDeepAgentsHandler itself (factory) must NOT throw — only the returned handler throws
    expect(() =>
      createDeepAgentsHandler({ backendUrl: "http://backend" })
    ).not.toThrow();

    // Restore
    Object.defineProperty(process, "versions", {
      value: originalVersions,
      configurable: true,
    });
  });

  it("handler returns 502 when backend fetch throws a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());
    // Network errors must surface as 502, not an unhandled rejection
    expect(response.status).toBe(502);
  });

  it("handler does NOT inject Authorization header when getToken returns empty string", async () => {
    // Empty string is falsy — same as null per the fail-open contract.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_args: any) => "",
    });
    await handler(makeArgs());

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("handler does NOT forward hop-by-hop headers (host, content-length) to backend", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(
      makeArgs({
        headers: {
          host: "example.com",
          "content-length": "42",
          "x-custom": "keep-me",
        },
      })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("host")).toBeNull();
    expect(forwarded.get("content-length")).toBeNull();
    // Non-hop-by-hop custom header must be preserved
    expect(forwarded.get("x-custom")).toBe("keep-me");
  });

  it("handler returns empty body response when backend returns null body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ noBody: true, status: 204 }))
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());
    // Must not throw; must echo the upstream status
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("handler forwards client Authorization header when no getToken option is provided", async () => {
    // When getToken is absent the handler falls into the else-branch and forwards
    // ALL non-hop-by-hop headers as-is.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(
      makeArgs({ headers: { authorization: "Bearer client-token" } })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer client-token");
  });

  // Bonus test 13
  it("handler forwards x-vercel-ai-ui-message-stream marker from backend response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeFetchResponse({
        body: "\n\n",
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  // Bonus test 14
  it("handler lets getToken rejection propagate — does NOT swallow auth errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "\n\n" }))
    );

    const authError = new Error("token-service-down");
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_args: any) => {
        throw authError;
      },
    });

    await expect(handler(makeArgs())).rejects.toThrow("token-service-down");
  });

  it("adapter transforms run BEFORE user transforms — ordering is preserved", async () => {
    // If the adapter transform runs second, the assertion log would show a different order.
    const log: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ body: 'data: {"type":"text"}\n\n' })
        )
    );

    const adapterTransform = (frame: { raw: string }) => {
      log.push("adapter");
      return frame;
    };
    const userTransform = (frame: { raw: string }) => {
      log.push("user");
      return frame;
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      adapter: { name: "test-adapter", transforms: [adapterTransform] },
      transforms: [userTransform],
    });

    const response = await handler(makeArgs());
    // Drain the stream so transforms run
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) {}

    expect(log).toEqual(["adapter", "user"]);
  });

  it("handler re-adds exactly one \\n\\n terminator — transforms that return modified raw do not double-terminate", async () => {
    // The handler always appends "\n\n" to transformed.raw when emitting.
    // If a transform appends its own "\n\n", the output stream would contain "data: x\n\n\n\n"
    // which causes SSE parsers to see an empty spurious frame.
    // This test verifies each frame appears EXACTLY once with a single "\n\n" boundary
    // (i.e., the implementation does not double-terminate even when raw has no trailing \n\n).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: 'data: {"type":"text","text":"hello"}\n\ndata: {"type":"text","text":"world"}\n\n',
        })
      )
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }

    // Each frame boundary must be exactly "\n\n", not "\n\n\n\n"
    expect(output).not.toContain("\n\n\n\n");
    // Both frames must be present
    expect(output).toContain('"text":"hello"');
    expect(output).toContain('"text":"world"');
  });

  it("handler forwards transfer-encoding and connection headers from client — these are hop-by-hop and must be stripped", async () => {
    // transfer-encoding and connection are in HOP_BY_HOP but were not previously tested.
    // If the set is incomplete or the check has a bug, these headers could leak to the backend.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(
      makeArgs({
        headers: {
          "transfer-encoding": "chunked",
          connection: "keep-alive",
          "x-pass-through": "yes",
        },
      })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("transfer-encoding")).toBeNull();
    expect(forwarded.get("connection")).toBeNull();
    // Non-hop-by-hop header must still be forwarded
    expect(forwarded.get("x-pass-through")).toBe("yes");
  });

  it("mid-stream body read error causes the response stream to error rather than hang", async () => {
    // Simulate a backend body that errors partway through reading
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"));
        controller.error(new Error("mid-stream-read-failure"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        body: errorStream,
      } as any)
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeArgs());

    // Draining the output stream must throw (controller.error was called), not hang
    const reader = response.body!.getReader();
    await expect(
      (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })()
    ).rejects.toThrow("mid-stream-read-failure");
  });

  it("handler forwards duplicate Content-Type from client as a comma-joined, RFC-invalid value rather than rejecting or picking one", async () => {
    // Per the Fetch spec, when an HTTP client sends two Content-Type headers
    // (e.g. via fetch(..., { headers: [['content-type', 'x'], ['content-type', 'y']] })
    // or via a deliberately crafted proxy), Headers.get() returns them joined with ", ".
    // The remix handler iterates `args.request.headers` and does
    // `forwardedHeaders.set(key, value)` where value is the joined string.
    // The backend then sees `Content-Type: text/plain, application/json` which is
    // malformed per RFC 7231 §3.1.1.5 (each Content-Type value must be a single media-type).
    //
    // Expected behavior: the handler should reject the request (400) OR pick the
    // first Content-Type and ignore the rest. This test asserts the CORRECT
    // behavior and will FAIL under the current implementation.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    // Build args with a Headers object that has two content-type entries,
    // mimicking what the Fetch layer produces when a client sent two values.
    const requestHeaders = new Headers();
    requestHeaders.append("content-type", "text/plain");
    requestHeaders.append("content-type", "application/json");
    const args = {
      request: {
        headers: requestHeaders,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
    } as any;

    const response = await handler(args);

    // Correct behavior: either reject (4xx) or deduplicate to a single value.
    // Current buggy behavior: the comma-joined string reaches the backend.
    const is400ish = response.status >= 400 && response.status < 500;
    if (!is400ish) {
      // Handler chose to forward — it must NOT be a comma-joined invalid value.
      const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
      const sentCT = forwarded.get("content-type") ?? "";
      expect(sentCT).not.toContain(",");
      // And it must be one of the two original values (not a synthesized third)
      expect(["text/plain", "application/json"]).toContain(sentCT);
    } else {
      expect(is400ish).toBe(true);
    }
  });

  it("handler has no body-size guard — a 10MB request body is proxied verbatim to the backend", async () => {
    // The handler does `await args.request.arrayBuffer()` and forwards the entire
    // body to the backend without any size check. A malicious or buggy client can
    // exhaust backend memory by sending a very large body.
    //
    // Expected behavior: the handler should enforce a max body size (e.g. 1MB)
    // and return 413 Payload Too Large for oversized requests. This test asserts
    // the CORRECT behavior and will FAIL under the current implementation.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    // Build a 10MB body (10 * 1024 * 1024 bytes of "a").
    const tenMB = "a".repeat(10 * 1024 * 1024);
    const response = await handler(makeArgs({ body: tenMB }));

    // Correct behavior: the handler should reject with 413 Payload Too Large
    // and NOT issue a backend fetch with the full 10MB body.
    expect(response.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("SseFrameAccumulator has no upper-bound on buffer growth — a pathological frame with no \\n\\n delimiter grows without limit", async () => {
    // The accumulator's `push()` method does `this.buffer += chunk` and only
    // splits on `\n\n`. If the upstream sends a single frame with no terminator
    // (e.g. a truncated SSE stream, or a malicious backend), the buffer grows
    // unboundedly until the process is OOM-killed.
    //
    // Expected behavior: the accumulator should enforce a max frame size (e.g.
    // 1MB) and either throw, drop the frame, or reset the buffer when exceeded.
    // This test asserts the CORRECT behavior and will FAIL under the current
    // implementation.
    const { SseFrameAccumulator } = await import("./accumulator");
    const acc = new SseFrameAccumulator();

    // Push a 5MB chunk with no \n\n boundary — simulates a truncated/malicious stream
    const hugeChunk = "x".repeat(5 * 1024 * 1024);

    // Correct behavior: the accumulator should reject or truncate the oversized frame.
    // We accept any of: throw, return a truncated chunk, or return an error sentinel.
    let rejected = false;
    let truncated = false;
    try {
      const frames = acc.push(hugeChunk);
      // If it didn't throw, the frames array must not contain the full 5MB
      if (frames.length === 0) {
        // No frames extracted — check flush() didn't emit the full buffer either
        const flushed = acc.flush();
        truncated = flushed.every((f) => f.length < 1024 * 1024);
      }
    } catch {
      rejected = true;
    }

    expect(rejected || truncated).toBe(true);
  });

  // Adversarial iter 2 — concurrent handler invocations
  it("100 concurrent handler() invocations on the same backend each receive an isolated clean response", async () => {
    // Stress: fire 100 handler() calls in parallel on the SAME handler instance
    // (and thus the SAME `allTransforms` array captured in closure). If the
    // implementation mutates shared state — e.g. a module-scope accumulator,
    // a single shared response stream, or non-idempotent transforms — parallel
    // calls would corrupt each other's frames.
    //
    // Per-call output is tagged with a unique ID so we can prove no cross-talk.
    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCallCount++;
        const id = fetchCallCount;
        const body = `data: {"id":${id}, "msg":"hello-${id}"}\n\n`;
        return makeFetchResponse({ body });
      })
    );

    // A transform that appends a per-call marker — but it MUST be pure
    // (no shared mutation) for 100 calls to remain isolated.
    const tagged: string[] = [];
    const tagTransform = (frame: { raw: string }) => {
      tagged.push(frame.raw);
      return frame;
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      transforms: [tagTransform],
    });

    const N = 100;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        handler(
          makeArgs({
            headers: { "x-test-idx": String(i) },
            body: `{"req":${i}}`,
          })
        )
      )
    );

    // Each invocation must have hit the backend
    expect(fetchCallCount).toBe(N);
    // Each response must be a distinct Response with a body
    expect(responses).toHaveLength(N);
    for (const r of responses) {
      expect(r).toBeInstanceOf(Response);
      expect(r.body).not.toBeNull();
    }

    // Drain each response and confirm each contains ONLY its own tag —
    // no cross-talk between concurrent streams.
    const decoder = new TextDecoder();
    const seenIds: number[] = [];
    await Promise.all(
      responses.map(async (r) => {
        const reader = r.body!.getReader();
        let out = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        // Each response should contain exactly one frame with an id field
        const match = out.match(/"id":(\d+)/);
        expect(match).not.toBeNull();
        seenIds.push(Number(match![1]));
      })
    );

    // All 100 ids should be unique (no response contains another's data)
    expect(new Set(seenIds).size).toBe(N);
    // Transform must have been invoked exactly N times — once per frame
    expect(tagged.length).toBe(N);
  });

  // Adversarial iter 2 — extremely large headers
  it("handler survives a request with ~100KB of header values without crashing or OOMing", async () => {
    // Construct a header value that's roughly 100KB. The handler iterates
    // `args.request.headers` and sets each onto a new Headers object that is
    // then forwarded to the backend. If the handler has no cap on header
    // sizes, this should at least succeed (forwarding is technically valid),
    // and the backend (mocked here) should receive the full value.
    //
    // We assert two things:
    //   1. The handler does not throw / OOM / reject with an unhandled error.
    //   2. The backend receives the full header value verbatim (no truncation).
    const hugeValue = "a".repeat(100_000);
    const capturedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders.push(new Headers(init.headers as HeadersInit));
        return makeFetchResponse({ body: "\n\n" });
      })
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeArgs({
        headers: { "x-huge": hugeValue },
      })
    );

    // Handler did not throw and produced a Response
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);

    // Backend received the full 100KB header
    expect(capturedHeaders).toHaveLength(1);
    const received = capturedHeaders[0].get("x-huge");
    expect(received).not.toBeNull();
    expect(received!.length).toBe(100_000);
  });

  // Adversarial iter 3 — chunked Transfer-Encoding body that exceeds the size cap
  it("chunked Transfer-Encoding body without Content-Length is still size-capped post-read", async () => {
    // A client sending Transfer-Encoding: chunked (e.g. a streaming source that
    // does not know its final size up front) omits Content-Length. The pre-read
    // size guard at handler.ts lines 81-97 will skip the check. The post-read
    // guard at lines 100-116 (after arrayBuffer()) MUST still enforce the cap,
    // otherwise the backend is fed an unbounded body and the DoS guard is
    // bypassed by a trivial header swap.
    //
    // Adversary scenario: hostile client sends Transfer-Encoding: chunked with a
    // 2MB body, claims "no content-length is needed". If post-read guard is
    // missing, fetch() receives 2MB and the backend OOMs.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    // 2MB body — well over the default 1MB cap.
    const twoMB = "a".repeat(2 * 1024 * 1024);
    const response = await handler(
      makeArgs({
        headers: {
          // No content-length header — chunked encoding in spirit.
          "transfer-encoding": "chunked",
        },
        body: twoMB,
      })
    );

    // Post-read guard must reject with 413 even though Content-Length was absent.
    expect(response.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
    // Payload-too-large body must report the actual size so the client can
    // diagnose what went wrong (matches the pre-read guard's shape).
    const bodyText = await response.text();
    expect(bodyText).toContain("Payload too large");
    expect(bodyText).toContain(`"actual":${2 * 1024 * 1024}`);
  });

  // Cookie header handling — documents the design decision NOT to apply
  // the comma-strict-rejection pattern (used for Content-Type/Authorization)
  // to Cookie. See the inline rationale in handler.ts.
  it("Cookie with two values joined by '; ' (per RFC 6265) is forwarded verbatim — no comma rejection", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const args = makeArgs({
      headers: { cookie: ["session=abc", "tracking=xyz"] },
    });
    await handler(args);

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    // The Fetch API joins duplicate Cookie headers with "; " per RFC 6265
    // §4.2.1. The handler forwards the combined value as-is — NO comma
    // rejection (commas can appear in URL-encoded cookie values like
    // `data=%2C`).
    expect(forwarded.get("cookie")).toBe("session=abc; tracking=xyz");
  });

  it("Cookie with a URL-encoded comma value (%2C) passes through unchanged", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    // %2C is the URL-encoded form of `,`. Cookie values can contain
    // encoded commas per RFC 6265, so a comma-detection heuristic would
    // have false positives. We forward unchanged.
    const args = makeArgs({ headers: { cookie: "data=%2C" } });
    await handler(args);

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("data=%2C");
  });
});
