import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { createSseProxyHandler } from "./handler";
import type { SseProxyHandlerOptions } from "./handler";
import { coreDefaultAdapter } from "./core-test-adapters";
import type { ObservabilityHooks } from "./observability";

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

// A clean backend that ends with a terminal finish frame.
const CLEAN_CHUNKS = [
  'data: {"type":"text-delta","delta":"hi"}\n\n',
  'data: {"type":"finish"}\n\n',
];

function makeFetchResponse(opts: { status?: number; chunks?: string[] } = {}) {
  const encodedChunks = (opts.chunks ?? CLEAN_CHUNKS).map((c) =>
    new TextEncoder().encode(c)
  );
  const stream = new ReadableStream({
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

/**
 * Build a fetch mock whose body stalls forever on read() until the request's
 * AbortSignal fires, at which point read() rejects with an AbortError — exactly
 * how a real upstream behaves when the per-request timeout aborts it. Captures
 * the AbortSignal handed to fetch so the test can assert on it.
 */
function makeStallingFetch() {
  const captured: { signal?: AbortSignal } = {};
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal | undefined;
    captured.signal = signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit one non-terminal frame so the stream "starts", then stall.
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"x"}\n\n'
          )
        );
      },
      pull() {
        // Stall forever; resolve only when aborted, then error the stream so
        // the handler's reader.read() rejects (AbortError) → mid-stream catch.
        return new Promise<void>((_resolve, reject) => {
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          }
          // never resolves otherwise
        });
      },
    });
    return Promise.resolve({
      status: 200,
      headers: new Headers(),
      body,
    } as any);
  });
  return { fetchMock, captured };
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

