import { describe, expect, it } from "vitest";
import { droppedMessage, parseRuns } from "./parse-runs";
import { groupRuns, totalIn } from "./run-board";
import type { Run } from "./types";

/**
 * A MALFORMED 200 DESTROYED THE BOARD; A 500 DID NOT (#243).
 *
 * `useRuns` cast the body to Run[] without checking. A 200 carrying an object
 * was stored, iterated during render, and threw `runs is not iterable`. React's
 * error boundary replaced the whole page — including the runs already on screen
 * — and, because the boundary unmounted the component that polls, nothing ever
 * fetched again. The page did not recover.
 *
 * THE COMPARISON IS THE DEFECT. On a 500 the same hook preserves the board,
 * reports the error, and recovers on the next tick. The careless path delivered
 * exactly the failure the careful path exists to prevent. So these tests assert
 * a RELATIONSHIP between the two, not just that parsing works.
 */

const run = (id: string, status: Run["status"] = "running"): Run => ({
  run_id: id,
  status,
  created_at: "2026-08-26T00:00:00Z",
  task: `task ${id}`,
});

describe("the shape that caused the outage", () => {
  it("an object body throws rather than reaching render", () => {
    // The exact payload from the report: a 200 whose body is `{"runs": []}`.
    // Reaching render with this is what threw `runs is not iterable`.
    expect(() => parseRuns({ runs: [] })).toThrow(TypeError);
  });

  it("the error names the shape, so the banner is actionable", () => {
    // A person reading "Couldn't load runs: ..." needs to know what arrived.
    // Asserted on content, not merely that a string exists.
    expect(() => parseRuns({ runs: [], next: null })).toThrow(/keys: runs, next/);
    expect(() => parseRuns(null)).toThrow(/got null/);
    expect(() => parseRuns("[]")).toThrow(/a string/);
    expect(() => parseRuns(undefined)).toThrow(/undefined/);
  });

  it("the error does not dump the body into the UI", () => {
    // Keys, not values: a run list can carry task text, and a parse failure is
    // not a reason to render arbitrary upstream content in a banner.
    let msg = "";
    try {
      parseRuns({ secret: "hunter2", token: "abc123" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("secret");
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("abc123");
  });
});

describe("what survives, and what is admitted to have been lost", () => {
  it("a clean array passes through whole, dropping nothing", () => {
    const body = [run("a"), run("b"), run("c")];
    expect(parseRuns(body)).toEqual({ runs: body, dropped: 0 });
  });

  it("a partly-usable response keeps its usable part", () => {
    // The 90%-good case. Blanking the board here would lose real work over
    // entries that were never renderable in the first place.
    const good = run("a");
    const { runs, dropped } = parseRuns([good, null, 42, { no_id: true }, "x"]);
    expect(runs).toEqual([good]);
    expect(dropped).toBe(4);
  });

  it("every entry is either kept or counted — nothing vanishes unaccounted for", () => {
    // The property that makes `dropped` trustworthy: it is not a guess, it is
    // the complement of what was kept. A filter that silently lost an entry
    // without incrementing the count would fail here.
    for (const body of [
      [],
      [run("a")],
      [null, null],
      [run("a"), undefined, run("b"), { run_id: "" }],
      [[], {}, 0, false, run("z")],
    ]) {
      const { runs, dropped } = parseRuns(body);
      expect(runs.length + dropped, JSON.stringify(body)).toBe(body.length);
    }
  });

  it("a run needs an id, because a card without one cannot be opened", () => {
    // page.tsx keys cards by run_id and routes to /runs/<run_id>. An entry
    // without one renders a card that goes nowhere.
    expect(parseRuns([{ status: "running" }]).runs).toEqual([]);
    expect(parseRuns([{ run_id: "" }]).runs).toEqual([]);
    expect(parseRuns([{ run_id: 7 }]).runs).toEqual([]);
    expect(parseRuns([{ run_id: "ok" }]).runs).toHaveLength(1);
  });

  it("an array is not mistaken for a run", () => {
    // `typeof [] === "object"`, so a nested array would pass a naive object
    // check and reach render as a run with no fields.
    expect(parseRuns([[run("a")]]).dropped).toBe(1);
  });
});

describe("the relationship the bug was actually about", () => {
  it("whatever parseRuns returns, the board can group it without throwing", () => {
    // The end of the crash path, closed. groupRuns is what iterated the body
    // and threw; this asserts its input is now always something it can take.
    for (const body of [
      [run("a", "running"), run("b", "completed"), run("c", "failed")],
      // A status this build has no column for, alongside entries that are not
      // runs at all — the `other` column exists for the first, and parseRuns
      // removes the second before groupRuns ever sees them.
      [null, "nope", { run_id: "d", status: "who-knows" }],
      [],
    ]) {
      const { runs } = parseRuns(body as unknown[]);
      expect(() => groupRuns(runs)).not.toThrow();
      expect(totalIn(groupRuns(runs))).toBe(runs.length);
    }
  });

  it("a non-array is reported the same way a 500 is: by throwing to the caller", () => {
    // Not a cosmetic point. useRuns has one catch block, and it is the block
    // that keeps the board and schedules the next poll. Routing malformed
    // bodies into it is the entire fix — the alternative was a second,
    // unrecoverable failure mode sitting beside a working one.
    const notOk = () => {
      throw new Error("Failed to fetch runs: 500");
    };
    const malformed = () => parseRuns({ runs: [] });
    for (const f of [notOk, malformed]) expect(f).toThrow(Error);
  });
});

describe("the message a person reads", () => {
  it("counts agree in singular and plural", () => {
    expect(droppedMessage(1)).toContain("1 run in");
    expect(droppedMessage(1)).not.toContain("runs");
    expect(droppedMessage(3)).toContain("3 runs");
  });

  it("says the entries are not shown, which is the part that matters", () => {
    // The banner's job is to stop someone trusting a board they can see is
    // short. "Malformed" alone would not tell them work is missing.
    expect(droppedMessage(2)).toMatch(/not shown/);
  });
});
