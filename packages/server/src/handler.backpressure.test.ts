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
import { createSseProxyHandler } from "./handler";
import type { SseProxyHandlerOptions } from "./handler";
import { coreDefaultAdapter } from "./core-test-adapters";

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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A backend body that produces `total` distinct frames, ending with a terminal
 * finish frame. Backpressure-aware: each frame is enqueued only when the
 * runtime calls `pull` (i.e. the downstream queue has room). `pulled` counts how
 * many frames the backend has actually handed out so far — the proxy for "how
 * far the upstream has raced ahead of the slow client".
 */
function makeCountingBackend(total: number) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const i = state.pulled;
      if (i >= total) {
        controller.close();
        return;
      }
      state.pulled++;
      const isLast = i === total - 1;
      const frame = isLast
        ? 'data: {"type":"finish"}\n\n'
        : `data: {"type":"text-delta","delta":"f${i}"}\n\n`;
      controller.enqueue(new TextEncoder().encode(frame));
    },
  });
  return { state, body };
}

function makeFetchFor(body: ReadableStream<Uint8Array>) {
  return vi.fn().mockResolvedValue({
    status: 200,
    headers: new Headers(),
    body,
  } as any);
}

describe("handler backpressure (RESIL-04)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("SLOW CONSUMER BOUNDED: the upstream does not race ahead of a slow client", async () => {
    const TOTAL = 100;
    const { state, body } = makeCountingBackend(TOTAL);
    vi.stubGlobal("fetch", makeFetchFor(body));

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const reader = response.body!.getReader();

    let read = 0;
    let maxGap = 0;
    const decoder = new TextDecoder();

    while (true) {
      // Slow consumer: yield between reads so the producer could, in principle,
      // race ahead if backpressure were not applied.
      await tick();
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        void decoder.decode(value, { stream: true });
        read++;
      }
      // In-flight gap = frames the backend has produced minus frames the client
      // has read. With Web-Streams backpressure this stays small/bounded — it
      // must NOT grow toward TOTAL.
      const gap = state.pulled - read;
      if (gap > maxGap) maxGap = gap;
    }

    // All frames eventually delivered.
    expect(read).toBe(TOTAL);
    expect(state.pulled).toBe(TOTAL);
    // The bounded-gap invariant (RESEARCH Pitfall 5): the upstream never buffers
    // a large multiple of frames ahead of the slow client. The gap is bounded by
    // a small constant (one backend read in flight + the stream's internal
    // queue), NOT proportional to TOTAL. A generous constant guards against
    // implementation noise while still failing loudly if backpressure regressed
    // to eager buffering (which would push maxGap toward TOTAL).
    expect(maxGap).toBeLessThan(TOTAL / 4);
  });

  it("CORRECTNESS PRESERVED: fast consumer receives all frames in order with the terminal frame", async () => {
    const TOTAL = 20;
    const { body } = makeCountingBackend(TOTAL);
    vi.stubGlobal("fetch", makeFetchFor(body));

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }

    // Order preserved: f0 before f1 before ... and terminal frame present.
    const idx0 = out.indexOf('"delta":"f0"');
    const idx1 = out.indexOf('"delta":"f1"');
    const idx18 = out.indexOf('"delta":"f18"');
    expect(idx0).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeGreaterThan(idx0);
    expect(idx18).toBeGreaterThan(idx1);
    expect(out).toContain('"type":"finish"');
    // No spurious truncation error on a clean finish.
    expect(out).not.toContain("upstream_disconnect");
  });

  it("CORRECTNESS PRESERVED: a truncated backend still emits the in-band upstream_disconnect error", async () => {
    // Backend produces two NON-terminal frames then closes (no finish frame).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"a"}\n\n'
          )
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"b"}\n\n'
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal("fetch", makeFetchFor(body));

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }

    // Frames delivered, then the in-band truncation error before close.
    expect(out).toContain('"delta":"a"');
    expect(out).toContain('"delta":"b"');
    expect(out).toContain("upstream_disconnect");
  });

  it("ADVERSARIAL: multiple frames in a single chunk all reach the client (no intra-chunk frame loss)", async () => {
    // Gap: handler.ts `pull()` returns after `if (frameCount > before) return;`.
    // If a future change moved the frameCount-check INSIDE emitFrames (or
    // short-circuited after the first frame per chunk to be more aggressive
    // about backpressure), the second and third frames in a multi-frame
    // chunk would be silently dropped — only the first would reach the client.
    // We verify: 3 frames delivered in ONE chunk ALL arrive at the client.
    const enc = new TextEncoder();
    const threeFramesInOneChunk =
      'data: {"type":"text-delta","delta":"a"}\n\n' +
      'data: {"type":"text-delta","delta":"b"}\n\n' +
      'data: {"type":"text-delta","delta":"c"}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(threeFramesInOneChunk));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", makeFetchFor(body));

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }

    // All three intra-chunk frames must arrive (invariant: no frame loss within
    // a single read chunk). Order is preserved.
    const ia = out.indexOf('"delta":"a"');
    const ib = out.indexOf('"delta":"b"');
    const ic = out.indexOf('"delta":"c"');
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThan(ia);
    expect(ic).toBeGreaterThan(ib);
  });

  it("ADVERSARIAL: consumer abandons the stream mid-burst (reader.cancel) — backend does NOT keep producing unbounded frames", async () => {
    // Gap: a client disconnecting mid-stream is the COMMON case (mobile
    // networks drop, users navigate away). The handler MUST propagate the
    // cancel upstream so the backend `pull` stops being invoked — otherwise
    // a slow/never-arriving backend accumulates frames in the TransformStream
    // queue, the backend's `pull` keeps firing on every microtask tick, and
    // we leak memory + CPU.
    //
    // We pin: after the client cancels, the backend's `pulled` counter
    // STOPS increasing — no more frames are demanded from upstream.
    const TOTAL = 10_000; // large number — would explode if pull kept firing
    const { state, body } = makeCountingBackend(TOTAL);
    vi.stubGlobal("fetch", makeFetchFor(body));

    const handler = createHandler({ backendUrl: "http://backend" });
    const response = await handler(makeRequest());
    const reader = response.body!.getReader();

    // Read ONE chunk then abandon — this simulates a tab close / navigation.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();
    const pulledAfterFirst = state.pulled;

    // Cancel the reader — simulates client disconnect.
    await reader.cancel();

    // Yield many times so any pending pull()s have a chance to fire.
    for (let i = 0; i < 50; i++) await tick();

    // After cancel, the backend's pull() must have stopped being invoked.
    // We allow a small constant for any frame already in flight (one chunk
    // worth) but it must NOT have raced to TOTAL.
    const pulledAfterCancel = state.pulled;
    expect(pulledAfterCancel).toBeLessThan(pulledAfterFirst + 10);
    // And critically: nowhere near the full TOTAL — backpressure worked.
    expect(pulledAfterCancel).toBeLessThan(TOTAL / 10);
  });
});
