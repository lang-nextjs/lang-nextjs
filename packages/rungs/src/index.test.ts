import { describe, expect, it } from "vitest";
import {
  RUNGS,
  RUNG_BY_ID,
  RUNG_IDS,
  matrixCells,
  retainedRungs,
  rungHref,
  assertNever,
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
    // Stated over EVERY rung the manifest declares, with no literal id anywhere. Naming
    // "deepagents" here was a type error in a rung-1 fork, where RungId narrows to the single
    // literal "langchain" — TS7053, indexing a Record keyed by a union that no longer contains
    // the name. A test that breaks the fork's typecheck is a severability defect like any other.
    for (const rung of RUNGS) {
      // The expected closure, computed from `requires` rather than written down: everything at
      // or below this rung's ordinal, in order.
      const expected = RUNGS.filter((r) => r.ordinal <= rung.ordinal).map(
        (r) => r.id
      );
      expect(retainedRungs(rung.id).map((r) => r.id)).toEqual(expected);
    }
    // The bottom rung retains exactly itself; the top retains the whole ladder. True at one rung
    // (where they are the same rung) and at five.
    expect(retainedRungs(RUNGS[0].id).map((r) => r.id)).toEqual([RUNGS[0].id]);
    expect(retainedRungs(RUNGS[RUNGS.length - 1].id)).toHaveLength(
      RUNGS.length
    );
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
        Object.values(r.runtimes).reduce(
          (m, cfg) => m + Math.max(1, cfg.topologies.length),
          0
        ),
      0
    );
    expect(cells).toHaveLength(expected);

    // Raggedness, stated as a CORRESPONDENCE rather than as "not a uniform grid".
    //
    // "cells < rungs x runtimes x topologies" was itself a full-ladder assumption: in a rung-1
    // fork the ladder has ONE rung and every (rung, runtime) pair offers the same two
    // topologies, so the grid genuinely IS uniform — 1 x 2 x 2 = 4 cells, and `toBeLessThan(4)`
    // failed for the correct reason at the wrong time. Raggedness is a property the manifest
    // may or may not have; it is not something every tree must exhibit.
    //
    // So: derive whether this manifest is ragged, then assert the matching arithmetic. Both
    // branches say something, at one rung and at five.
    const runtimes = new Set(RUNGS.flatMap((r) => Object.keys(r.runtimes)));
    const topologies = new Set(
      RUNGS.flatMap((r) =>
        Object.values(r.runtimes).flatMap((c) => c.topologies)
      )
    );
    const pairCounts = RUNGS.flatMap((r) =>
      Object.values(r.runtimes).map((c) => c.topologies.length)
    );
    const isRagged = new Set(pairCounts).size > 1;
    const uniform = RUNGS.length * runtimes.size * topologies.size;

    if (isRagged) {
      // A ragged ladder cannot fill the grid — that is what ragged means.
      expect(cells.length).toBeLessThan(uniform);
    } else if (topologies.size > 0) {
      // A uniform ladder must fill it exactly, which is the equally strong claim in that case
      // and would catch a cell being invented or dropped.
      expect(cells.length).toBe(uniform);
    }
  });

  it("deep-research exists in exactly one pair, wherever the deepagents rung survives", () => {
    // The one ragged cell. A rung-level topologies[] could not express it: it would either
    // invent django x deep-research (which 404s) or drop fastapi's real one.
    //
    // Skipped, not asserted, in a fork that ejected rung 3 — it has no deep-research to have an
    // opinion about, and asserting "exactly one" there would fail for the right reason at the
    // wrong time.
    // Derived from the manifest, not gated on a literal rung id. `RUNG_IDS.includes("deepagents")`
    // does not typecheck in a fork whose RungId is a narrower union — the guard against a
    // full-ladder assumption was itself written as one.
    const declaredPairs = RUNGS.flatMap((r) =>
      Object.entries(r.runtimes)
        .filter(([, cfg]) => cfg.topologies.includes("deep-research"))
        .map(([runtime]) => `${r.id}/${runtime}`)
    );
    const emitted = cells
      .filter((c) => c.topology === "deep-research")
      .map((c) => `${c.rung}/${c.runtime}`);

    // The correspondence, which says something at every rung count including zero such pairs:
    // deep-research appears in exactly the pairs the manifest gives it, and nowhere else.
    expect(emitted.sort()).toEqual(declaredPairs.sort());

    // And where it exists at all, it is ragged — one pair, not a whole runtime or a whole rung.
    if (declaredPairs.length > 0) {
      expect(declaredPairs).toHaveLength(1);
    }
  });

  it("empty topologies means ONE cell with no axis, never zero", () => {
    // If empty collapsed to zero, every run-shaped rung would vanish from the matrix silently.
    for (const rung of RUNGS) {
      for (const [runtime, cfg] of Object.entries(rung.runtimes)) {
        if (cfg.topologies.length > 0) continue;
        const forPair = cells.filter(
          (c) => c.rung === rung.id && c.runtime === runtime
        );
        expect(forPair).toHaveLength(1);
        expect(forPair[0].topology).toBeUndefined();
      }
    }
    // Only assert a run-shaped cell EXISTS when the manifest still declares a run-shaped rung.
    // In a conversation-only fork the correct count is zero, and a `> 0` floor cannot say so.
    if (RUNGS.some((r) => r.shape === "run")) {
      expect(
        cells.filter((c) => c.topology === undefined).length
      ).toBeGreaterThan(0);
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
  it("substitutes [param] with value for every param target the manifest declares", () => {
    // A per-element claim, written as a per-element assertion instead of as a lookup of a
    // literal id. `RUNG_BY_ID["deepagents"]` is TS7053 in a rung-1 fork: the Record is keyed by
    // a union that no longer contains the name, so the SUBJECT does not exist — the other
    // failure mode of the aggregate family, alongside a count that passes on compensating
    // errors. Count where the property is a quantity; correspondence where it is a
    // correspondence, and this is a correspondence.
    const params = RUNGS.filter((r) => r.target.kind === "param");
    for (const rung of params) {
      const t = rung.target as Extract<typeof rung.target, { kind: "param" }>;
      expect(rungHref(rung), `${rung.id} href`).toBe(
        t.route.replace(`[${t.param}]`, t.value)
      );
    }
    // Non-vacuity without a full-ladder number: whatever the manifest declares, the ladder's
    // lowest rung is retained by every fork, so at least one param target exists in any tree.
    expect(params.length).toBeGreaterThan(0);
  });

  it("uses the env origin for every cross-origin target, falling back when unset", () => {
    const origins = RUNGS.filter((r) => r.target.kind === "origin");
    for (const rung of origins) {
      const t = rung.target as Extract<typeof rung.target, { kind: "origin" }>;
      expect(rungHref(rung, {}), `${rung.id} fallback`).toBe(
        `${t.originFallback}${t.route}`
      );
      expect(
        rungHref(rung, { [t.originEnv]: "https://swe.example" }),
        `${rung.id} env`
      ).toBe(`https://swe.example${t.route}`);
    }
    // Zero cross-origin rungs is a legitimate answer in a fork that ejected them, so this
    // asserts the correspondence rather than a count. The loop above is the whole claim.
    expect(origins.every((r) => rungHref(r) !== null)).toBe(true);
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
        expect(
          rungHref(r),
          `${r.id} has no target but produced a link`
        ).toBeNull();
      } else {
        expect(
          rungHref(r),
          `${r.id} has a target but produced no link`
        ).not.toBeNull();
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
