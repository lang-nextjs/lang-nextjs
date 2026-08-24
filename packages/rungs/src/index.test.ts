import { describe, expect, it } from "vitest";
import {
  RUNGS, RUNG_BY_ID, RUNG_IDS, matrixCells, retainedRungs, rungHref, assertNever,
} from "./index";

describe("rung manifest", () => {
  it("finds rungs at all (guards against the generated file collapsing to empty)", () => {
    // Without this, every assertion below is vacuously true over an empty array — the same
    // failure mode packages/server/src/severability.test.ts guards with its >10-modules check.
    // NOT >= 5. That was a full-ladder number and failed in every ejected fork — the ninth
    // instance tonight of a guard asserting the whole ladder and so breaking in exactly the
    // trees it protects. Rung 1 is the only rung EVERY fork retains, because the retain set is
    // the target plus its `requires` closure downward.
    expect(RUNGS.length).toBeGreaterThan(0);
    expect(RUNG_IDS).toContain("langchain");
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

  it("emits one cell per (rung, runtime, topology), never a uniform grid", () => {
    // The literal 15 was right on main and wrong in every fork. The PROPERTY is that the ladder
    // is ragged — arity follows the manifest rather than a product of axis sizes — so it is
    // stated as arithmetic over the manifest, which holds at every rung.
    const expected = RUNGS.reduce(
      (n, r) =>
        n +
        Object.values(r.runtimes).reduce((m, cfg) => m + Math.max(1, cfg.topologies.length), 0),
      0
    );
    expect(cells).toHaveLength(expected);

    // And it must NOT equal what a uniform grid would emit, or the raggedness is unproven.
    const runtimes = new Set(RUNGS.flatMap((r) => Object.keys(r.runtimes)));
    const topologies = new Set(
      RUNGS.flatMap((r) => Object.values(r.runtimes).flatMap((c) => c.topologies))
    );
    if (topologies.size > 0) {
      expect(cells.length).toBeLessThan(RUNGS.length * runtimes.size * topologies.size);
    }
  });

  it("deep-research exists in exactly one pair, wherever the deepagents rung survives", () => {
    // The one ragged cell. A rung-level topologies[] could not express it: it would either
    // invent django x deep-research (which 404s) or drop fastapi's real one.
    //
    // Skipped, not asserted, in a fork that ejected rung 3 — it has no deep-research to have an
    // opinion about, and asserting "exactly one" there would fail for the right reason at the
    // wrong time.
    if (!RUNG_IDS.includes("deepagents")) {
      expect(cells.filter((c) => c.topology === "deep-research")).toHaveLength(0);
      return;
    }
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
    // Only assert a run-shaped cell EXISTS when the manifest still declares a run-shaped rung.
    // In a conversation-only fork the correct count is zero, and a `> 0` floor cannot say so.
    if (RUNGS.some((r) => r.shape === "run")) {
      expect(cells.filter((c) => c.topology === undefined).length).toBeGreaterThan(0);
    }
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

  it("returns null exactly for rungs with no target, so callers cannot render a dead link", () => {
    // Stated over target.kind, not over `planned`, and with no count floor. A fork that ejected
    // the only planned rung legitimately has zero of them, and `> 0` cannot say so — the tenth
    // guard tonight that asserted a full-ladder fact and broke in an ejected tree.
    //
    // Non-vacuity comes from the BICONDITIONAL rather than a quantity: every rung is checked,
    // and null is required exactly when there is no target. That has something to say at every
    // rung count, including one.
    expect(RUNGS.length).toBeGreaterThan(0);
    for (const r of RUNGS) {
      if (r.target.kind === "none") {
        expect(rungHref(r), `${r.id} has no target but produced a link`).toBeNull();
      } else {
        expect(rungHref(r), `${r.id} has a target but produced no link`).not.toBeNull();
      }
    }
    // A `planned` rung must be one of the targetless ones wherever it survives.
    for (const r of RUNGS.filter((x) => x.state === "planned")) {
      expect(rungHref(r)).toBeNull();
    }
  });

  it("leaves no unsubstituted [param] placeholder in any href", () => {
    for (const r of RUNGS) {
      const href = rungHref(r);
      if (href !== null) expect(href).not.toMatch(/\[|\]/);
    }
  });
});
