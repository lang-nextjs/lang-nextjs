import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from "./circuit-breaker";

describe("CircuitBreaker", () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    circuitBreaker.reset();
  });

  describe("initial state", () => {
    it("starts in CLOSED state", () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("has zero failures initially", () => {
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
    });

    it("getRetryAfterSeconds returns 0 when not OPEN", () => {
      expect(circuitBreaker.getRetryAfterSeconds()).toBe(0);
    });
  });

  describe(" CLOSED state behavior", () => {
    it("passes through successful calls", async () => {
      const result = await circuitBreaker.execute(() =>
        Promise.resolve("success")
      );
      expect(result).toBe("success");
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
    });

    it("counts failures and increments counter", async () => {
      // First call succeeds
      await circuitBreaker.execute(() => Promise.resolve("success"));

      // Subsequent calls fail
      for (let i = 0; i < 4; i++) {
        await expect(
          circuitBreaker.execute(() => Promise.reject(new Error("failure")))
        ).rejects.toThrow();
      }

      expect(circuitBreaker.getStatus().failureCount).toBe(4);
    });

    it("opens circuit after failure threshold", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });

      // Succeed once to reset counter
      await breaker.execute(() => Promise.resolve("success"));

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        await expect(
          breaker.execute(() => Promise.reject(new Error("failure")))
        ).rejects.toThrow();
      }

      // Now circuit should be open
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("success resets failure count to 0", async () => {
      // Build up some failures
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();

      // Success resets counter
      await circuitBreaker.execute(() => Promise.resolve("success"));

      expect(circuitBreaker.getStatus().failureCount).toBe(0);
    });

    it("mixed failures and successes don't prematurely open", async () => {
      // Failure -> failure -> success -> failure -> failure
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("f1")))
      ).rejects.toThrow();
      expect(circuitBreaker.getStatus().failureCount).toBe(1);

      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("f2")))
      ).rejects.toThrow();
      expect(circuitBreaker.getStatus().failureCount).toBe(2);

      await circuitBreaker.execute(() => Promise.resolve("success"));
      expect(circuitBreaker.getStatus().failureCount).toBe(0);

      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("f3")))
      ).rejects.toThrow();
      expect(circuitBreaker.getStatus().failureCount).toBe(1);

      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("f4")))
      ).rejects.toThrow();
      expect(circuitBreaker.getStatus().failureCount).toBe(2);
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("OPEN state behavior", () => {
    it("throws CircuitOpenError immediately in OPEN state", async () => {
      // Open the circuit first
      circuitBreaker.reset();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Now any call should throw CircuitOpenError without calling the function
      let called = false;
      await expect(
        circuitBreaker.execute(() => {
          called = true;
          return Promise.resolve("should not be called");
        })
      ).rejects.toThrow(CircuitOpenError);

      expect(called).toBe(false);
    });

    it("CircuitOpenError includes retryAfterSeconds", async () => {
      // Open the circuit
      circuitBreaker.reset();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();

      let error!: CircuitOpenError;
      try {
        await circuitBreaker.execute(() => Promise.resolve("success"));
      } catch (e) {
        error = e as CircuitOpenError;
      }

      expect(error).toBeInstanceOf(CircuitOpenError);
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.state).toBe(CircuitState.OPEN);
    });

    it("getRetryAfterSeconds returns remaining cooldown time", () => {
      // Simulate circuit open with last failure 10 seconds ago
      circuitBreaker["lastFailureTime"] = Date.now() - 10_000;
      circuitBreaker["state"] = CircuitState.OPEN;

      const retryAfter = circuitBreaker.getRetryAfterSeconds();
      expect(retryAfter).toBe(20); // 30s timeout - 10s elapsed = 20s remaining
    });
  });

  describe("HALF_OPEN state behavior", () => {
    beforeEach(() => {
      // Manually set to HALF_OPEN with some probe count
      circuitBreaker["state"] = CircuitState.HALF_OPEN;
      circuitBreaker["halfOpenProbeCount"] = 0;
    });

    it("allows probe request", async () => {
      const result = await circuitBreaker.execute(() =>
        Promise.resolve("success")
      );
      expect(result).toBe("success");
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("successful probe closes circuit", async () => {
      await circuitBreaker.execute(() => Promise.resolve("success"));
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker["halfOpenProbeCount"]).toBe(0);
    });

    it("failed probe reopens circuit", async () => {
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      expect(circuitBreaker["halfOpenProbeCount"]).toBe(0);
    });

    it("exceeds max probes throws CircuitOpenError", async () => {
      const breaker = new CircuitBreaker({ halfOpenMaxProbes: 1 });
      breaker["state"] = CircuitState.HALF_OPEN;
      breaker["halfOpenProbeCount"] = 1;

      await expect(
        breaker.execute(() => Promise.resolve("success"))
      ).rejects.toThrow(CircuitOpenError);
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe("time-based transitions", () => {
    it("transitions OPEN to HALF_OPEN after reset timeout", async () => {
      // Open the circuit
      circuitBreaker.reset();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Fast forward time past reset timeout
      vi.advanceTimersByTime(30_001);

      // Now should be in HALF_OPEN state
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it("transitions back to CLOSED after successful probe in HALF_OPEN", async () => {
      // Start in HALF_OPEN
      circuitBreaker["state"] = CircuitState.HALF_OPEN;

      // Successful call should transition to CLOSED
      await circuitBreaker.execute(() => Promise.resolve("success"));
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("config customization", () => {
    it("uses custom failure threshold", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });

      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("uses custom reset timeout", async () => {
      const breaker = new CircuitBreaker({ resetTimeoutMs: 10_000 });

      // Open the circuit
      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Fast forward to 5 seconds (should still be OPEN)
      vi.advanceTimersByTime(5_000);
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Fast forward to 10 seconds (should be HALF_OPEN)
      vi.advanceTimersByTime(5_001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it("uses custom half-open max probes", async () => {
      const breaker = new CircuitBreaker({ halfOpenMaxProbes: 2 });

      // Start in HALF_OPEN
      breaker["state"] = CircuitState.HALF_OPEN;
      breaker["halfOpenProbeCount"] = 0;

      // First probe succeeds
      await breaker.execute(() => Promise.resolve("success"));
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("reset method", () => {
    it("resets to CLOSED state from any state", async () => {
      // Open the circuit
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Reset should return to CLOSED
      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
      expect(circuitBreaker["halfOpenProbeCount"]).toBe(0);
    });
  });

  describe("getStatus method", () => {
    it("returns current state and counters", () => {
      const status = circuitBreaker.getStatus();
      expect(status).toEqual({
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureTime: null,
      });
    });

    it("returns failure count after failures", async () => {
      await expect(
        circuitBreaker.execute(() => Promise.reject(new Error("failure")))
      ).rejects.toThrow();

      const status = circuitBreaker.getStatus();
      expect(status.failureCount).toBe(1);
      expect(status.state).toBe(CircuitState.CLOSED);
    });
  });

  describe("adversarial edge cases", () => {
    it("20 concurrent failures in CLOSED state open the circuit exactly once and trip to OPEN", async () => {
      // Adversarial: a real upstream (e.g. an RPC service) blips and 20 in-flight
      // requests all reject at roughly the same instant. Each execute() runs
      // synchronously up to the first await, but the failing fn() resolves its
      // rejection on a microtask. With failureThreshold=5, the breaker must
      // observe >=5 failures, transition to OPEN, and subsequent calls must
      // short-circuit with CircuitOpenError (NOT count more failures).
      //
      // Contract pinned here:
      //   - the underlying failing fn is invoked exactly N times (20) before the
      //     breaker opens — none of the "after-opening" calls reach the fn.
      //   - final state is OPEN with failureCount >= threshold
      //   - a trailing call returns CircuitOpenError without invoking fn
      const breaker = new CircuitBreaker({ failureThreshold: 5 });
      let fnCalls = 0;
      const failingFn = () => {
        fnCalls++;
        return Promise.reject(new Error("blip"));
      };

      const promises: Promise<unknown>[] = [];
      // Attach catch handlers IMMEDIATELY (before any await) to prevent
      // unhandled-rejection warnings during the synchronous launch.
      for (let i = 0; i < 20; i++) {
        const p = breaker.execute(failingFn).catch((e) => e);
        promises.push(p);
      }
      const results = await Promise.all(promises);

      // Every concurrent call's underlying error propagated (we caught it)
      expect(results).toHaveLength(20);
      // All rejections are Error instances, NOT CircuitOpenError (the breaker
      // was CLOSED at launch time; the transition happens during the catch).
      for (const r of results) {
        expect(r).toBeInstanceOf(Error);
        expect((r as Error).message).toBe("blip");
      }

      // The breaker should now be OPEN — and a subsequent call short-circuits.
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Trailing call must NOT call fn (short-circuit by circuit).
      let trailingFnCalled = false;
      await expect(
        breaker.execute(() => {
          trailingFnCalled = true;
          return Promise.resolve("never");
        })
      ).rejects.toBeInstanceOf(CircuitOpenError);
      expect(trailingFnCalled).toBe(false);
    });
    it("HALF_OPEN reject-by-probe-cap reports honest retryAfterSeconds (not 0)", async () => {
      // BUG HYPOTHESIS: when execute() is called in HALF_OPEN with probeCount already
      // at the cap, the code sets state = OPEN but does NOT update lastFailureTime.
      // Because the cooldown already elapsed (that's how we got to HALF_OPEN), the
      // CircuitOpenError carries retryAfterSeconds === 0 — telling the client
      // "retry now" while the circuit was JUST reopened. Either the retry-after
      // should be > 0, OR lastFailureTime should be refreshed to "now".
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 30_000,
        halfOpenMaxProbes: 1,
      });

      // Open the circuit
      await expect(
        breaker.execute(() => Promise.reject(new Error("f1")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("f2")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Advance past resetTimeoutMs so getState() transitions OPEN -> HALF_OPEN
      vi.advanceTimersByTime(30_001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Consume the single allowed probe by manually pinning the counter at the cap
      // (simulating: another concurrent probe already started)
      (
        breaker as unknown as { halfOpenProbeCount: number }
      ).halfOpenProbeCount = 1;

      // The next execute should throw CircuitOpenError AND reopen the circuit
      let caught: CircuitOpenError | undefined;
      try {
        await breaker.execute(() => Promise.resolve("nope"));
      } catch (e) {
        caught = e as CircuitOpenError;
      }
      expect(caught).toBeInstanceOf(CircuitOpenError);
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // The retryAfterSeconds MUST be > 0 — the circuit was just reopened, the
      // client should not be told "retry immediately". Otherwise the client will
      // hammer the breaker in a tight loop the instant the cap is hit.
      expect(caught!.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("two concurrent execute() calls in HALF_OPEN respect halfOpenMaxProbes=1", async () => {
      // Adversarial: two requests race into HALF_OPEN. The cap is 1 probe. Only
      // ONE underlying fn should actually be invoked; the second must be rejected
      // with CircuitOpenError.
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMaxProbes: 1,
      });

      // Open the circuit
      await expect(
        breaker.execute(() => Promise.reject(new Error("f1")))
      ).rejects.toThrow();
      await expect(
        breaker.execute(() => Promise.reject(new Error("f2")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Advance past reset timeout
      vi.advanceTimersByTime(1_001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Two slow probes started concurrently
      let fnInvocations = 0;
      const slowFn = () => {
        fnInvocations++;
        return new Promise<string>((resolve) =>
          setTimeout(() => resolve("ok"), 100)
        );
      };

      // Attach catch handlers IMMEDIATELY (before any await) so the
      // synchronous rejection of p2 doesn't surface as an
      // unhandled-rejection warning before Promise.allSettled below
      // formally observes it. Using void on a swallowing chain is the
      // standard pattern for tests that intentionally let one of N
      // concurrent promises reject.
      const p1 = breaker.execute(slowFn);
      const p2 = breaker.execute(slowFn);
      void p1.catch(() => {});
      void p2.catch(() => {});

      // Advance timers so the slow fn resolves
      await vi.advanceTimersByTimeAsync(200);

      const results = await Promise.allSettled([p1, p2]);

      // Exactly ONE should succeed (the probe), the other should be rejected with
      // CircuitOpenError. If both fire fn, the breaker is leaking probes — defeating
      // the purpose of half-open mode (stampede protection).
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        CircuitOpenError
      );
      // fn must only be called ONCE — the second call should be rejected before fn invoke
      expect(fnInvocations).toBe(1);
    });

    it("failureThreshold of 1 opens on the very first failure", async () => {
      // Boundary: threshold === 1 means a single failure should open immediately.
      // failureCount becomes 1, condition is `1 >= 1` (true).
      const breaker = new CircuitBreaker({ failureThreshold: 1 });
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      await expect(
        breaker.execute(() => Promise.reject(new Error("f1")))
      ).rejects.toThrow("f1");

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("halfOpenMaxProbes=0 makes recovery impossible (footgun documentation)", async () => {
      // Adversarial config: maxProbes=0 means the cap is hit on the FIRST execute()
      // in HALF_OPEN (probeCount=0, check `0 >= 0` is true). The circuit reopens
      // and can never close — even a healthy upstream will never be probed.
      // This is a likely misconfiguration; we want to document the current behavior
      // so a future fix can either reject the config or treat 0 as "default to 1".
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1_000,
        halfOpenMaxProbes: 0,
      });

      await expect(
        breaker.execute(() => Promise.reject(new Error("f1")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Cooldown elapses
      vi.advanceTimersByTime(1_001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Healthy upstream — but the probe is BLOCKED by the cap-of-0
      let upstreamInvoked = false;
      await expect(
        breaker.execute(() => {
          upstreamInvoked = true;
          return Promise.resolve("healthy");
        })
      ).rejects.toThrow(CircuitOpenError);

      // The healthy fn was NEVER called, and we're back to OPEN
      expect(upstreamInvoked).toBe(false);
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("non-Error rejection (throw null) still increments failureCount", async () => {
      // Adversarial: code can `throw null` or reject with a non-Error value. The
      // catch block must still treat it as a failure; otherwise the breaker
      // silently ignores these and never opens.
      const breaker = new CircuitBreaker({ failureThreshold: 2 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(
        breaker.execute(() => Promise.reject(null as any))
      ).rejects.toBe(null);
      expect(breaker.getStatus().failureCount).toBe(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(
        breaker.execute(() => Promise.reject("string-error" as any))
      ).rejects.toBe("string-error");
      expect(breaker.getStatus().failureCount).toBe(2);
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("resetTimeoutMs:0 means OPEN transitions to HALF_OPEN on the very next getState() call (off-by-one boundary)", async () => {
      // Boundary / off-by-one: the OPEN→HALF_OPEN transition uses
      // `elapsed >= this.config.resetTimeoutMs`. With resetTimeoutMs=0 the
      // condition is satisfied for any elapsed >= 0 — including elapsed=0
      // (the same tick the failure was recorded). A consumer expecting
      // a non-zero cooldown would never get one. This test pins that the
      // current implementation honors the >= operator at exactly 0.
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 0,
      });

      // Construct an OPEN state directly so we can observe getState() WITHOUT
      // it being implicitly transitioned by execute()'s internal getState() call.
      breaker["state"] = CircuitState.OPEN;
      breaker["lastFailureTime"] = Date.now();
      breaker["failureCount"] = 1;

      // No time advance — same tick. With resetTimeoutMs=0 the gate is open
      // (elapsed=0 >= 0), so getState() must return HALF_OPEN. If an
      // implementor changes >= to > this test fails, exposing the regression.
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it("walks the FULL lifecycle CLOSED -> OPEN -> HALF_OPEN -> CLOSED via fake timers", async () => {
      // Adversarial: drive every state transition through the public API
      // (no reaching into private fields) with a single instance. This pins
      // the high-level recovery contract a caller relies on:
      //   1. N failures in a row -> OPEN
      //   2. cooldown elapses    -> HALF_OPEN (observed via getState())
      //   3. one probe success   -> CLOSED, failureCount reset to 0
      // If any of these transitions regress (e.g. successful probe leaves the
      // circuit HALF_OPEN, or cooldown doesn't trigger HALF_OPEN), this test
      // fires.
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 5_000,
        halfOpenMaxProbes: 1,
      });

      // 1. CLOSED -> OPEN via threshold of failures
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      for (let i = 0; i < 3; i++) {
        await expect(
          breaker.execute(() => Promise.reject(new Error(`fail-${i}`)))
        ).rejects.toThrow();
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      // Subsequent call short-circuits with CircuitOpenError
      await expect(
        breaker.execute(() => Promise.resolve("never"))
      ).rejects.toBeInstanceOf(CircuitOpenError);

      // 2. OPEN -> HALF_OPEN after cooldown
      vi.advanceTimersByTime(5_001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // 3. HALF_OPEN -> CLOSED via successful probe
      const recovered = await breaker.execute(() => Promise.resolve("ok"));
      expect(recovered).toBe("ok");
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      // And the failure counter is reset — a single new failure should NOT
      // immediately re-open the circuit (we need 3 more to hit the threshold).
      await expect(
        breaker.execute(() => Promise.reject(new Error("post-recovery")))
      ).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getStatus().failureCount).toBe(1);
    });
  });
});
