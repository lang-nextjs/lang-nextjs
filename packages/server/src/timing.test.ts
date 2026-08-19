import { describe, it, expect, afterEach } from "vitest";
import { getSafeCurrentTime } from "./timing";

describe("getSafeCurrentTime (OBS-04 edge-safe timing)", () => {
  // Capture the real performance object so we can restore it after stubbing.
  const realPerformance = globalThis.performance;

  afterEach(() => {
    // Restore the genuine performance object on every exit path so a stub
    // from one test cannot leak into another.
    Object.defineProperty(globalThis, "performance", {
      value: realPerformance,
      configurable: true,
      writable: true,
    });
  });

  it("returns a finite number on the current runtime (Node has performance.now)", () => {
    const t = getSafeCurrentTime();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t)).toBe(true);
  });

  it("falls back to Date.now() when performance is undefined", () => {
    Object.defineProperty(globalThis, "performance", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    let t: number | undefined;
    expect(() => {
      t = getSafeCurrentTime();
    }).not.toThrow();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t!)).toBe(true);
  });

  it("does not throw and falls back when performance.now() itself throws", () => {
    Object.defineProperty(globalThis, "performance", {
      value: {
        now() {
          throw new Error("performance.now blew up");
        },
      },
      configurable: true,
      writable: true,
    });
    let t: number | undefined;
    expect(() => {
      t = getSafeCurrentTime();
    }).not.toThrow();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t!)).toBe(true);
  });

  it("returns a FINITE number when performance.now() returns NaN (broken shim guard)", () => {
    // Boundary: some broken browser polyfills / edge shims have been observed
    // to return NaN from performance.now() instead of throwing. The current
    // implementation does `Math.round(performance.now())` which yields NaN.
    // A safe timing source MUST validate the value is finite and fall back to
    // Date.now() — otherwise NaN timestamps propagate into every observability
    // record, breaking time-delta math (NaN - x = NaN) and producing malformed
    // logs that downstream log aggregators reject. Same contract applies if
    // performance.now() returns +Infinity from an overflow — Number.isFinite
    // catches both.
    Object.defineProperty(globalThis, "performance", {
      value: {
        now() {
          return NaN;
        },
      },
      configurable: true,
      writable: true,
    });
    const t = getSafeCurrentTime();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t)).toBe(true);
    expect(t).not.toBeNaN();
  });
});
