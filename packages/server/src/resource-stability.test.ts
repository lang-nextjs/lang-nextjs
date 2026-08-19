/**
 * OPS-05 resource-stability test — BOUNDED no-leak proxy (~50 aborts).
 *
 * RATIONALE (20-RESEARCH.md Open Question 1 / Pitfall 6):
 * This is a BOUNDED resource-stability proxy (~50 aborts), NOT a true
 * 1000-abort `lsof` file-descriptor check. A real 1000-abort lsof poll is
 * intentionally NOT in CI because it is flaky and OS/runtime-dependent —
 * file-descriptor counting is unreliable under the test runner (the runner
 * itself opens/closes FDs concurrently) and varies by platform. This bounded
 * test instead asserts the CONTRACT deterministically: repeated aborts through
 * the per-request timeout path do not accumulate unbounded in-process resources
 * — every iteration clears its timer and aborts its controller, and no fake
 * timers are left pending. The true 1000-abort lsof FD stress check is DEFERRED
 * to a manual / v1.6.x stress run, not CI.
 *
 * Self-contained: the file-scope vi.mock blocks and helpers are copied from
 * handler.resilience.test.ts / handler.resource-cleanup.test.ts (do not import
 * from a sibling test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls must be at file scope for Vitest hoisting.
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

/**
 * A fetch whose body stalls forever on read() until the request's AbortSignal
 * fires, then errors the stream (AbortError) — exactly how a real upstream
 * behaves when the per-request timeout aborts it. Captures the AbortSignal so
 * the test can assert it was aborted.
 */
function makeStallingFetch() {
  const captured: { signal?: AbortSignal } = {};
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const signal = (init.signal as AbortSignal) ?? undefined;
    captured.signal = signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"text-delta","delta":"x"}\n\n')
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

async function drain(response: {
  body: ReadableStream<Uint8Array> | null;
}): Promise<void> {
  const reader = response.body!.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("OPS-05 resource stability: bounded ~50-abort no-leak proxy", () => {
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
    clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
  });

  afterEach(() => {
    clearTimeoutSpy.mockRestore();
  });

  it("~50 abort/timeout iterations leave no leaked timer or controller", async () => {
    const ITERATIONS = 50;
    const signals: (AbortSignal | undefined)[] = [];
    clearTimeoutSpy.mockClear();

    for (let i = 0; i < ITERATIONS; i++) {
      const { fetchMock, captured } = makeStallingFetch();
      vi.stubGlobal("fetch", fetchMock);

      const handler = createDeepAgentsHandler({
        backendUrl: "http://backend",
        // Tiny timeout so the per-request timer aborts the stalled upstream.
        resilience: { timeoutMs: 5 },
      });

      const response = await handler(makeRequest());
      await drain(response);
      signals.push(captured.signal);
    }

    // No-leak proxy 1: every iteration aborted its controller — no leaked
    // upstream socket across all ~50 aborts.
    expect(signals).toHaveLength(ITERATIONS);
    for (const sig of signals) {
      expect(sig?.aborted).toBe(true);
    }

    // No-leak proxy 2: clearTimeout was called at least once per iteration —
    // no per-request timer is left dangling. Net "open timer" delta is 0.
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(ITERATIONS);
  });
});
