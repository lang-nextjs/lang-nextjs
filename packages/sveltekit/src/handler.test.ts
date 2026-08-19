import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeepAgentsHandler } from "./handler";

// Helper: build a minimal RequestEvent-like object
function makeEvent(
  opts: {
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  const headers = new Headers(opts.headers ?? {});
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
    const response = await handler(makeEvent());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("handler proxies request body to backend", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(makeEvent({ body: '{"message":"hello"}' }));

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
    const response = await handler(makeEvent());

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
      getToken: async (_event: any) => "my-token",
    });
    await handler(makeEvent());

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
      getToken: async (_event: any) => null,
    });
    await handler(makeEvent());

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
    await expect(handler(makeEvent())).rejects.toThrow(
      "@deepagents-nextjs/sveltekit requires Node.js runtime"
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
    const response = await handler(makeEvent());
    // Network errors must surface as 502, not an unhandled rejection
    expect(response.status).toBe(502);
  });

  it("handler does NOT inject Authorization header when getToken returns empty string", async () => {
    // Empty string is falsy — same as null per the fail-open contract.
    // If the implementation accidentally sets "Bearer " it is a bug.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_event: any) => "",
    });
    await handler(makeEvent());

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
      makeEvent({
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
    const response = await handler(makeEvent());
    // Must not throw; must echo the upstream status
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("handler forwards client Authorization header when no getToken option is provided", async () => {
    // When getToken is absent the handler falls into the else-branch and forwards
    // ALL non-hop-by-hop headers as-is. A client-supplied Authorization header
    // must therefore reach the backend unchanged (the passthrough contract).
    // If the implementation accidentally strips it in the no-getToken path,
    // downstream auth will silently break.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(
      makeEvent({ headers: { authorization: "Bearer client-token" } })
    );

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer client-token");
  });

  it("handler forwards x-vercel-ai-ui-message-stream marker from backend response", async () => {
    // The handler conditionally copies this header from the upstream response.
    // If the conditional check is inverted or uses the wrong header name,
    // the AI SDK useChat hook will not know which protocol to use.
    const mockFetch = vi.fn().mockResolvedValue(
      makeFetchResponse({
        body: "\n\n",
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeEvent());

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("handler lets getToken rejection propagate — does NOT swallow auth errors", async () => {
    // The CONTEXT.md locked decision says getToken throws propagate. If the
    // implementation accidentally catches the error and returns a 502 instead,
    // callers can never distinguish an auth failure from a backend failure.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ body: "\n\n" }))
    );

    const authError = new Error("token-service-down");
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      getToken: async (_event: any) => {
        throw authError;
      },
    });

    await expect(handler(makeEvent())).rejects.toThrow("token-service-down");
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — gap probes targeting fixes the sibling packages (server,
  // remix, edge) have already shipped. The sveltekit copy has NOT been
  // hardened in iter 1 — these tests fail until it catches up.
  // -------------------------------------------------------------------------

  it("handler forwards duplicate Content-Type from client as comma-joined RFC-invalid value", async () => {
    // Per Fetch spec, when a client sends two Content-Type headers, the
    // Headers iterator yields each value separately. The handler iterates
    // event.request.headers and calls forwardedHeaders.set(key, value) on
    // each — but value is a single string per iteration. So this actually
    // may pass. The REAL bug is when a downstream proxy merges them into
    // a single comma-joined header: "text/plain, application/json" which
    // is malformed per RFC 7231 §3.1.1.5. Sibling server/remix/edge reject
    // this with 400. We assert: handler must reject (4xx) OR forward a
    // single non-comma value.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    // Simulate the merged-header scenario the server-side sees.
    const requestHeaders = new Headers();
    requestHeaders.set("content-type", "text/plain, application/json");
    const event = {
      request: {
        headers: requestHeaders,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
    } as any;

    const response = await handler(event);

    const is4xx = response.status >= 400 && response.status < 500;
    if (!is4xx) {
      const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
      const sentCT = forwarded.get("content-type") ?? "";
      expect(sentCT).not.toContain(",");
      expect(["text/plain", "application/json"]).toContain(sentCT);
    } else {
      expect(is4xx).toBe(true);
    }
  });

  it("handler has no body-size guard — a 10MB request body is proxied verbatim to the backend", async () => {
    // The handler does `await event.request.arrayBuffer()` with no size cap
    // and forwards the full body. A malicious client can OOM the backend
    // process by sending arbitrarily large payloads. Sibling server/remix
    // enforce a maxBodyBytes option and return 413 when exceeded. The
    // sveltekit handler should do the same (or at minimum reject without
    // forwarding the body to the backend).
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    // 10MB body — large enough to OOM most backends if forwarded verbatim
    const tenMB = "a".repeat(10 * 1024 * 1024);
    const response = await handler(makeEvent({ body: tenMB }));

    // Correct behavior: 413 Payload Too Large, AND no fetch was issued
    expect(response.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — iter 2 hardening probes. Sibling server/remix/edge have
  // already extended strict duplicate-header rejection to Authorization and
  // added post-read belt-and-braces body guards. The sveltekit copy is being
  // probed here to verify it caught up.
  // -------------------------------------------------------------------------

  it("handler rejects duplicate Authorization header (comma-joined) with 400 — auth-bypass attempt", async () => {
    // Per RFC 7235, Authorization carries a single auth-scheme + token. A
    // comma-joined value like "Bearer foo, Bearer admin" is a classic auth-
    // bypass attempt that tries to confuse downstream parsers into picking
    // the second scheme. Sibling server/remix/edge reject this with 400.
    // If the implementation only checks Content-Type for duplicate headers,
    // it forwards the malicious combined Authorization value to the backend.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });

    const requestHeaders = new Headers();
    requestHeaders.set(
      "authorization",
      "Bearer user-token, Bearer admin-token"
    );
    const event = {
      request: {
        headers: requestHeaders,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
    } as any;

    const response = await handler(event);

    // Correct behavior: 400 with no fetch call. The fetch being called at all
    // means the malicious combined header reached the backend.
    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handler enforces post-read body-size guard when Content-Length is missing (chunked/streamed body)", async () => {
    // Belt-and-braces re-check after the body is buffered. A hostile or
    // misconfigured client can omit Content-Length on a streamed body, so
    // the pre-read Content-Length check would never fire. The post-read
    // guard must still reject payloads exceeding maxBodyBytes.
    //
    // If the implementation only has the pre-read Content-Length check,
    // a streamed/chunked 2MB body slips through and gets forwarded to
    // the backend — bypassing the size limit entirely.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      maxBodyBytes: 1024, // 1KB cap to keep test data small
    });

    // Build a request event with NO Content-Length header (simulates
    // chunked transfer-encoding where the client doesn't pre-declare size).
    const requestHeaders = new Headers();
    requestHeaders.set("content-type", "application/json");
    // Deliberately omit content-length — the fetch path may compute it,
    // but we explicitly avoid setting it here so the pre-read guard skips.
    const twoKB = "a".repeat(2 * 1024);
    const event = {
      request: {
        headers: requestHeaders,
        arrayBuffer: async () => new TextEncoder().encode(twoKB).buffer,
      },
    } as any;

    const response = await handler(event);

    // Post-read guard must catch the oversized body even without a
    // Content-Length header.
    expect(response.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handler isolates state across concurrent invocations — N parallel calls produce N independent responses", async () => {
    // The handler factory closes over `options.allTransforms` once at
    // creation, but the per-invocation state (transformedStream,
    // accumulator, responseHeaders) is freshly built per call. If any
    // shared mutable state leaks across calls (e.g. a module-level
    // accumulator or stream controller), parallel invocations will
    // interleave frames or return each other's bodies.
    //
    // This pins the isolation contract: 50 parallel calls each receive
    // their OWN tagged response, with no cross-contamination.
    let callCounter = 0;
    const mockFetch = vi.fn(async (_url: string, _init: RequestInit) => {
      const id = ++callCounter;
      const body = `data: {"id":${id}}\n\n`;
      return makeFetchResponse({ body });
    });
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const N = 50;
    const events = Array.from({ length: N }, (_, i) =>
      makeEvent({ body: `req-${i}` })
    );

    const responses = await Promise.all(events.map((e) => handler(e)));

    // Drain each response body fully and verify tag matches call order.
    const decoder = new TextDecoder();
    const tags: number[] = [];
    for (const response of responses) {
      const reader = response.body!.getReader();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      const m = buf.match(/"id":(\d+)/);
      expect(m).not.toBeNull();
      tags.push(Number(m![1]));
    }

    // Each tag is unique — no cross-call body mixing.
    expect(new Set(tags).size).toBe(N);
    // Tags span 1..N with no gaps.
    expect(tags.sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1)
    );
  });

  it("handler surfaces backend 502 status verbatim and does NOT mask it as 200", async () => {
    // Adversarial: the backend returns 502 (bad gateway). The handler must
    // surface the upstream status verbatim so callers can distinguish a
    // proxy failure from a clean empty stream. If the implementation always
    // forces a 200 on the outbound Response, downstream SDKs will silently
    // try to parse the (likely non-SSE) error body as SSE frames and mask
    // the actual failure.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ status: 502, body: "upstream gone\n\n" })
        )
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeEvent());
    expect(response.status).toBe(502);
  });

  it("handler still pipes SSE frames when backend returns non-JSON Content-Type (text/html upstream)", async () => {
    // Adversarial: some upstreams mis-configure themselves and respond with
    // text/html or application/octet-stream even though the body is genuine
    // SSE. The handler must NOT key off the backend's Content-Type — it
    // unconditionally re-emits text/event-stream and parses frames via the
    // accumulator. Pin: the SSE body must still be forwarded frame-by-frame.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          headers: { "content-type": "text/html; charset=utf-8" },
          body: 'data: {"type":"text-delta","textDelta":"hi"}\n\n',
        })
      )
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeEvent());
    // Outbound content-type must be text/event-stream regardless of upstream.
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    // The frame must be forwarded intact.
    expect(buf).toContain('"textDelta":"hi"');
  });

  it("handler's SseFrameAccumulator has no buffer cap — a 5MB frame with no \\n\\n reaches the client untruncated", async () => {
    // The proxy uses SseFrameAccumulator which does `this.buffer += chunk`
    // and only splits on \n\n. If the upstream sends a single oversized frame
    // (truncated SSE, misbehaving backend, or a hostile peer), the buffer
    // grows without limit and the handler pipes the full payload to the
    // client. Sibling server/remix enforce a buffer cap that throws or
    // truncates. Assert: the client-side output must NOT contain the full
    // 5MB string verbatim.
    const huge = "x".repeat(5 * 1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: stream,
      } as any)
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeEvent());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLen += decoder.decode(value, { stream: true }).length;
    }
    // Correct behavior: either the accumulator throws (response.status 500 /
    // mid-stream error) OR the total bytes piped to the client are bounded
    // well below the 5MB raw upstream payload.
    expect(totalLen).toBeLessThan(5 * 1024 * 1024);
  });

  it("handler does not blow the stack when a transform recurses into a 1000-level nested JSON frame", async () => {
    // Adversarial: a transform that JSON.parses the incoming frame and walks
    // the resulting object. If the upstream emits a 1000-level nested JSON
    // payload and a transform recurses synchronously into it, a
    // depth-unbounded recursion blows the V8 stack and the handler mid-stream
    // errors. Pin the contract: the handler must NOT crash the request when
    // a transform pipeline processes an arbitrarily-deep JSON payload —
    // either it forwards the frame (transform is opaque to the handler), or
    // it surfaces a controlled mid-stream error WITHOUT taking the whole
    // SvelteKit request down.
    vi.restoreAllMocks();
    const nested: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = nested;
    for (let i = 0; i < 1000; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    cursor.leaf = "deep";

    // Transform that JSON.parses the frame and recursively counts depth.
    // Recursion depth = JSON nesting depth + 1 for each transform call.
    const recursiveTransform = (frame: { raw: string }): { raw: string } => {
      const payload = JSON.parse(frame.raw.slice(6)) as unknown;
      const depth = (function walk(n: unknown): number {
        if (n === null || typeof n !== "object") return 1;
        const kids = Object.values(n as Record<string, unknown>);
        if (kids.length === 0) return 1;
        return 1 + Math.max(...kids.map(walk));
      })(payload);
      return { raw: `data: {"depth":${depth}}\n\n` };
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: `data: ${JSON.stringify(nested)}\n\n`,
        })
      )
    );

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      transforms: [recursiveTransform],
    });

    // Must not throw, must return a Response
    const response = await handler(makeEvent());
    expect(response.status).toBe(200);

    // Drain the response to surface any mid-stream transform stack overflow.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let didError = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // Mid-stream error is acceptable — the contract is "no uncaught crash"
      didError = true;
    }

    // Either the transform completed (frame forwarded) OR the handler surfaced
    // a controlled mid-stream error. In both cases the request did not hang
    // and we got SOME output or a clean error.
    expect(buf.length > 0 || didError).toBe(true);
  });

  it("handler silently corrupts SSE frames that contain invalid UTF-8 bytes — TextDecoder default replaces with U+FFFD, downstream JSON.parse throws", async () => {
    // Adversarial: the handler does `new TextDecoder()` which defaults to
    // UTF-8 with `fatal: false`. Invalid UTF-8 bytes are silently replaced
    // with the Unicode replacement character (U+FFFD, `�`) — NOT
    // thrown. The corrupted frame then reaches a downstream JSON.parse
    // (e.g. in useChat or a consumer transform) which throws a SyntaxError.
    // Pin the contract: either the handler rejects the upstream response
    // up-front OR surfaces a controlled mid-stream error when the JSON
    // becomes invalid — it must NOT silently pipe replacement-character
    // garbage to the client.
    vi.restoreAllMocks();
    // Construct a frame whose payload includes invalid UTF-8 (lone 0xFF byte
    // mid-string is invalid UTF-8). After decode, the JSON contains the
    // replacement character and is no longer valid JSON.
    const encoder = new TextEncoder();
    const invalidBytes = new Uint8Array([
      // 'data: {"text":"' + 0xFF + '"}\n\n'
      ...encoder.encode('data: {"text":"'),
      0xff,
      ...encoder.encode('"}\n\n'),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(invalidBytes);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: stream,
      } as any)
    );

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(makeEvent());

    // Drain response fully. Either the handler surfaced a controlled
    // error (status NOT 200, or mid-stream error), OR it forwarded a frame
    // that downstream JSON.parse would throw on (containing U+FFFD).
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder2 = new TextDecoder();
    let buf = "";
    let threwOnParse = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder2.decode(value, { stream: true });
      }
      // Try to parse what the handler emitted as if we were the AI SDK
      // useChat hook: extract the data: payload and JSON.parse it.
      const dataLine = buf.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          JSON.parse(dataLine.slice(6));
        } catch {
          threwOnParse = true;
        }
      }
    } catch {
      // Mid-stream error is an acceptable controlled failure mode.
      threwOnParse = true;
    }

    // The handler MUST NOT silently forward U+FFFD-corrupted frames that
    // downstream consumers cannot parse. Either it failed mid-stream, or
    // its output, if any, must round-trip through JSON.parse.
    expect(threwOnParse).toBe(false);
  });

  it("handler double-appends \\n\\n when a transform already terminates the frame — emits malformed triple-newline gaps", async () => {
    // Adversarial: the handler unconditionally enqueues
    //   `${transformed.raw}\n\n`
    // on every frame (handler.ts line 241). If a transform returns a
    // frame whose `raw` already ends in `\n\n` — a reasonable behavior
    // when the transform is wrapping/reformatting frames — the client
    // receives `\n\n\n\n` between frames (triple-newline gap). Some SSE
    // consumers split on `\n\n` and treat the empty middle as a malformed
    // empty frame; AI SDK parsers may also choke on the gap.
    //
    // Pin the contract: the handler must NOT double-terminate frames. The
    // output must contain at most `\n\n` between frames (no `\n\n\n\n`).
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          body: 'data: {"v":1}\n\ndata: {"v":2}\n\n',
        })
      )
    );

    const doubleTerminate = (frame: { raw: string }): { raw: string } => {
      // Transform returns the frame WITH its terminator already appended
      // (a perfectly reasonable behavior for a transform that does its
      // own framing).
      return { raw: `${frame.raw}\n\n` };
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      transforms: [doubleTerminate],
    });
    const response = await handler(makeEvent());
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder2 = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder2.decode(value, { stream: true });
    }

    // The handler must not emit a triple-newline gap (4 newlines back-to-back)
    // between any two frames. If it does, downstream SSE consumers see an
    // empty middle frame.
    expect(buf).not.toMatch(/\n\n\n\n/);
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — iter 6 LIKELY-OK probes pinning correctness for standard
// request shapes the proxy must handle gracefully.
// ---------------------------------------------------------------------------

