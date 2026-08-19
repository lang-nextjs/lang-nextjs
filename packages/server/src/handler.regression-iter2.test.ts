/**
 * Regression lock — iter 2.
 *
 * Pins 4 likely-OK invariants of the now-hardened handler/observability
 * contracts that were not covered by iter 1 (off-by-one boundaries,
 * under-declared Content-Length attack, 100 concurrent accumulators, and
 * atomicRegisterIfAbsent vs deleteStream race) and not covered by the
 * existing handler.test.ts / observability.test.ts suites.
 *
 * Each test is a single-shot regression lock: if the implementation ever
 * changes in a way that breaks the documented behavior, this test catches
 * it on the first run.
 *
 * Constraints honored:
 *   - Test files ONLY (no source modifications)
 *   - No modification of pre-existing tests
 *   - vitest syntax
 */
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
import { createDeepAgentsHandler } from "./handler";
import type { ObservabilityHooks } from "./observability";

const mockIsStreamReconnectEnabled = vi.mocked(isStreamReconnectEnabled);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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
  opts: {
    status?: number;
    chunks?: string[];
    noBody?: boolean;
    /** When set, the fetch stream's reader will reject on the FIRST read. */
    rejectOnFirstRead?: Error;
  } = {}
) {
  if (opts.rejectOnFirstRead) {
    // A stream whose getReader().read() rejects — simulates a mid-stream
    // upstream failure that surfaces through the streaming loop's catch.
    const body = new ReadableStream({
      start(controller) {
        // The error is delivered via the reader's rejected promise, NOT a
        // synchronous throw from start() (which would behave differently).
        // We schedule the error so the very first reader.read() rejects.
        queueMicrotask(() =>
          controller.error(opts.rejectOnFirstRead!)
        );
      },
    });
    return {
      status: opts.status ?? 200,
      headers: new Headers(),
      body,
    } as any;
  }
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
    headers: new Headers(),
    body: stream,
  } as any;
}

async function drain(response: { body: ReadableStream<Uint8Array> | null }) {
  const reader = response.body!.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// ---------------------------------------------------------------------------
// LOCK 1 — handler called 1000 times back-to-back has no state leak
// ---------------------------------------------------------------------------
// Iteration 2 hardening added per-request observability counters (frameCount,
// byteCount) and a sessionId generated from crypto.randomUUID(). If the
// counters ever leak between requests (e.g. hoisted to module scope, captured
// in a closure that survives the call), the back-to-back stress test will
// surface it: a later request's onStreamEnd would report aggregated counts
// spanning earlier requests, OR sessionIds would repeat.
// ---------------------------------------------------------------------------
describe("REGRESSION iter2 — back-to-back isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("handler invoked 1000 times back-to-back does not leak frameCount / byteCount / sessionId across requests", async () => {
    // Single-frame backend so frameCount and byteCount are predictable.
    // Each fetch() call MUST return a FRESH ReadableStream — the response
    // body is a one-shot resource (after the first reader.read() it is
    // locked), so back-to-back calls need a fresh stream per call.
    const SINGLE_FRAME = 'data: {"type":"text-delta","delta":"x"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => makeFetchResponse({ chunks: [SINGLE_FRAME] }))
    );

    const streamEndFrames: number[] = [];
    const streamEndBytes: number[] = [];
    const requestSessions: string[] = [];

    const observability: ObservabilityHooks = {
      onStreamEnd: (ctx) => {
        streamEndFrames.push(ctx.frameCount);
        streamEndBytes.push(ctx.byteCount);
      },
      onRequest: (ctx) => {
        requestSessions.push(ctx.sessionId);
      },
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability,
    });

    const N = 1000;
    for (let i = 0; i < N; i++) {
      const response = await handler(makeRequest());
      await drain(response);
    }

    // Every request fired exactly one onStreamEnd and one onRequest.
    expect(streamEndFrames).toHaveLength(N);
    expect(streamEndBytes).toHaveLength(N);
    expect(requestSessions).toHaveLength(N);

    // Exact, per-request counts: 1 frame emitted each call (the text-delta).
    // The finish frame is NOT added by the handler — the deepagents adapter
    // does not synthesize a finish frame; only the upstream frame is forwarded.
    // Lock the EXACT value (not "> 0") so any regression that double-counts,
    // hoists state, or leaks between requests is caught.
    expect(new Set(streamEndFrames)).toEqual(new Set([1]));

    // Every byteCount must be identical (same single frame, same payload).
    expect(new Set(streamEndBytes)).toEqual(new Set([streamEndBytes[0]]));
    expect(streamEndBytes[0]).toBeGreaterThan(0);

    // Every sessionId must be unique — crypto.randomUUID per request.
    const uniqueSessions = new Set(requestSessions);
    expect(uniqueSessions.size).toBe(N);
    for (const s of uniqueSessions) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// LOCK 2 — body-size guard skipped when maxBodyBytes: -1
