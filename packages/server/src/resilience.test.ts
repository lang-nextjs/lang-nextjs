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
 * A CLOCK THE TEST OWNS, so the breaker's reset window is crossed by an
 * instruction rather than by elapsed wall time (#390).
 *
 * Note what is NOT injected: `resilience.ts` reads no clock at all. It defines
 * `CircuitBreakerStore` as an interface and leaves every transition to the
 * implementor, so the entire race lived in this file's own fake store. The fix
 * needs no production change and adds no production API — worth stating,
 * because #390 proposed making "the breaker's clock" injectable and there is
 * no such clock to inject.
 *
 * `now` is a bound arrow property, not a method, so `new TestCircuitBreakerStore
 * (n, clock.now)` carries its receiver. A method would silently read `undefined`.
 */
class TestClock {
  constructor(private t = 1_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
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
  // Defaulted, so the stores that never reason about time construct unchanged.
  constructor(
    private threshold: number,
    private now: () => number = Date.now
  ) {}

  async getState(key: string): Promise<"closed" | "open" | "half-open"> {
    const current = this.state.get(key) ?? "closed";
    if (current === "open") {
      const openedAt = this.openedAt.get(key) ?? 0;
      const resetAfter = this.resetAfterMs.get(key) ?? 0;
      if (resetAfter > 0 && this.now() - openedAt >= resetAfter) {
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
        this.openedAt.set(key, this.now());
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
      const clock = new TestClock();
      const store = new TestCircuitBreakerStore(2, clock.now);
      const closed = await checkCircuit(store, "svc");
      expect(closed.allowed).toBe(true);
      expect(closed.state).toBe("closed");

      /*
       * THE WINDOW IS SHORT AND THE CLOCK SIMPLY DOES NOT MOVE (#390).
       *
       * This was 5ms, failed in CI, and was fixed by widening it to 60_000 —
       * a window "long enough that it cannot fire during this test". That
       * worked, but it bought determinism with an assumption about how slow a
       * runner can get, and it left the shape for the next case to copy.
       *
       * THE RATIONALE THAT WIDENING CARRIED WAS WRONG, which is why the next
       * case kept failing. It said the transition test below "sleeps PAST" its
       * window and so is "safe in the other direction, because a slow runner
       * only makes more time elapse". That describes the sleep, not the test:
       * the assertion BEFORE the sleep required `open` within 10ms of the
       * failure being recorded, and a slow runner is fatal to it. #390 is that
       * assertion, at this file's line 124, failing on a PR whose entire diff
       * was one comment line in an e2e spec.
       *
       * A window that cannot elapse is now cheap to state exactly: never call
       * `clock.advance`. The 60s figure carried no meaning beyond "surely more
       * than a test takes", and that is a guess about hardware.
       */
      await store.recordEvent("svc", "failure", 10);
      await store.recordEvent("svc", "failure", 10);
      const open = await checkCircuit(store, "svc");
      expect(open.allowed).toBe(false);
      expect(open.state).toBe("open");
    });

    it("transitions open → half-open after resetAfterMs, then success → closed", async () => {
      const clock = new TestClock();
      const store = new TestCircuitBreakerStore(1, clock.now);
      await store.recordEvent("svc", "failure", 10);

      // ONE MILLISECOND SHORT of the window: still open. This is the assertion
      // #390 reported failing, and it now states its own precondition instead
      // of inheriting it from whatever the scheduler did.
      clock.advance(9);
      expect((await checkCircuit(store, "svc")).state).toBe("open");

      // Across it: half-open, admitting the trial call. Both edges are asserted
      // because only the pair distinguishes "resets after 10ms" from "resets".
      clock.advance(2);
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
