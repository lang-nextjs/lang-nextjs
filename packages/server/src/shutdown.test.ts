import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "./shutdown";
import { createReadinessProbe } from "./health";

afterEach(() => {
  // Never leave signal listeners installed (opt-in, per-instance contract).
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createGracefulShutdown — initial state", () => {
  it("starts not draining with zero active streams", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    expect(s.isDraining()).toBe(false);
    expect(s.activeCount()).toBe(0);
  });
});

describe("createGracefulShutdown — stream tracking", () => {
  it("trackStream increments activeCount", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    s.trackStream("a");
    s.trackStream("b");
    expect(s.activeCount()).toBe(2);
  });

  it("releaseStream decrements activeCount", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    s.trackStream("a");
    s.releaseStream("a");
    expect(s.activeCount()).toBe(0);
  });

  it("dedupes via Set semantics — tracking the same id twice counts once", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    s.trackStream("a");
    s.trackStream("a");
    expect(s.activeCount()).toBe(1);
  });

  it("releasing an unknown id is a no-op", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    s.releaseStream("nope");
    expect(s.activeCount()).toBe(0);
  });

  it("keeps state per-instance — two orchestrators do not share streams", () => {
    const a = createGracefulShutdown({ onExit: vi.fn() });
    const b = createGracefulShutdown({ onExit: vi.fn() });
    a.trackStream("x");
    expect(a.activeCount()).toBe(1);
    expect(b.activeCount()).toBe(0);
    expect(b.isDraining()).toBe(false);
  });
});

describe("createGracefulShutdown — dispose with no active streams", () => {
  it("flips isDraining true and calls onExit(0) promptly", async () => {
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit, drainTimeoutMs: 30000 });
    await s.dispose();
    expect(s.isDraining()).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe("createGracefulShutdown — dispose drains then exits 0", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("waits while streams active, exits 0 once they release", async () => {
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit, drainTimeoutMs: 1000 });
    s.trackStream("a");

    const disposed = s.dispose();
    // draining flips immediately even before exit
    expect(s.isDraining()).toBe(true);

    // not exited yet — stream still active
    await vi.advanceTimersByTimeAsync(200);
    expect(onExit).not.toHaveBeenCalled();

    // release mid-wait, then advance past the next poll
    s.releaseStream("a");
    await vi.advanceTimersByTimeAsync(200);

    await disposed;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe("createGracefulShutdown — safety timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("force-exits with code 1 when a stream never releases", async () => {
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit, drainTimeoutMs: 50 });
    s.trackStream("stuck");

    const disposed = s.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await disposed;

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("respects a configurable drainTimeoutMs", async () => {
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit, drainTimeoutMs: 500 });
    s.trackStream("stuck");

    const disposed = s.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(onExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await disposed;
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe("createGracefulShutdown — idempotency", () => {
  it("ignores a second dispose call — onExit invoked exactly once", async () => {
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit });
    await s.dispose();
    await s.dispose();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe("createGracefulShutdown — readiness integration (OPS-01)", () => {
  it("createReadinessProbe is ok before dispose and draining after", async () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });

    const before = await createReadinessProbe({
      isDraining: () => s.isDraining(),
    });
    expect(before.ready).toBe(true);
    expect(before.status).toBe("ok");

    await s.dispose();

    const after = await createReadinessProbe({
      isDraining: () => s.isDraining(),
    });
    expect(after.ready).toBe(false);
    expect(after.status).toBe("draining");
  });
});

describe("createGracefulShutdown — installSignalHandlers", () => {
  it("registers a SIGTERM listener and the uninstall fn removes it", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    const before = process.listenerCount("SIGTERM");

    const uninstall = s.installSignalHandlers();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("registers a SIGINT listener and the uninstall fn removes it", () => {
    const s = createGracefulShutdown({ onExit: vi.fn() });
    const before = process.listenerCount("SIGINT");

    const uninstall = s.installSignalHandlers();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);

    uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does NOT register any signal listener merely on factory creation", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    createGracefulShutdown({ onExit: vi.fn() });
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });

  it("ADVERSARIAL: SIGTERM followed by SIGINT (two distinct signals) — onExit invoked exactly once, draining is idempotent", async () => {
    // Gap: the existing idempotency test only covers calling dispose() twice
    // directly. A REAL orchestrator receives TWO distinct signals back-to-back
    // in production: e.g., a SIGTERM from k8s followed almost immediately by
    // a SIGINT from an operator Ctrl-C, or two SIGTERMs racing across
    // supervisor reloads. The handler uses `process.once` (single-fire
    // listeners) per the module docstring, so the SECOND signal should NOT
    // re-trigger dispose(). We verify: after installSignalHandlers(), emitting
    // SIGTERM then SIGINT results in onExit called exactly once with code 0.
    vi.useFakeTimers();
    const onExit = vi.fn();
    const s = createGracefulShutdown({ onExit, drainTimeoutMs: 1000 });
    const uninstall = s.installSignalHandlers();

    // Emit SIGTERM — handler fires once, dispose() begins.
    process.emit("SIGTERM");
    // Advance so dispose() settles (no streams active, exits 0).
    await vi.advanceTimersByTimeAsync(100);

    // Emit SIGINT — the SIGINT listener is `process.once`, so it should have
    // already removed itself after firing on the FIRST signal? No — SIGTERM
    // and SIGINT use INDEPENDENT once-listeners. But by the time SIGINT
    // fires, dispose() has already flipped `disposed = true` and will no-op.
    // The contract we pin: onExit is called exactly once total.
    process.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(100);

    // dispose() is idempotent regardless of which signal triggered it.
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
    // isDraining should remain true after the second signal — no flip-back.
    expect(s.isDraining()).toBe(true);

    uninstall();
  });
});
