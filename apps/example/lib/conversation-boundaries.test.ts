import { describe, expect, it } from "vitest";
import {
  conversationBoundaries,
  describeCell,
  sameCell,
  type BoundaryInput,
  type Cell,
} from "./conversation-boundaries";

/**
 * #253 names the trap this file exists to avoid:
 *
 *   "a separator component that always renders would satisfy the first
 *    assertion and destroy the feature's meaning"
 *
 * So the CONTROLS carry as much weight as the positive cases, and they are
 * first. A reducer that returned one boundary per message would pass "a change
 * produces a separator" and be worthless.
 */

const A: Cell = {
  runtime: "fastapi",
  framework: "langchain",
  topology: "react",
};
const B: Cell = {
  runtime: "fastapi",
  framework: "deepagents",
  topology: "react",
};
const C: Cell = {
  runtime: "django",
  framework: "langchain",
  topology: "react",
};

const msgs = (...spec: [string, Cell | undefined][]): BoundaryInput[] =>
  spec.map(([id, cell]) => ({ id, cell }));

describe("controls — the separator must be able NOT to appear", () => {
  it("a conversation that never switches produces NO boundary", () => {
    const out = conversationBoundaries(
      msgs(["m1", A], ["m2", A], ["m3", A], ["m4", A])
    );
    expect(out).toEqual([]);
  });

  it("the FIRST cell produces no boundary — nothing to have switched from", () => {
    expect(conversationBoundaries(msgs(["m1", A]))).toEqual([]);
  });

  it("an empty transcript produces no boundary", () => {
    expect(conversationBoundaries([])).toEqual([]);
  });

  it("messages no agent produced cannot open a section", () => {
    // A user turn and a client-rendered card carry no cell. If they counted,
    // every user message would look like a change away and back.
    const out = conversationBoundaries(
      msgs(["u1", undefined], ["m1", A], ["u2", undefined], ["m2", A])
    );
    expect(out).toEqual([]);
  });
});

describe("a change produces exactly one boundary, before the new cell's message", () => {
  it("one switch, one boundary", () => {
    const out = conversationBoundaries(msgs(["m1", A], ["m2", B]));
    expect(out).toHaveLength(1);
    expect(out[0].beforeMessageId).toBe("m2");
    expect(out[0].from).toEqual(A);
    expect(out[0].to).toEqual(B);
    expect(out[0].label).toBe("switched to fastapi · deepagents · react");
  });

  it("a run of messages in the NEW cell still produces only the one", () => {
    const out = conversationBoundaries(
      msgs(["m1", A], ["m2", A], ["m3", B], ["m4", B], ["m5", B])
    );
    expect(out).toHaveLength(1);
    expect(out[0].beforeMessageId).toBe("m3");
  });

  it("a user turn between the two does not displace the boundary", () => {
    const out = conversationBoundaries(
      msgs(["m1", A], ["u1", undefined], ["m2", B])
    );
    expect(out).toHaveLength(1);
    expect(out[0].beforeMessageId).toBe("m2");
  });
});

describe("switching back is a second boundary, not a cancellation", () => {
  it("A -> B -> A produces two", () => {
    const out = conversationBoundaries(msgs(["m1", A], ["m2", B], ["m3", A]));
    expect(out.map((b) => b.beforeMessageId)).toEqual(["m2", "m3"]);
    expect(out.map((b) => b.label)).toEqual([
      "switched to fastapi · deepagents · react",
      "switched to fastapi · langchain · react",
    ]);
  });

  it("three distinct cells produce two boundaries", () => {
    const out = conversationBoundaries(msgs(["m1", A], ["m2", B], ["m3", C]));
    expect(out).toHaveLength(2);
    expect(out[1].to).toEqual(C);
  });
});

describe("a cell differs on any axis, not just framework", () => {
  it.each([
    ["runtime", { ...A, runtime: "django" }],
    ["framework", { ...A, framework: "langgraph" }],
    ["topology", { ...A, topology: "plan-execute" }],
  ])("a change of %s is a change", (_axis, other) => {
    expect(sameCell(A, other as Cell)).toBe(false);
    expect(
      conversationBoundaries(msgs(["m1", A], ["m2", other as Cell]))
    ).toHaveLength(1);
  });

  it("identical cells are the same cell", () => {
    expect(sameCell(A, { ...A })).toBe(true);
  });

  it("describeCell names all three axes, so the label is unambiguous", () => {
    expect(describeCell(A)).toBe("fastapi · langchain · react");
  });
});
