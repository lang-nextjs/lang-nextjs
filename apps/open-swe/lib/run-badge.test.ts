import { describe, expect, it } from "vitest";
import { relativeTime, statusBadge } from "./run-badge";
import { RUN_STATUSES } from "./types";

/**
 * THE WORDS AND COLOURS ON A BOARD CARD.
 *
 * This logic was private to RunListCard.tsx and ended in a fall-through that
 * returned the RAW ENUM VALUE as the label. Harmless while `Run["status"]`
 * held four values with three handled explicitly — and then #246 widened it to
 * seven, which made the fall-through the common case:
 *
 *   pending -> "pending", idle -> "idle", unknown -> "unknown",
 *   interrupted -> "interrupted", all in the muted "nothing to see" grey.
 *
 * The capitalisation was cosmetic. `interrupted` was not: it means the run is
 * waiting on a human, it gets its own board column called "Needs approval"
 * because it is the one state a person must act on, and the card inside that
 * column rendered it in the same grey as states that need nobody.
 *
 * WIDENING A TYPE DOES NOT UPDATE THE CODE THAT CONSUMES IT. These tests are
 * about the consuming half, and the first describe block is written so that
 * adding an eighth status without handling it fails here.
 */

describe("every status the board can hold is given real words", () => {
  it("NO STATUS RENDERS AS ITS RAW ENUM VALUE", () => {
    // The regression that motivated the whole file. Driven from RUN_STATUSES
    // rather than a list retyped here, so a status added to the union without
    // a case in statusBadge fails this — a hand-copied list would agree with
    // whatever it was copied from and could never detect that.
    for (const s of RUN_STATUSES) {
      const { label } = statusBadge(s);
      expect(label, `${s} renders as its own enum value`).not.toBe(s);
      expect(label.length, `${s} has no label`).toBeGreaterThan(0);
      // A label a person reads starts like a sentence, not like a constant.
      expect(label[0], `${s} label is not capitalised`).toBe(
        label[0].toUpperCase()
      );
    }
  });

  it("every status gets a colour AND a dot, so none renders unstyled", () => {
    for (const s of RUN_STATUSES) {
      const b = statusBadge(s);
      expect(b.cls, `${s} has no class`).toMatch(/\S/);
      expect(b.dot, `${s} has no dot`).toMatch(/\S/);
    }
  });

  it("the labels are DISTINCT where the states mean different things", () => {
    // The control that stops "give everything a label" being satisfied by
    // giving everything the SAME label. Only idle and unknown are allowed to
    // look alike, and they are asserted apart below anyway.
    const labels = RUN_STATUSES.map((s) => statusBadge(s).label);
    expect(new Set(labels).size).toBe(RUN_STATUSES.length);
  });
});

describe("the state a person has to act on", () => {
  it("INTERRUPTED READS AS NEEDING APPROVAL, not as the platform's word", () => {
    // Nobody scanning a board is looking for "interrupted". They are looking
    // for what needs them.
    const b = statusBadge("interrupted");
    expect(b.label).toBe("Needs approval");
    expect(b.actionable).toBe(true);
  });

  it("it is the ONLY actionable state", () => {
    // If everything is actionable, nothing is. This is what keeps the flag
    // meaningful when the board is scanned at a glance.
    const actionable = RUN_STATUSES.filter((s) => statusBadge(s).actionable);
    expect(actionable).toEqual(["interrupted"]);
  });

  it("it is not styled as muted, because muted means nothing needs you", () => {
    // The specific rendering bug: it landed in the fall-through and got the
    // same grey as `idle` and `unknown`.
    const b = statusBadge("interrupted");
    expect(b.cls).not.toContain("muted");
    expect(b.dot).not.toContain("muted");
  });
});

describe("the states that must not claim success", () => {
  it("IDLE IS NOT 'Completed' — the #176 rule, on the card", () => {
    // idle means the thread is not executing, which is equally true before a
    // run and after a failure. It cannot carry a claim of success.
    const b = statusBadge("idle");
    expect(b.label).not.toMatch(/complete|done|success|finish/i);
    expect(b.cls).not.toContain("success");
  });

  it("UNKNOWN IS NOT 'Completed' either", () => {
    const b = statusBadge("unknown");
    expect(b.label).not.toMatch(/complete|done|success|finish/i);
    expect(b.cls).not.toContain("success");
  });

  it("and neither is styled as a failure — we do not know that they failed", () => {
    // The other direction, which is its own kind of lie: rendering a healthy
    // run as failed sends people to investigate work that is fine.
    for (const s of ["idle", "unknown", "pending"] as const) {
      expect(statusBadge(s).cls, s).not.toContain("destructive");
    }
  });

  it("only completed claims success, only failed claims failure", () => {
    for (const s of RUN_STATUSES) {
      if (s !== "completed")
        expect(statusBadge(s).cls, s).not.toContain("success");
      if (s !== "failed")
        expect(statusBadge(s).cls, s).not.toContain("destructive");
    }
  });
});

describe("how long ago a run was created", () => {
  const T = Date.parse("2026-08-26T12:00:00Z");
  const at = (ms: number) => relativeTime(new Date(T - ms).toISOString(), T);

  it("reads in the units a person thinks in", () => {
    expect(at(0)).toBe("just now");
    // "just now" reaches 29s, not 59s: the code ROUNDS, so 30s is already
    // "1 min ago". Written down because the obvious guess is wrong and the
    // next person to touch this will make it.
    expect(at(29_000)).toBe("just now");
    expect(at(30_000)).toBe("1 min ago");
    expect(at(5 * 60_000)).toBe("5 min ago");
    expect(at(3 * 3_600_000)).toBe("3 hrs ago");
    expect(at(2 * 86_400_000)).toBe("2 days ago");
  });

  it("singular and plural agree — never '1 hrs ago'", () => {
    expect(at(3_600_000)).toBe("1 hr ago");
    expect(at(86_400_000)).toBe("1 day ago");
  });

  it("A FUTURE TIMESTAMP DOES NOT RENDER AS NEGATIVE", () => {
    // Server and browser clocks disagree routinely, and a card reading
    // "-3 min ago" reads as a bug in the app rather than in the clock.
    expect(relativeTime(new Date(T + 60_000).toISOString(), T)).toBe(
      "just now"
    );
    expect(relativeTime(new Date(T + 86_400_000).toISOString(), T)).toBe(
      "just now"
    );
  });

  it("an unparseable timestamp renders as nothing, not as 'NaN ago'", () => {
    // The card shows this inline; a broken value must be invisible rather
    // than shouting a JavaScript artefact at whoever opens the board.
    for (const bad of ["", "not-a-date", "2026-13-45"]) {
      expect(relativeTime(bad, T), bad).toBe("");
    }
  });

  it("crosses each boundary in the right direction", () => {
    // Rounding, asserted where it actually changes the words. The old code
    // rounds rather than floors, so 59.6 minutes is an hour.
    expect(at(59 * 60_000)).toBe("59 min ago");
    expect(at(60 * 60_000)).toBe("1 hr ago");
    expect(at(23 * 3_600_000)).toBe("23 hrs ago");
    expect(at(24 * 3_600_000)).toBe("1 day ago");
  });
});