describe("ADVERSARIAL — iter 6 handler standard request shapes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handler with empty JSON body and Content-Type: application/json succeeds (no 400 from strict-header guard)", async () => {
    // An empty body with a JSON content-type is a valid client request shape
    // (e.g. a heartbeat ping or a session-start trigger). The strict single-
    // value header guard must NOT reject it — there is no comma in the
    // content-type value, and empty body is allowed by the handler. The
    // request must reach the backend and the response must be a clean SSE
    // passthrough.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeEvent({ headers: { "content-type": "application/json" } })
    );

    // Empty body is valid — no 4xx, fetch was issued, and content-type is SSE.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The forwarded content-type must reach the backend untouched.
    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("content-type")).toBe("application/json");
  });

  it("handler with all standard Content-Type variants (text/event-stream, application/json, text/plain) all return SSE properly", async () => {
    // The proxy is content-type-agnostic on the request side: it forwards
    // whatever content-type the client sends and unconditionally re-emits
    // text/event-stream on the response. Pin: three common client content
    // types must all produce a 200 SSE response without rejection.
    const variants = ["text/event-stream", "application/json", "text/plain"];

    for (const ct of variants) {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ body: "\n\n" }));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createDeepAgentsHandler({
        backendUrl: "http://backend",
      });
      const response = await handler(
        makeEvent({ headers: { "content-type": ct } })
      );

      // All three must succeed and emit text/event-stream regardless of what
      // the client sent. None must trigger the strict-header rejection (no
      // comma, single-value per header).
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
      expect(forwarded.get("content-type")).toBe(ct);
    }
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — iter 7 likely-OK probe: a normal happy-path POST through
  // the proxy must STILL succeed end-to-end after all the iter-1..6 hardening
  // guards (Content-Type comma rejection, body-size 413, Authorization
  // duplicate-header rejection, oversized-frame drop) were added. This is a
  // sanity check that no guard accidentally rejects the common case.
  // -------------------------------------------------------------------------

  it("handler returns 200 for a normal happy-path POST with single Content-Type and a small body — guards do not break the common case", async () => {
    // A "normal" request: single Content-Type, single Authorization (no
    // duplicates), Content-Length under the 1MB default, body that fits in
    // one chunk, and a backend that responds with a single SSE frame.
    const mockFetch = vi.fn().mockResolvedValue(
      makeFetchResponse({
        status: 200,
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
        body: 'data: {"type":"text-delta","textDelta":"hi"}\n\n',
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeEvent({
        headers: {
          "content-type": "application/json",
          authorization: "Bearer good-token",
          "content-length": "27",
        },
        body: '{"message":"hello"}',
      })
    );

    // Pin: a clean common-case request must return 200 SSE.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    // The AI SDK marker must be forwarded so useChat knows the protocol.
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    // The proxy must have called fetch exactly once with the JSON body.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledBody = mockFetch.mock.calls[0][1].body;
    const decoded = new TextDecoder().decode(calledBody);
    expect(decoded).toBe('{"message":"hello"}');

    // The body stream must yield the proxied SSE frame verbatim (one
    // complete frame terminator, no double \n\n, no drops).
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    expect(output).toContain('"textDelta":"hi"');
    // Exactly one \n\n terminator after the frame — guard against the
    // double-terminator bug where a frame already terminated is appended
    // with another \n\n.
    const terminators = output.match(/\n\n/g);
    expect(terminators).not.toBeNull();
    expect(terminators!.length).toBe(1);
  });

  // Cookie header handling — documents the design decision NOT to apply the
  // comma-strict-rejection pattern (used for Content-Type/Authorization) to
  // Cookie. Cookie values can legitimately contain commas (URL-encoded as
  // %2C), and the Fetch API joins duplicate Cookie headers with "; " per
  // RFC 6265 §4.2.1 — both behaviors make a comma-detection heuristic
  // unreliable. Pin the correct pass-through contract.
  it("Cookie with two values joined by '; ' (per RFC 6265) is forwarded verbatim — no comma rejection", async () => {
    const headers = new Headers();
    headers.append("cookie", "session=abc");
    headers.append("cookie", "tracking=xyz");
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(makeEvent({ headers: { cookie: headers.get("cookie")! } }));

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("session=abc; tracking=xyz");
  });

  it("Cookie with a URL-encoded comma value (%2C) passes through unchanged", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    await handler(makeEvent({ headers: { cookie: "data=%2C" } }));

    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("data=%2C");
  });
});
