/**
 * OPS-05 Flow 3 E2E — SIGTERM/dispose drains an in-flight stream.
 *
 * This is a Node-only Vitest integration test, NOT a Playwright browser test:
 * SIGTERM does not fire in a browser, so a browser harness is the wrong tool
 * (20-RESEARCH.md Flow 3). Exit is asserted via the injectable `onExit` spy —
 * the real `process.exit` is NEVER called (20-RESEARCH.md Pitfall 5). Fake
 * timers drive the drain poll + safety deadline deterministically.
 *
 * What this proves beyond shutdown.test.ts: it ties Phase 18 readiness +
 * Phase 19 shutdown together end-to-end — the readiness probe flips from
 * ok → draining the moment dispose() begins, while a tracked in-flight stream
 * is drained before exit 0; a hung stream force-exits 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "./shutdown";
import { createReadinessProbe } from "./health";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OPS-05 Flow 3: SIGTERM/dispose drains an in-flight stream (E2E)", () => {
  it("clean drain: readiness flips ok→draining, in-flight stream drains, exit 0", async () => {
    const onExit = vi.fn();
    const shutdown = createGracefulShutdown({ drainTimeoutMs: 5000, onExit });
    const isDraining = () => shutdown.isDraining();

    // BEFORE shutdown: readiness reports ready/ok and the LB routes traffic.
    const before = await createReadinessProbe({ isDraining });
    expect(before.ready).toBe(true);
    expect(before.status).toBe("ok");

    // An in-flight SSE stream is tracked (as the handler would on connect).
    shutdown.trackStream("stream-1");
    expect(shutdown.activeCount()).toBe(1);

    // SIGTERM arrives → begin graceful shutdown.
    const disposePromise = shutdown.dispose();
    expect(shutdown.isDraining()).toBe(true);

    // Readiness has flipped to draining (503-equivalent) so the LB stops
    // routing new traffic while the in-flight stream finishes.
    const during = await createReadinessProbe({ isDraining });
    expect(during.ready).toBe(false);
    expect(during.status).toBe("draining");

    // The in-flight stream finishes and is released; drain poll observes it.
    shutdown.releaseStream("stream-1");
    await vi.advanceTimersByTimeAsync(200);
    await disposePromise;

    expect(shutdown.activeCount()).toBe(0);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("hung stream: never drains → force-exit 1 after the safety deadline", async () => {
    const onExit = vi.fn();
    const shutdown = createGracefulShutdown({ drainTimeoutMs: 500, onExit });

    shutdown.trackStream("hung"); // never released
    const disposePromise = shutdown.dispose();
    expect(shutdown.isDraining()).toBe(true);

    // Advance past the safety deadline — the stream never drained.
    await vi.advanceTimersByTimeAsync(700);
    await disposePromise;

    expect(shutdown.activeCount()).toBe(1); // still hung
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
