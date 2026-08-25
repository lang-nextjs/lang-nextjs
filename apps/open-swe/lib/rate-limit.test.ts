import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RateLimiter,
  STRICT,
  STANDARD,
  extractIp,
  getLimiter,
} from "./rate-limit";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < STRICT.maxRequests; i++) {
      const result = limiter.check("1.2.3.4", STRICT);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    }
  });

  it("blocks requests over the limit", () => {
    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.2.3.4", STRICT);
    }
    const result = limiter.check("1.2.3.4", STRICT);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks IPs independently", () => {
    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.1.1.1", STRICT);
    }
    const result = limiter.check("2.2.2.2", STRICT);
    expect(result.allowed).toBe(true);
  });

  it("resets after the sliding window expires", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.2.3.4", STRICT);
    }
    expect(limiter.check("1.2.3.4", STRICT).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(STRICT.windowMs + 1);
    expect(limiter.check("1.2.3.4", STRICT).allowed).toBe(true);

    vi.useRealTimers();
  });

  it("returns retryAfterMs pointing to window expiry", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.2.3.4", STRICT);
    }

    // Advance 10s into the window
    vi.advanceTimersByTime(10_000);
    const result = limiter.check("1.2.3.4", STRICT);
    expect(result.allowed).toBe(false);
    // retryAfter should be roughly (windowMs - 10000) = 50000
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(49_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);

    vi.useRealTimers();
  });

  it("applies different configs independently", () => {
    // Fill up STRICT (10 requests)
    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.2.3.4", STRICT);
    }
    // STRICT is exhausted for this IP
    expect(limiter.check("1.2.3.4", STRICT).allowed).toBe(false);
    // STANDARD has its own counter.
    //
    // NOTE (#127): this assertion ALSO passed before the fix, when both classes
    // shared one array — 10 hits is simply under STANDARD's 60, so a shared
    // counter satisfies it. The comment claimed a property the code did not
    // have, and the test could not tell the difference. The direction that
    // exposes it (STANDARD polling draining the STRICT budget) is asserted in
    // the "#127 — config classes must not share a bucket" block below.
    expect(limiter.check("1.2.3.4", STANDARD).allowed).toBe(true);
  });

  it("reset(ip) clears only that IP", () => {
    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.1.1.1", STRICT);
      limiter.check("2.2.2.2", STRICT);
    }
    limiter.reset("1.1.1.1");
    expect(limiter.check("1.1.1.1", STRICT).allowed).toBe(true);
    expect(limiter.check("2.2.2.2", STRICT).allowed).toBe(false);
  });

  it("reset() clears all IPs", () => {
    for (let i = 0; i < STRICT.maxRequests; i++) {
      limiter.check("1.1.1.1", STRICT);
    }
    limiter.reset();
    expect(limiter.check("1.1.1.1", STRICT).allowed).toBe(true);
  });

  describe("cleanup", () => {
    it("prunes stale entries", () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      limiter.check("stale-ip", STRICT);
      // Advance well past cleanup threshold (5 min)
      vi.advanceTimersByTime(60_000 * 6);
      limiter.cleanup();

      // stale-ip should have been removed — a new check gets fresh start
      expect(limiter.check("stale-ip", STRICT).allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("boundary configs", () => {
    it("maxRequests:0 returns a finite numeric retryAfterMs (not NaN)", () => {
      // Edge case: a misconfigured rate limit with maxRequests=0 means
      // EVERY request is denied. The denial branch reads timestamps[0],
      // which is undefined when no prior calls exist → `undefined + windowMs - now`
      // is NaN → Math.max(NaN, 1000) is NaN. A NaN retry-after header would be
      // a real client bug. retryAfterMs MUST be a finite number.
      const result = limiter.check("any-ip", {
        name: "zero-max",
        windowMs: 60_000,
        maxRequests: 0,
      });
      expect(result.allowed).toBe(false);
      expect(Number.isFinite(result.retryAfterMs)).toBe(true);
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
    });

    it("maxRequests:1 allows exactly one request then blocks", () => {
      // Off-by-one boundary: with limit=1, the 1st call must be allowed,
      // the 2nd must be blocked.
      const cfg = { name: "one-max", windowMs: 60_000, maxRequests: 1 };
      expect(limiter.check("only-one", cfg).allowed).toBe(true);
      expect(limiter.check("only-one", cfg).allowed).toBe(false);
    });

    it("windowMs:0 with maxRequests:0 does not produce NaN retryAfterMs", () => {
      // Pathological: zero window + zero cap. windowStart = now - 0 = now.
      // The first check filters timestamps where t > windowStart, so the
      // freshly-pushed timestamp is exactly equal (not greater) → falls into
      // the `firstValid = i + 1` path → firstValid becomes 1. Then with
      // maxRequests=0 the deny branch fires. The retryAfterMs fallback uses
      // config.windowMs which is 0 → Math.max(0, 1000) === 1000. The result
      // must remain finite and >= 1000 so the response header is valid.
      const result = limiter.check("zero-cfg-ip", {
        name: "zero-window",
        windowMs: 0,
        maxRequests: 0,
      });
      expect(result.allowed).toBe(false);
      expect(Number.isFinite(result.retryAfterMs)).toBe(true);
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
    });
  });
});

describe("extractIp", () => {
  it("returns 'unknown' when no proxy headers are present", () => {
    const req = { headers: new Headers() };
    expect(extractIp(req)).toBe("unknown");
  });

  it("returns the first IP from a multi-hop x-forwarded-for and trims whitespace", () => {
    // x-forwarded-for is comma-joined; client IP is the leftmost.
    // Proxies in the wild commonly append a space after the comma.
    const req = {
      headers: new Headers({
        "x-forwarded-for": "  203.0.113.5  , 10.0.0.1, 10.0.0.2",
      }),
    };
    expect(extractIp(req)).toBe("203.0.113.5");
  });

  it("prefers x-forwarded-for over x-real-ip when both are present", () => {
    const req = {
      headers: new Headers({
        "x-forwarded-for": "203.0.113.5",
        "x-real-ip": "198.51.100.7",
      }),
    };
    expect(extractIp(req)).toBe("203.0.113.5");
  });

  it("returns 'unknown' (not empty string) when x-forwarded-for is empty", () => {
    // Edge: a proxy might set the header to "" — current impl uses `if (xff)`
    // truthy check, so empty string falls through to x-real-ip / unknown.
    // But a header value of "," would produce empty-string IP after split[0].trim().
    // Probe both: empty header AND comma-only header.
    const emptyReq = { headers: new Headers({ "x-forwarded-for": "" }) };
    expect(extractIp(emptyReq)).toBe("unknown");

    const commaOnlyReq = { headers: new Headers({ "x-forwarded-for": "," }) };
    // Current code splits "," and takes [0].trim() = "" — that is a bogus IP key.
    // Document the behavior: empty-string IP would collapse all such clients
    // into a single bucket. A correct impl should fall back to "unknown".
    expect(commaOnlyReq.headers.get("x-forwarded-for")).toBe(",");
    expect(extractIp(commaOnlyReq)).toBe("unknown");
  });
});

describe("getLimiter singleton", () => {
  it("returns the same instance across calls", () => {
    const a = getLimiter();
    const b = getLimiter();
    expect(a).toBe(b);
  });
});

describe("ADVERSARIAL — degenerate 1ms window", () => {
  it("rate limiter with windowMs:1 still allows exactly maxRequests and eventually resets", () => {
    // Adversarial: a misconfigured windowMs=1 (1 millisecond) is the smallest
    // meaningful non-zero window. The prune step uses `t > windowStart` (strict
    // greater-than). After any time has elapsed — even microseconds — every
    // prior timestamp will be pruned. Combined with maxRequests=2, we expect:
    //   - 2 calls allowed back-to-back
    //   - a third call IMMEDIATELY denied (window hasn't actually slid yet)
    //   - after vi.advanceTimersByTime(2), the window has slid; next call
    //     allowed again. With a 1ms window, even the smallest realistic gap
    //     should reset the counter.
    const limiter = new RateLimiter();
    const cfg = { name: "tiny-window", windowMs: 1, maxRequests: 2 };

    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    // First two calls allowed
    expect(limiter.check("tiny-window-ip", cfg).allowed).toBe(true);
    expect(limiter.check("tiny-window-ip", cfg).allowed).toBe(true);

    // Third call denied — both timestamps are >= windowStart (windowStart = now-1)
    const denied = limiter.check("tiny-window-ip", cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(1000); // floor of 1000ms
    expect(Number.isFinite(denied.retryAfterMs)).toBe(true);

    // Slide window past 1ms — timestamps > windowStart (now-1) — both old
    // timestamps should be pruned. Next call should be allowed.
    vi.advanceTimersByTime(2);
    expect(limiter.check("tiny-window-ip", cfg).allowed).toBe(true);

    vi.useRealTimers();
  });

  it("rate limiter with windowMs:1 and concurrent burst allows AT MOST maxRequests PER WINDOW (timing collision)", async () => {
    // Adversarial: a real burst where Date.now() returns the SAME value across
    // many concurrent calls (true at sub-ms resolution in Node.js). With a 1ms
    // window the prune is `t > windowStart` where windowStart = now - 1. For
    // two timestamps t1 == t2 == now: windowStart = now - 1 < t1, so both
    // survive pruning — the collision case this test exists to pin.
    //
    // Time is frozen so every call lands in ONE window. That makes the real
    // invariant — a single window never exceeds maxRequests — assertable
    // exactly. Under real timers the burst could straddle an arbitrary number
    // of ms on a loaded runner (GC pause, noisy CI), so any fixed bound is a
    // guess about scheduling rather than a statement about the limiter.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const limiter = new RateLimiter();
      const cfg = { name: "tiny-burst", windowMs: 1, maxRequests: 3 };
      const TOTAL = 100;

      const results = await Promise.all(
        Array.from({ length: TOTAL }, () =>
          Promise.resolve().then(() => limiter.check("burst-1ms", cfg))
        )
      );

      const allowed = results.filter((r) => r.allowed).length;
      const denied = results.filter((r) => !r.allowed).length;

      // Conservation: allowed + denied === TOTAL
      expect(allowed + denied).toBe(TOTAL);
      // One window, so EXACTLY maxRequests get through. An unbounded
      // regression lets all 100 pass and fails here; an off-by-one in the
      // prune boundary shifts this by one and also fails.
      expect(allowed).toBe(cfg.maxRequests);
      expect(denied).toBe(TOTAL - cfg.maxRequests);
      // All denied calls must have valid retryAfterMs
      for (const r of results.filter((x) => !x.allowed)) {
        expect(Number.isFinite(r.retryAfterMs)).toBe(true);
        expect(r.retryAfterMs).toBeGreaterThanOrEqual(1000);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ADVERSARIAL — concurrent bursts exceeding the limit", () => {
  it("fires `maxRequests` successes then denies every subsequent call within the window", async () => {
    // Adversarial: simulate a real burst (e.g. a misbehaving client retrying
    // in a tight loop, or a coordinated fan-out). 50 concurrent calls land in
    // the SAME millisecond — Date.now() returns the same value for each.
    //
    // Required contract:
    //   - exactly maxRequests calls are allowed
    //   - every other call (maxRequests+1 .. N) is denied with retryAfterMs > 0
    //   - the denied count + allowed count === total
    //
    // The implementation checks `timestamps.length >= maxRequests` then pushes
    // the current timestamp on success. With identical timestamps from
    // Date.now() in the same ms, the prune loop drops everything `> windowStart`
    // — so equal timestamps are retained. The check then blocks the (N+1)th.
    //
    // If the impl short-circuits and forgets to count concurrent pushes (e.g.
    // compares against a stale snapshot), more than maxRequests would be
    // allowed. We pin both the allowed ceiling AND that denied > 0.
    const limiter = new RateLimiter();
    const cfg = { name: "burst", windowMs: 60_000, maxRequests: 10 };
    const TOTAL = 50;

    const results = await Promise.all(
      Array.from({ length: TOTAL }, () =>
        Promise.resolve().then(() => limiter.check("burst-ip", cfg))
      )
    );

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    // Hard ceiling: never more than maxRequests allowed
    expect(allowed).toBeLessThanOrEqual(cfg.maxRequests);
    // Must actually allow the full quota — under-counting is also a bug
    expect(allowed).toBe(cfg.maxRequests);
    // The rest are denied
    expect(denied).toBe(TOTAL - cfg.maxRequests);
    // Every denial must carry a positive retryAfterMs so the client backs off
    for (const r of results.filter((x) => !x.allowed)) {
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(Number.isFinite(r.retryAfterMs)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// #127 — REGRESSION. Two components, each correct alone, whose COMPOSITION is
// the defect: the bucket key omits the config class, so a permissive endpoint's
// traffic drains a strict endpoint's budget.
//
// The user's journey: the dashboard polls GET /api/open-swe/runs every 5s
// (useRuns.ts:19) under STANDARD (60/60s). That is 12 hits per 60s window.
// POST /api/open-swe/runs is STRICT (10/60s) and reads the SAME array. After
// ~50s with the dashboard open, every submission 429s — and never recovers,
// because the poll keeps refilling the window.
// ---------------------------------------------------------------------------
describe("#127 — config classes must not share a bucket", () => {
  let limiter: RateLimiter;
  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("GET traffic under STANDARD does not reduce remaining POST budget under STRICT", () => {
    const ip = "1.2.3.4";
    // A 5s poll = 12 GETs per 60s window. Comfortably inside STANDARD's 60.
    for (let i = 0; i < 12; i++) {
      expect(limiter.check(ip, STANDARD).allowed).toBe(true);
    }
    // The user now submits a task. This is their FIRST write. It must succeed.
    expect(limiter.check(ip, STRICT).allowed).toBe(true);
  });

  it("a full STRICT budget remains available after sustained STANDARD polling", () => {
    const ip = "5.6.7.8";
    for (let i = 0; i < 12; i++) limiter.check(ip, STANDARD);
    // All 10 STRICT slots must still be there — polling spent none of them.
    for (let i = 0; i < STRICT.maxRequests; i++) {
      expect(limiter.check(ip, STRICT).allowed, `write #${i + 1}`).toBe(true);
    }
    expect(limiter.check(ip, STRICT).allowed).toBe(false);
  });

  it("the isolation holds in BOTH directions, not just the one that looks fine", () => {
    // The pre-existing "applies different configs independently" test only
    // checked STRICT-then-STANDARD, which passes on a SHARED counter because
    // 10 hits is under STANDARD's 60. The reverse is where the bug lives.
    const ip = "9.9.9.9";
    for (let i = 0; i < STRICT.maxRequests; i++) limiter.check(ip, STRICT);
    expect(limiter.check(ip, STRICT).allowed).toBe(false);
    expect(limiter.check(ip, STANDARD).allowed).toBe(true);

    const ip2 = "9.9.9.10";
    for (let i = 0; i < STANDARD.maxRequests; i++) limiter.check(ip2, STANDARD);
    expect(limiter.check(ip2, STANDARD).allowed).toBe(false);
    expect(limiter.check(ip2, STRICT).allowed).toBe(true);
  });

  it("LOCAL DEV: the 'unknown' IP fallback isolates classes too", () => {
    // extractIp returns "unknown" with no forwarding headers, so in local dev
    // every client collapses into one key. That makes the shared-bucket defect
    // certain rather than probable — every existing "unknown" test drives ONE
    // call class, so none of them could see it.
    const ip = extractIp({ headers: new Headers() });
    expect(ip).toBe("unknown");
    for (let i = 0; i < 12; i++) limiter.check(ip, STANDARD);
    expect(limiter.check(ip, STRICT).allowed).toBe(true);
  });
});