describe("handler resource cleanup (RESIL-01)", () => {
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
    clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
  });

  afterEach(() => {
    clearTimeoutSpy.mockRestore();
  });

  it("clears the timer and aborts the controller on a CLEAN finish", async () => {
    const { fetchMock, captured } = (() => {
      const cap: { signal?: AbortSignal } = {};
      const fm = vi.fn((_url: string, init: RequestInit) => {
        cap.signal = (init.signal as AbortSignal) ?? undefined;
        return Promise.resolve(makeFetchResponse());
      });
      return { fetchMock: fm, captured: cap };
    })();
    vi.stubGlobal("fetch", fetchMock);

    const handler = createHandler({
      backendUrl: "http://backend",
      resilience: { timeoutMs: 5000 },
    });
    const response = await handler(makeRequest());
    const output = await drain(response);

    // Stream completed cleanly with the terminal frame.
    expect(output).toContain('"type":"finish"');
    // Timer cleared in finally — no dangling timer.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    // Controller aborted in finally — upstream socket released.
    expect(captured.signal?.aborted).toBe(true);
  });

  it("does NOT set a timer when timeoutMs is unset (no clearTimeout for a timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse()));
    // Track setTimeout calls that look like the request-timeout (the handler
    // only calls setTimeout for the timeout layer; retry delays don't run here).
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    await drain(response);

    // No resilience.timeoutMs → no timeout setTimeout call.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("fires the timeout → aborts upstream, fires onError, emits in-band error frame, closes", async () => {
    const { fetchMock, captured } = makeStallingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const errorCalls: any[] = [];
    const observability: ObservabilityHooks = {
      onError: (ctx) => {
        errorCalls.push(ctx);
      },
    };

    const handler = createHandler({
      backendUrl: "http://backend",
      observability,
      // Tiny timeout so it fires quickly under real timers.
      resilience: { timeoutMs: 10 },
    });

    const response = await handler(makeRequest());
    const output = await drain(response);

    // The timeout aborted the upstream connection.
    expect(captured.signal?.aborted).toBe(true);
    // onError fired with the stream type (abort surfaced mid-stream).
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].type).toBe("stream");
    // In-band error frame delivered to the client, then stream closed cleanly.
    expect(output).toContain("upstream_disconnect");
    // Timer cleared in finally even though it had already fired.
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("clears the timer when the fetch itself throws (timer never outlives a failed fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      resilience: { timeoutMs: 5000 },
    });
    const response = await handler(makeRequest());

    expect(response.status).toBe(502);
    // Timer cleared on the fetch-failure catch path.
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  /**
   * RESIL-01 FD-leak gate (unit proxy). Real FD/lsof counting is not feasible in
   * the unit harness, so we assert the resource-cleanup INVARIANT at scale: run
   * N handler invocations that each abort mid-stream (via the per-request
   * timeout) and assert that for EVERY invocation the timer was cleared and the
   * controller aborted — i.e. no exit path leaves a timer/controller dangling.
   *
   * This is the unit-level proxy for the lsof FD-stability gate from RESEARCH
   * Pitfall 6; the real-process lsof / 1000-abort stress test belongs to the
   * Phase 20 E2E (OPS-05).
   */
  it("REPEATED ABORTS / NO-LEAK PROXY: every aborted invocation clears its timer and aborts its controller", async () => {
    const N = 200;
    const signals: (AbortSignal | undefined)[] = [];
    clearTimeoutSpy.mockClear();

    for (let i = 0; i < N; i++) {
      const { fetchMock, captured } = makeStallingFetch();
      vi.stubGlobal("fetch", fetchMock);

      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { timeoutMs: 5 },
      });
      const response = await handler(makeRequest());
      await drain(response);
      signals.push(captured.signal);
    }

    // Every one of the N invocations aborted its controller — no leaked socket.
    expect(signals).toHaveLength(N);
    for (const sig of signals) {
      expect(sig?.aborted).toBe(true);
    }
    // clearTimeout called at least once per invocation — no dangling timers.
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(N);
  });

  it("ADVERSARIAL: client cancel mid-stream fires onStreamEnd via finalize() — observability invariant on client-disconnect path", async () => {
    // Gap: handler.ts `cancel()` handler is documented to call `finalize()`
    // so observability + breaker outcomes fire on EVERY exit path. The existing
    // tests cover onStreamEnd on clean-finish and on mid-stream-error, but NONE
    // assert that `cancel()` (client-disconnect mid-stream) runs finalize().
    // If a future change moves `finalize()` out of `cancel()`, observability
    // metrics (frameCount, durationMs) would be lost AND the upstream socket
    // would never be released — a measurable regression in production telemetry
    // and FD accounting. We cancel after the first read and assert onStreamEnd fired.
    const onStreamEndCalls: Array<Record<string, unknown>> = [];
    const observability: ObservabilityHooks = {
      onStreamEnd: (ctx) => {
        onStreamEndCalls.push(ctx as unknown as Record<string, unknown>);
      },
    };

    const enc = new TextEncoder();
    const captured: { signal?: AbortSignal } = {};
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      captured.signal = (init.signal as AbortSignal) ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode('data: {"type":"text-delta","delta":"x"}\n\n')
          );
          // Stalls forever; will only resolve when aborted by cancel path
        },
        pull() {
          return new Promise<void>((_resolve, reject) => {
            if (captured.signal) {
              if (captured.signal.aborted) {
                reject(new DOMException("aborted", "AbortError"));
                return;
              }
              captured.signal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true }
              );
            }
          });
        },
      });
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body,
      } as any);
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createHandler({
      backendUrl: "http://backend",
      observability,
      resilience: { timeoutMs: 5000 },
    });
    const response = await handler(makeRequest());
    const reader = response.body!.getReader();
    // Read the first frame so the streaming loop is actively pulling
    await reader.read();
    // Client cancels — simulates browser navigation away
    await reader.cancel();

    // finalize() must have run via cancel(). Allow a microtask for it.
    await new Promise((r) => setTimeout(r, 0));

    // onStreamEnd fired exactly once via cancel (not 0, not 2)
    expect(onStreamEndCalls).toHaveLength(1);
    // The cancel path is not a "success" — sawTerminalFrame never became true
    expect(onStreamEndCalls[0].success).toBe(false);
    // Timer was cleared by finalize() inside cancel handler
    expect(clearTimeoutSpy).toHaveBeenCalled();
    // Upstream socket released
    expect(captured.signal?.aborted).toBe(true);
  });
});
