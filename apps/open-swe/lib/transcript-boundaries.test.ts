import { describe, expect, it } from "vitest";
import {
  boundariesFor,
  cellKey,
  changedValues,
  describeSwitch,
  type Cell,
} from "./transcript-boundaries";

/**
 * The rule is small; the ways to get it wrong are specific. Each of these is a
 * failure that would make the feature worse than not having it — a separator
 * before the first message, two in a row, one that fires when nothing changed —
 * and none are convenient to provoke through a browser.
 */

const cell = (over: Partial<Cell> = {}): Cell => ({
  framework: "langchain",
  runtime: "fastapi",
  topology: "react",
  ...over,
});

describe("boundariesFor", () => {
  it("an unbroken run of one cell produces NO separator", () => {
    // The common case, and the one that decides whether this feature is
    // tolerable: twenty messages under one framework must look like twenty
    // messages, not twenty announcements.
    const cells = Array.from({ length: 20 }, () => cell());
    expect(boundariesFor(cells)).toEqual([]);
  });

  it("a single switch produces EXACTLY ONE separator, at the first message after it", () => {
    const cells = [
      cell(),
      cell(),
      cell({ framework: "deepagents" }),
      cell({ framework: "deepagents" }),
    ];
    const b = boundariesFor(cells);
    expect(b).toHaveLength(1);
    expect(b[0].index).toBe(2);
    expect(b[0].from.framework).toBe("langchain");
    expect(b[0].to.framework).toBe("deepagents");
  });

  it("switching BACK produces a second separator", () => {
    // Not deduplicated by cell identity: returning to a framework is itself a
    // change, and a reader scanning for where the answers came from needs both.
    const cells = [cell(), cell({ framework: "deepagents" }), cell()];
    expect(boundariesFor(cells).map((x) => x.index)).toEqual([1, 2]);
  });

  it("NEVER before the first message", () => {
    // There is nothing to have switched from. A separator here reads as though
    // the conversation opened by changing something.
    expect(boundariesFor([cell()])).toEqual([]);
    expect(boundariesFor([cell({ framework: "deepagents" })])).toEqual([]);
  });

  it("an empty transcript produces nothing rather than throwing", () => {
    expect(boundariesFor([])).toEqual([]);
  });

  it("switching on RUNTIME alone is a boundary", () => {
    // The axis most likely to be forgotten, because the framework buttons are
    // the visible ones. Being answered by django instead of fastapi is exactly
    // as much a change of hands.
    const b = boundariesFor([cell(), cell({ runtime: "django" })]);
    expect(b).toHaveLength(1);
    expect(b[0].label).toContain("django");
  });

  it("switching on TOPOLOGY alone is a boundary", () => {
    const b = boundariesFor([cell(), cell({ topology: "plan-execute" })]);
    expect(b).toHaveLength(1);
    expect(b[0].label).toContain("plan-execute");
  });

  it("two axes changing at once produce ONE separator naming BOTH", () => {
    // Naming one and implying the other stayed put would be a false statement
    // about the transcript, which is the thing this feature exists to prevent.
    const b = boundariesFor([
      cell(),
      cell({ framework: "langgraph", topology: "plan-execute" }),
    ]);
    expect(b).toHaveLength(1);
    expect(b[0].label).toContain("langgraph");
    expect(b[0].label).toContain("plan-execute");
  });

  it("UNTAGGED messages are skipped, not treated as a change", () => {
    // Messages predating this feature carry no cell. Treating absent as
    // different would put a separator in front of every one of them — the
    // failure that gets a feature switched off rather than fixed.
    const cells = [cell(), undefined, undefined, cell()];
    expect(boundariesFor(cells)).toEqual([]);
  });

  it("an untagged message BETWEEN two different cells does not hide the switch", () => {
    // The control for the case above. Skipping untagged messages must not also
    // skip the comparison across them.
    const cells = [cell(), undefined, cell({ framework: "deepagents" })];
    const b = boundariesFor(cells);
    expect(b).toHaveLength(1);
    expect(b[0].index).toBe(2);
  });

  it("a transcript that is entirely untagged produces nothing", () => {
    expect(boundariesFor([undefined, undefined, undefined])).toEqual([]);
  });

  it("never emits two separators in a row for one change", () => {
    // A boundary is a transition, not a property of a message. This asserts the
    // count directly rather than inspecting the first one, because "the first
    // is right" is satisfied by an implementation that emits three.
    const cells = [
      cell(),
      cell({ framework: "langgraph" }),
      cell({ framework: "langgraph" }),
      cell({ framework: "langgraph" }),
    ];
    expect(boundariesFor(cells)).toHaveLength(1);
  });
});

describe("cellKey", () => {
  it("cells differing on any single axis are not equal", () => {
    const base = cell();
    for (const other of [
      cell({ framework: "langgraph" }),
      cell({ runtime: "django" }),
      cell({ topology: "plan-execute" }),
    ]) {
      expect(cellKey(base), JSON.stringify(other)).not.toBe(cellKey(other));
    }
  });

  it("identical cells are equal regardless of object identity", () => {
    expect(cellKey(cell())).toBe(cellKey(cell()));
  });
});

describe("describeSwitch", () => {
  it("names only what changed", () => {
    const s = describeSwitch(cell(), cell({ framework: "deepagents" }));
    expect(s).toContain("deepagents");
    // The unchanged axes must not appear, or every separator reads as a total
    // reconfiguration and stops carrying information.
    expect(s).not.toContain("fastapi");
    expect(s).not.toContain("react");
  });

  it("is empty when nothing changed", () => {
    // Guards the caller: an empty label is the signal that no separator belongs
    // here at all, and boundariesFor never produces one.
    expect(describeSwitch(cell(), cell())).toBe("");
  });

  it("changedValues reports every changed value, not just the first", () => {
    expect(
      changedValues(cell(), cell({ framework: "langgraph", runtime: "django" }))
    ).toEqual(["langgraph", "django"]);
  });
});
