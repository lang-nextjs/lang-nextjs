import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock calls must be at file scope (top of file) for Vitest hoisting.
vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));

vi.mock("./reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(),
}));

import { isStreamReconnectEnabled } from "./reconnect";
import { createDeepAgentsHandler } from "./deepagents-handler";
import type { ObservabilityHooks } from "./observability";

const mockIsStreamReconnectEnabled = vi.mocked(isStreamReconnectEnabled);

function makeRequest(
  opts: { headers?: Record<string, string>; body?: string } = {}
) {
  const headers = new Headers(opts.headers ?? {});
  return {
    headers,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  } as any;
}

function makeFetchResponse(
  opts: { status?: number; headers?: Record<string, string>; chunks?: string[]; noBody?: boolean } = {}
) {
  const encodedChunks = (opts.chunks ?? []).map((c) =>
    new TextEncoder().encode(c)
  );
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

async function drain(response: { body: ReadableStream<Uint8Array> | null }) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output;
}

// A multi-frame backend ending with a terminal finish frame.
const MULTI_FRAME_CHUNKS = [
  'data: {"type":"text-delta","delta":"hello"}\n\n',
  'data: {"type":"text-delta","delta":" world"}\n\n',
  'data: {"type":"finish"}\n\n',
];

describe("handler observability hooks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("fires lifecycle hooks with timing/frame/byte metadata (OBS-01)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({ chunks: MULTI_FRAME_CHUNKS })
      )
    );

    const requestCalls: any[] = [];
    const streamEndCalls: any[] = [];
    const fetchStartCalls: any[] = [];
    const fetchEndCalls: any[] = [];
    const streamStartCalls: any[] = [];

    const observability: ObservabilityHooks = {
      onRequest: (ctx) => {
        requestCalls.push(ctx);
      },
      onFetchStart: (ctx) => {
        fetchStartCalls.push(ctx);
      },
      onFetchEnd: (ctx) => {
        fetchEndCalls.push(ctx);
      },
      onStreamStart: (ctx) => {
        streamStartCalls.push(ctx);
      },
      onStreamEnd: (ctx) => {
        streamEndCalls.push(ctx);
      },
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability,
    });
    const response = await handler(makeRequest());
    const output = await drain(response);

    // onRequest fired with a sessionId string
    expect(requestCalls).toHaveLength(1);
    expect(typeof requestCalls[0].sessionId).toBe("string");
    expect(requestCalls[0].sessionId.length).toBeGreaterThan(0);

    expect(fetchStartCalls).toHaveLength(1);
    expect(fetchEndCalls).toHaveLength(1);
    expect(fetchEndCalls[0].status).toBe(200);
    expect(streamStartCalls).toHaveLength(1);
    expect(streamStartCalls[0].status).toBe(200);

    // onStreamEnd fired with numeric frameCount>0 and byteCount>0
    expect(streamEndCalls).toHaveLength(1);
    expect(streamEndCalls[0].success).toBe(true);
    expect(typeof streamEndCalls[0].frameCount).toBe("number");
    expect(streamEndCalls[0].frameCount).toBeGreaterThan(0);
    expect(typeof streamEndCalls[0].byteCount).toBe("number");
    expect(streamEndCalls[0].byteCount).toBeGreaterThan(0);
    expect(typeof streamEndCalls[0].durationMs).toBe("number");

    // Stream still produced all frames
    expect(output).toContain("hello");
    expect(output).toContain("world");
    expect(output).toContain('"type":"finish"');
  });

  it("a hook that throws on EVERY invocation does not abort the stream (OBS-02)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({ chunks: MULTI_FRAME_CHUNKS })
      )
    );
    // Silence the expected hook-failure logs.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const throwAlways = () => {
      throw new Error("hook always throws");
    };
    const observability: ObservabilityHooks = {
      onRequest: throwAlways,
      onFetchStart: throwAlways,
      onFetchEnd: throwAlways,
      onStreamStart: throwAlways,
      onStreamEnd: throwAlways,
      onError: throwAlways,
      onTransformBegin: throwAlways,
      onTransformEnd: throwAlways,
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability,
    });

    let response: any;
    await expect(
      (async () => {
        response = await handler(makeRequest());
      })()
    ).resolves.not.toThrow();

    const output = await drain(response);

    // All frames delivered, stream closed cleanly (no truncation, no escape).
    expect(output).toContain("hello");
    expect(output).toContain("world");
    expect(output).toContain('"type":"finish"');
    // Clean finish → no upstream_disconnect error frame injected.
    expect(output).not.toContain("upstream_disconnect");

    errSpy.mockRestore();
  });

  it("a hook that REJECTS (async) does not abort the stream (OBS-02)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({ chunks: MULTI_FRAME_CHUNKS })
      )
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const rejectAlways = async () => {
      throw new Error("async hook rejects");
    };
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability: {
        onRequest: rejectAlways,
        onStreamEnd: rejectAlways,
      },
    });
    const response = await handler(makeRequest());
    const output = await drain(response);

    expect(output).toContain("hello");
    expect(output).toContain('"type":"finish"');
    errSpy.mockRestore();
  });

  it("no hook receives a secret field (headers/token/body) (OBS-03 runtime)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({ chunks: MULTI_FRAME_CHUNKS })
      )
    );

    const allArgs: Record<string, unknown>[] = [];
    const capture = (ctx: Record<string, unknown>) => {
      allArgs.push(ctx);
    };
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability: {
        onRequest: capture as any,
        onFetchStart: capture as any,
        onFetchEnd: capture as any,
        onStreamStart: capture as any,
        onStreamEnd: capture as any,
      },
    });
    const response = await handler(
      makeRequest({
        headers: { authorization: "Bearer super-secret", cookie: "sid=abc" },
        body: "secret-body",
      })
    );
    await drain(response);

    const forbidden = [
      "headers",
      "authorization",
      "token",
      "cookie",
      "body",
      "request",
      "response",
      "raw",
    ];
    expect(allArgs.length).toBeGreaterThan(0);
    for (const ctx of allArgs) {
      const keys = Object.keys(ctx);
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
      // And no field value leaks the secret token/body.
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toContain("super-secret");
      expect(serialized).not.toContain("secret-body");
    }
  });

  it("fires onError on the fetch-failure path and still returns 502 (OBS-01)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorCalls: any[] = [];
    const fetchEndCalls: any[] = [];
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability: {
        onError: (ctx) => {
          errorCalls.push(ctx);
        },
        onFetchEnd: (ctx) => {
          fetchEndCalls.push(ctx);
        },
      },
    });
    const response = await handler(makeRequest());

    expect(response.status).toBe(502);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].type).toBe("fetch");
    expect(errorCalls[0].error).toBeInstanceOf(Error);
    // onFetchEnd fired on the catch path with error set.
    expect(fetchEndCalls).toHaveLength(1);
    expect(fetchEndCalls[0].error).toBeInstanceOf(Error);

    errSpy.mockRestore();
  });
});
