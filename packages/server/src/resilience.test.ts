import { describe, it, expect } from "vitest";
import {
  checkRateLimit,
  checkCircuit,
  type RateLimitStore,
  type CircuitBreakerStore,
  type ResilienceConfig,
} from "./resilience";

/**
 * Test-only in-memory RateLimitStore. Map state lives INSIDE the instance, never
 * at module scope — each `new TestRateLimitStore()` is fully independent. This
 * mirrors RESEARCH Example 4 but proves the library carries zero global state:
 * the helper takes the store as a parameter, so two stores cannot interfere.
 */
class TestRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number>();
  constructor(private max: number) {}
  async check(key: string): Promise<boolean> {
    return (this.hits.get(key) ?? 0) < this.max;
  }
  async record(key: string, _windowMs: number): Promise<void> {
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
  }
}

/**
 * Test-only in-memory CircuitBreakerStore implementing the full state machine.
 * The LIBRARY only reads state (getState) and records outcomes (recordEvent) —
 * all transition logic lives here in the consumer store, per RESEARCH
 * "consumer-provided store with state machine".
 */
class TestCircuitBreakerStore implements CircuitBreakerStore {
  private failures = new Map<string, number>();
  private state = new Map<string, "closed" | "open" | "half-open">();
  private openedAt = new Map<string, number>();
  constructor(private threshold: number) {}

  async getState(key: string): Promise<"closed" | "open" | "half-open"> {
    const current = this.state.get(key) ?? "closed";
    if (current === "open") {
      const openedAt = this.openedAt.get(key) ?? 0;
      const resetAfter = this.resetAfterMs.get(key) ?? 0;
      if (resetAfter > 0 && Date.now() - openedAt >= resetAfter) {
        this.state.set(key, "half-open");
        return "half-open";
      }
    }
    return current;
  }

  private resetAfterMs = new Map<string, number>();

  async recordEvent(
    key: string,
    outcome: "success" | "failure",
    resetAfterMs?: number
  ): Promise<void> {
    if (resetAfterMs !== undefined) this.resetAfterMs.set(key, resetAfterMs);
    const current = this.state.get(key) ?? "closed";
    if (outcome === "failure") {
      const next = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, next);
      if (next >= this.threshold) {
        this.state.set(key, "open");
        this.openedAt.set(key, Date.now());
      }
    } else {
      // success
      if (current === "half-open") {
        this.state.set(key, "closed");
      }
      this.failures.set(key, 0);
    }
  }
}

describe("resilience helpers", () => {
  describe("checkRateLimit", () => {
    it("returns true while under the limit and false once over", async () => {
      const store = new TestRateLimitStore(2);
      expect(await checkRateLimit(store, "k")).toBe(true);
      await store.record("k", 60000);
      expect(await checkRateLimit(store, "k")).toBe(true);
      await store.record("k", 60000);
      expect(await checkRateLimit(store, "k")).toBe(false);
    });
  });

  describe("checkCircuit", () => {
    it("allows when closed and half-open, blocks when open", async () => {
      const store = new TestCircuitBreakerStore(2);
      const closed = await checkCircuit(store, "svc");
      expect(closed.allowed).toBe(true);
      expect(closed.state).toBe("closed");

      /*
       * A RESET WINDOW LONG ENOUGH THAT IT CANNOT FIRE DURING THIS TEST.
       *
       * This was 5ms. `getState` flips open → half-open as soon as
       * `Date.now() - openedAt >= resetAfter`, so any scheduling delay between
       * these lines and the assertion below — trivially reachable on a loaded
       * CI runner — turned `open` into `half-open` and `allowed` into true.
       * Observed twice in CI on unrelated PRs while passing 7/7 locally.
       *
       * This case owns the CLOSED and OPEN states; it has no claim about the
       * reset. The transition has its own test directly below, which keeps a
       * short window and sleeps PAST it — that one is safe in the other
       * direction, because a slow runner only makes more time elapse.
       *
       * Not a longer sleep and not a retry: the race is removed rather than
       * outrun.
       */
      await store.recordEvent("svc", "failure", 60_000);
      await store.recordEvent("svc", "failure", 60_000);
      const open = await checkCircuit(store, "svc");
      expect(open.allowed).toBe(false);
      expect(open.state).toBe("open");
    });

    it("transitions open → half-open after resetAfterMs, then success → closed", async () => {
      const store = new TestCircuitBreakerStore(1);
      await store.recordEvent("svc", "failure", 10);
      expect((await checkCircuit(store, "svc")).state).toBe("open");

      // wait past the reset window
      await new Promise((r) => setTimeout(r, 15));
      const halfOpen = await checkCircuit(store, "svc");
      expect(halfOpen.state).toBe("half-open");
      expect(halfOpen.allowed).toBe(true);

      await store.recordEvent("svc", "success");
      expect((await checkCircuit(store, "svc")).state).toBe("closed");
    });
  });

  describe("isolation (RESIL-05)", () => {
    it("two independent rate-limit stores never affect each other", async () => {
      const a = new TestRateLimitStore(1);
      const b = new TestRateLimitStore(1);
      await a.record("shared", 60000);
      // a is now at its limit; b has never been touched
      expect(await checkRateLimit(a, "shared")).toBe(false);
      expect(await checkRateLimit(b, "shared")).toBe(true);
    });

    it("two independent breaker stores never affect each other", async () => {
      const a = new TestCircuitBreakerStore(1);
      const b = new TestCircuitBreakerStore(1);
      await a.recordEvent("svc", "failure", 100);
      expect((await checkCircuit(a, "svc")).state).toBe("open");
      expect((await checkCircuit(b, "svc")).state).toBe("closed");
    });

    it("helpers carry no default global store — distinct keys are independent in one store", async () => {
      const store = new TestRateLimitStore(1);
      await store.record("user-1", 60000);
      // user-1 is over, user-2 is untouched within the same store
      expect(await checkRateLimit(store, "user-1")).toBe(false);
      expect(await checkRateLimit(store, "user-2")).toBe(true);
    });
  });

  describe("ResilienceConfig type", () => {
    it("accepts a fully-populated config", () => {
      const cfg: ResilienceConfig = {
        rateLimitStore: new TestRateLimitStore(1),
        rateLimitKey: () => "k",
        rateLimitWindowMs: 60000,
        rateLimitMax: 10,
        circuitBreakerStore: new TestCircuitBreakerStore(1),
        circuitBreakerKey: () => "svc",
        circuitBreakerFailureThreshold: 5,
        circuitBreakerResetMs: 30000,
        timeoutMs: 10000,
      };
      expect(cfg.rateLimitMax).toBe(10);
      expect(cfg.timeoutMs).toBe(10000);
    });
  });
});
