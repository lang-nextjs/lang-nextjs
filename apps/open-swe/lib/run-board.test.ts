import { describe, it, expect } from "vitest";
import { groupRuns, totalIn, type BoardColumnId } from "./run-board";
import type { Run } from "./types";

const run = (
  id: string,
  status: string,
  created_at = "2026-01-01T00:00:00Z"
): Run =>
  ({ run_id: id, status, created_at, task: `task ${id}` } as unknown as Run);

const idsIn = (cols: ReturnType<typeof groupRuns>, id: BoardColumnId) =>
  cols.find((c) => c.id === id)!.runs.map((r) => r.run_id);

describe("groupRuns — routing", () => {
  it("puts each known status in its column", () => {
    const cols = groupRuns([
      run("a", "pending"),
      run("b", "running"),
      run("c", "completed"),
      run("d", "failed"),
      run("e", "interrupted"),
    ]);
    expect(idsIn(cols, "backlog")).toEqual(["a"]);
    expect(idsIn(cols, "in-progress")).toEqual(["b"]);
    expect(idsIn(cols, "done")).toEqual(["c"]);
    expect(idsIn(cols, "errored")).toEqual(["d"]);
    expect(idsIn(cols, "needs-approval")).toEqual(["e"]);
  });

  it("never routes interrupted into in-progress", () => {
    // Folding HITL into "running" would hide the only column a human is
    // expected to act on.
    const cols = groupRuns([run("x", "interrupted")]);
    expect(idsIn(cols, "in-progress")).toEqual([]);
    expect(idsIn(cols, "needs-approval")).toEqual(["x"]);
  });
});

describe("groupRuns — nothing is ever dropped", () => {
  it("keeps an unrecognised status visible in `other`", () => {
    const cols = groupRuns([run("z", "queued-for-review")]);
    expect(idsIn(cols, "other")).toEqual(["z"]);
    expect(totalIn(cols)).toBe(1);
  });

  it("conserves every run across arbitrary inputs", () => {
    const runs = [
      run("1", "pending"),
      run("2", "running"),
      run("3", "completed"),
      run("4", "failed"),
      run("5", "interrupted"),
      run("6", "totally-new"),
      run("7", ""),
    ];
    const cols = groupRuns(runs);
    expect(totalIn(cols)).toBe(runs.length);
    // and exactly once each — no run appears in two columns
    const seen = cols.flatMap((c) => c.runs.map((r) => r.run_id));
    expect(new Set(seen).size).toBe(runs.length);
  });

  it("an empty queue yields empty columns, not a crash", () => {
    const cols = groupRuns([]);
    expect(totalIn(cols)).toBe(0);
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe("groupRuns — column visibility", () => {
  it("keeps the five real columns even when empty", () => {
    const cols = groupRuns([]);
    const always = cols.filter((c) => !c.hideWhenEmpty).map((c) => c.id);
    expect(always).toEqual([
      "backlog",
      "in-progress",
      "needs-approval",
      "done",
      "errored",
    ]);
  });

  it("marks `other` as hideable — it should not show for a healthy queue", () => {
    const cols = groupRuns([run("a", "pending")]);
    const other = cols.find((c) => c.id === "other")!;
    expect(other.hideWhenEmpty).toBe(true);
    expect(other.runs).toEqual([]);
  });
});

describe("groupRuns — ordering", () => {
  it("sorts newest first within a column", () => {
    const cols = groupRuns([
      run("old", "pending", "2026-01-01T00:00:00Z"),
      run("new", "pending", "2026-06-01T00:00:00Z"),
      run("mid", "pending", "2026-03-01T00:00:00Z"),
    ]);
    expect(idsIn(cols, "backlog")).toEqual(["new", "mid", "old"]);
  });

  it("sinks an unparseable timestamp instead of dropping the run", () => {
    const cols = groupRuns([
      run("bad", "pending", "not-a-date"),
      run("good", "pending", "2026-01-01T00:00:00Z"),
    ]);
    expect(idsIn(cols, "backlog")).toEqual(["good", "bad"]);
    expect(totalIn(cols)).toBe(2);
  });

  it("handles a missing timestamp without losing the run", () => {
    const cols = groupRuns([
      { run_id: "n", status: "pending", task: "t" } as unknown as Run,
    ]);
    expect(totalIn(cols)).toBe(1);
  });
});