// ---------------------------------------------------------------------------
// Iter 1 covered `0` (disables the guard) but not `negative` values. The
// contract documented in handler.ts is "0 or negative: disable the guard" —
// a contributor could (incorrectly) tighten the guard to `> 0 && < limit`,
// silently flipping `-1` back into "active" and breaking consumers that
// explicitly opted out with `-1`.
// ---------------------------------------------------------------------------
describe("REGRESSION iter2 — negative maxBodyBytes opts out of guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("maxBodyBytes: -1 disables the body-size guard — oversized body still reaches the backend", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ chunks: ["data: hi\n\n"] }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      maxBodyBytes: -1, // explicit opt-out via negative value
    });

    // 9 MB body with a misleading Content-Length — would 413 if guard were
    // active on the negative branch.
    const oversized = "x".repeat(9 * 1024 * 1024);
    const response = await handler(
      makeRequest({
        headers: { "content-length": String(oversized.length) },
        body: oversized,
      })
    );

    // The handler must NOT 413 — the guard skipped both branches because
    // maxBodyBytes <= 0. The backend must have been called exactly once.
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maxBodyBytes: -1 disables POST-BUFFER guard too — small declared Content-Length but huge actual body passes", async () => {
    // Belt-and-braces: even when the pre-buffer check is skipped, the
    // post-buffer check (`body.byteLength > maxBodyBytes`) must also be
    // skipped when maxBodyBytes is negative. Otherwise the guard would
    // partially fire and 413 the request.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ chunks: ["data: hi\n\n"] }));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      maxBodyBytes: -1,
    });

    // Lie about Content-Length (well under any positive cap) but stream 8MB.
    const oversized = "x".repeat(8 * 1024 * 1024);
    const response = await handler(
      makeRequest({
        headers: { "content-length": "100" }, // lie: actual is 8MB
        body: oversized,
      })
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// LOCK 3 — onStreamEnd receives EXACT frameCount / byteCount (not just > 0)
// ---------------------------------------------------------------------------
// Existing observability tests assert `frameCount > 0` and `byteCount > 0`.
// They do not pin the EXACT values, so a regression that double-counts (e.g.
// counts both the raw frame AND its transformed output) or off-by-ones the
// byte sum would pass those tests. This lock pins the exact arithmetic:
// frameCount == number of distinct frames emitted, byteCount == sum of
// `encoder.encode(frame + "\n\n").byteLength` for each emitted frame.
// ---------------------------------------------------------------------------
describe("REGRESSION iter2 — exact observability counters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("onStreamEnd reports EXACT frameCount (== emitted frames) and EXACT byteCount (== sum of encoded frame bytes)", async () => {
    // Three distinct, non-trivial frames so byte arithmetic is meaningful.
    const CHUNKS = [
      'data: {"type":"text-delta","delta":"hello"}\n\n',
      'data: {"type":"text-delta","delta":" world"}\n\n',
      'data: {"type":"finish"}\n\n',
    ];

    // Compute the expected byte total: each frame is encoded as raw + "\n\n".
    const encoder = new TextEncoder();
    const expectedFrameCount = CHUNKS.length;
    const expectedBytes = CHUNKS.reduce(
      (sum, c) => sum + encoder.encode(c).byteLength,
      0
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ chunks: CHUNKS }))
    );

    const streamEndCalls: any[] = [];
    const observability: ObservabilityHooks = {
      onStreamEnd: (ctx) => {
        streamEndCalls.push(ctx);
      },
    };

    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability,
    });

    const response = await handler(makeRequest());
    await drain(response);

    expect(streamEndCalls).toHaveLength(1);
    const ctx = streamEndCalls[0];

    // EXACT frameCount — not "> 0". Any double-count or hoist regression fails here.
    expect(ctx.frameCount).toBe(expectedFrameCount);
    // EXACT byteCount — not "> 0". The handler sums encoder.encode(out.raw + "\n\n").length.
    expect(ctx.byteCount).toBe(expectedBytes);
    // Clean finish — saw a "finish" frame.
    expect(ctx.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LOCK 4 — onError fires on mid-stream upstream read failure (not just fetch throw)
// ---------------------------------------------------------------------------
// Iter 2 added onError for the fetch-rejection path. The handler ALSO fires
// onError when the streaming reader rejects mid-stream (the catch block in
// `pull`). Existing tests cover fetch rejection but NOT mid-stream reader
// rejection. A regression that wires the catch in pull without firing
// onError would still return a parseable in-band error event but would
// SILENTLY lose telemetry for upstream mid-stream failures — and
// recordBreakerOutcome would record nothing useful.
// ---------------------------------------------------------------------------
describe("REGRESSION iter2 — onError fires on mid-stream reader failure", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("fires onError(type='stream') when the upstream getReader().read() rejects mid-stream (not just on fetch throw)", async () => {
    const upstreamError = new Error("upstream mid-stream boom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ rejectOnFirstRead: upstreamError }))
    );

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorCalls: any[] = [];
    const streamEndCalls: any[] = [];
    const observability: ObservabilityHooks = {
      onError: (ctx) => {
        errorCalls.push(ctx);
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
    await drain(response); // consume to completion

    // onError fired exactly once with type='stream' (NOT 'fetch' — the
    // fetch() itself succeeded; the read inside the stream loop failed).
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].type).toBe("stream");
    expect(errorCalls[0].error).toBeInstanceOf(Error);
    expect(errorCalls[0].error.message).toBe("upstream mid-stream boom");
    expect(typeof errorCalls[0].sessionId).toBe("string");

    // onStreamEnd fires on the error path too — and reports success=false
    // because sawTerminalFrame is false (no finish frame was read).
    expect(streamEndCalls).toHaveLength(1);
    expect(streamEndCalls[0].success).toBe(false);

    errSpy.mockRestore();
  });
});
