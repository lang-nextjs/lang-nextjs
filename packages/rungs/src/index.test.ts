import { describe, expect, it } from "vitest";
import {
  RUNGS, RUNG_BY_ID, RUNG_IDS, matrixCells, retainedRungs, rungHref, assertNever,
} from "./index";

describe("rung manifest", () => {
  it("finds rungs at all (guards against the generated file collapsing to empty)", () => {
    // Without this, every assertion below is vacuously true over an empty array — the same
    // failure mode packages/server/src/severability.test.ts guards with its >10-modules check.
    expect(RUNGS.length).toBeGreaterThanOrEqual(5);
    expect(RUNG_IDS).toContain("langchain");
    expect(RUNG_IDS).toContain("open-swe");
  });

  it("ordinals are dense and ascending", () => {
    expect(RUNGS.map((r) => r.ordinal)).toEqual(RUNGS.map((_, i) => i + 1));
  });

  it("each rung requires exactly the rung below it — the superset chain", () => {
    for (const r of RUNGS) {
      const expected = r.ordinal === 1 ? [] : [RUNGS[r.ordinal - 2].id];
      expect(r.requires).toEqual(expected);
    }
  });

  it("retainedRungs() closes downward, never leaving a bare rung", () => {
    expect(retainedRungs("langchain").map((r) => r.id)).toEqual(["langchain"]);
    expect(retainedRungs("deepagents").map((r) => r.id)).toEqual([
      "langchain", "langgraph", "deepagents",
    ]);
    // Ejecting to the top retains everything; ejecting to the bottom retains one.
    expect(retainedRungs(RUNGS[RUNGS.length - 1].id)).toHaveLength(RUNGS.length);
  });
});

describe("matrixCells — the ragged ladder", () => {
  const cells = matrixCells();

  it("emits 15 cells, not the 20 a uniform grid would", () => {
    // 3x2x3 = 20 assumes every (rung, runtime) offers every topology. Five of those do not
    // exist. If this number moves, a real cell was added or dropped — check which.
    expect(cells).toHaveLength(15);
  });

  it("deep-research exists in exactly one pair", () => {
    // The one ragged cell. A rung-level topologies[] could not express this: it would either
    // invent django x deep-research (which 404s) or drop fastapi's real one.
    const dr = cells.filter((c) => c.topology === "deep-research");
    expect(dr).toHaveLength(1);
    expect(dr[0].rung).toBe("deepagents");
    expect(dr[0].runtime).toBe("fastapi");
  });

  it("empty topologies means ONE cell with no axis, never zero", () => {
    // If empty collapsed to zero, every run-shaped rung would vanish from the matrix silently.
    for (const rung of RUNGS) {
      for (const [runtime, cfg] of Object.entries(rung.runtimes)) {
        if (cfg.topologies.length > 0) continue;
        const forPair = cells.filter((c) => c.rung === rung.id && c.runtime === runtime);
        expect(forPair).toHaveLength(1);
        expect(forPair[0].topology).toBeUndefined();
      }
    }
    expect(cells.filter((c) => c.topology === undefined).length).toBeGreaterThan(0);
  });

  it("every conversation cell names a topology and every run cell does not", () => {
    for (const c of cells) {
      if (c.shape === "conversation") expect(c.topology).toBeDefined();
      else if (c.shape === "run") expect(c.topology).toBeUndefined();
      else assertNever(c.shape);
    }
  });
});

describe("rungHref — the [param] substitution rule", () => {
  it("substitutes [param] with value for a param target", () => {
    expect(rungHref(RUNG_BY_ID["langchain"])).toBe("/r/langchain");
    expect(rungHref(RUNG_BY_ID["deepagents"])).toBe("/r/deepagents");
  });

  it("uses the env origin for a cross-origin target, falling back when unset", () => {
    const openSwe = RUNG_BY_ID["open-swe"];
    expect(rungHref(openSwe, {})).toBe("http://localhost:3001/");
    expect(rungHref(openSwe, { NEXT_PUBLIC_QUEUE_URL: "https://swe.example" }))
      .toBe("https://swe.example/");
  });

  it("returns null for a planned rung so callers cannot render a dead link", () => {
    const planned = RUNGS.filter((r) => r.state === "planned");
    expect(planned.length).toBeGreaterThan(0);
    for (const r of planned) expect(rungHref(r)).toBeNull();
  });

  it("leaves no unsubstituted [param] placeholder in any href", () => {
    for (const r of RUNGS) {
      const href = rungHref(r);
      if (href !== null) expect(href).not.toMatch(/\[|\]/);
    }
  });
});
