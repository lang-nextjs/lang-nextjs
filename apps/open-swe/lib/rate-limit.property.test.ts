/**
 * Property-based tests for RateLimiter.
 *
 * Invariants verified across fuzzed inputs:
 *
 *   1. Monotonicity: within a fixed window, the Nth request hits the limit
 *      before the (N+M)th request for any positive M. Once at-capacity,
 *      the limiter stays at-capacity until time advances.
 *
 *   2. Retry-after is always finite + positive when denied. The
 *      maxRequests:0 bug fixed in /nf:harden iteration 1 was a real
 *      example of this property being violated (NaN return).
 *
 *   3. Independence: different IPs are tracked independently — one IP
 *      hitting capacity does not affect another IP's allowance.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter — properties", () => {
  it("monotonicity: after maxRequests consecutive allows, all subsequent calls in-window are denied", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // maxRequests
        fc.integer({ min: 1, max: 20 }), // extra attempts after capacity
        (maxRequests, extra) => {
          const limiter = new RateLimiter();
          const ip = "192.168.1.1";
          const config = { name: "prop", windowMs: 60_000, maxRequests };

          // Fill to capacity.
          for (let i = 0; i < maxRequests; i++) {
            const r = limiter.check(ip, config);
            if (!r.allowed) return false;
          }
          // Every subsequent attempt must be denied (assuming window
          // hasn't elapsed — test is fast enough that Date.now() doesn't
          // advance meaningfully).
          for (let i = 0; i < extra; i++) {
            const r = limiter.check(ip, config);
            if (r.allowed) return false;
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it("retry-after is always finite + ≥1000ms when denied (NaN regression guard)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }), // maxRequests including 0
        fc.integer({ min: 1, max: 5 }), // attempts past cap
        (maxRequests, extraAttempts) => {
          const limiter = new RateLimiter();
          const config = { name: "prop", windowMs: 60_000, maxRequests };
          // Fill to capacity (when maxRequests > 0).
          for (let i = 0; i < maxRequests; i++) {
            limiter.check("ip1", config);
          }
          // Probe past cap.
          for (let i = 0; i < extraAttempts; i++) {
            const r = limiter.check("ip1", config);
            if (r.allowed) continue;
            // The contract: when denied, retryAfterMs must be a finite
            // positive number ≥1000.
            if (!Number.isFinite(r.retryAfterMs)) return false;
            if (r.retryAfterMs < 1000) return false;
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it("independence: filling one IP's bucket leaves other IPs unaffected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (maxRequests, ipA, ipB) => {
          fc.pre(ipA !== ipB);
          const limiter = new RateLimiter();
          const config = { name: "prop", windowMs: 60_000, maxRequests };
          // Fill A.
          for (let i = 0; i < maxRequests; i++) {
            limiter.check(ipA, config);
          }
          // B must still be at capacity 1 — independent bucket.
          const result = limiter.check(ipB, config);
          return result.allowed === true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
