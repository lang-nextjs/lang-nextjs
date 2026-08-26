import { describe, expect, it, vi, afterEach } from "vitest";
import { newSessionId } from "./session-id";

/**
 * TWO TABS, ONE MILLISECOND, ONE SESSION (#114).
 *
 * `hitl-${Date.now()}` was called "per-tab" in browser-owner-key.ts. It is not.
 * Date.now() has millisecond resolution, so two mounts inside the same
 * millisecond produce the same id — and the e2e suite opens its two tabs with
 * `Promise.all`, which is a deliberate attempt to make that happen.
 *
 * THE FIRST TEST IS THE WHOLE POINT: it holds the clock still and demands two
 * different ids. Against the old implementation it fails every time, because
 * with the clock frozen the old implementation is a constant function.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the collision the old id could not avoid", () => {
  it("TWO MOUNTS IN THE SAME MILLISECOND GET DIFFERENT IDS", () => {
    // The clock is frozen, which is the honest way to express "the same
    // millisecond" — it removes the flakiness from the TEST while preserving
    // exactly the condition that made the PRODUCT flaky.
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("stays unique across many mounts at one instant", () => {
    // One pair passing could be luck in a 16-bit space. A hundred could not.
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
    expect(ids.size).toBe(100);
  });

  it("does not depend on the clock at all", () => {
    // A clock that goes BACKWARDS — NTP correction, a suspended laptop — was
    // the other way the old scheme could repeat an id it had already issued.
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const first = newSessionId();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    expect(newSessionId()).not.toBe(first);
  });
});

describe("the shape callers rely on", () => {
  it("keeps the hitl- prefix, so existing ids stay recognisable in logs", () => {
    expect(newSessionId()).toMatch(/^hitl-/);
  });

  it("takes a prefix, since the value names which surface issued it", () => {
    expect(newSessionId("run")).toMatch(/^run-/);
  });

  it("carries enough entropy to be worth calling an id", () => {
    // Guards the fallback path as much as the primary one: a fallback that
    // returned something short would satisfy uniqueness in a unit test and
    // still be guessable in the window browser-owner-key.ts warns about.
    const id = newSessionId();
    expect(id.length).toBeGreaterThan(20);
  });
});

describe("degrading without crypto, rather than throwing", () => {
  it("uses getRandomValues when randomUUID is unavailable", () => {
    // `crypto.randomUUID` needs a SECURE CONTEXT, so it is absent over plain
    // http on a LAN address — which is how `next dev -H 0.0.0.0` is reached
    // from a phone. This is a real configuration, not a hypothetical.
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff;
        return a;
      },
    });
    const id = newSessionId();
    expect(id).toMatch(/^hitl-[0-9a-f]{32}$/);
  });

  it("still returns an id when crypto is gone entirely", () => {
    // Must not throw. A demo page that white-screens because an id could not
    // be minted is worse than one with a weaker id.
    vi.stubGlobal("crypto", undefined);
    expect(() => newSessionId()).not.toThrow();
    expect(newSessionId()).toMatch(/^hitl-/);
  });

  it("LABELS the weak id as weak, so a collision is diagnosable", () => {
    // The one case that can still repeat. An id that collides is far easier to
    // chase when the value itself says it was minted without randomness than
    // when it is indistinguishable from a good one.
    vi.stubGlobal("crypto", undefined);
    expect(newSessionId()).toContain("weak-");
  });
});
