/**
 * EVERY MODULE'S VALUE EXPORTS REACH THE BARREL — DERIVED, NOT LISTED (#438).
 *
 * WHY THIS FILE EXISTS. `public-api.test.ts` asserts the rung-agnostic surface
 * with a hand-written list of static imports. That is right for what it does —
 * type-level shape checks — and it is not a completeness guard, though its name
 * invites reading it as one. Measured on main when #438 was filed: `ApprovalCard`
 * appeared 11 times in it; `ApprovalDecisionFailure`, `ApprovalPauseCard`,
 * `useApprovalPauseController` and `DECISIONS_FIELD` appeared ZERO times. Its
 * contents are a snapshot of the API its name claims to pin.
 *
 * That gap is not theoretical. #416 and #428 both added exports at the SAME
 * anchor in index.ts, and the merge conflict was additive — taking either side
 * wholesale drops the other's exports and still compiles, because a barrel
 * exporting 89 of 104 symbols is perfectly well-typed. Nothing goes red; the
 * missing names surface only where something imports them.
 *
 * THE SUBJECT IS DERIVED FROM THE MODULE SYSTEM, WHICH IS THE POINT. Two
 * attempts at reading the barrel textually failed in five minutes, on the exact
 * task of counting exports: one reported ZERO, because it required `};` against
 * a file that is all `export { … } from "…"`; the next reported SEVEN missing,
 * of which at least `TESTING_STATUSES` was a false negative — a multi-line
 * comment inside the export braces got attached to the following name by a comma
 * split. The runtime instrument reports ONE. A guard for "did we drop an export"
 * that miscounts exports fails in the silent direction, which is the direction
 * that made #438 possible; so the instrument here is `import()` and the module
 * namespace object, not a parser. Same argument as the conformance suites in
 * packages/test-utils driving the real implementations rather than a copy.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT COVER: TYPE-ONLY EXPORTS.
 *
 * `ApprovalCardProps`, `ApprovalDecisionFailure` and every other `export type`
 * are erased before runtime, so they are absent from the namespace object and
 * this file cannot see them. Covering them means the TypeScript compiler API,
 * which is a build rather than a test, and it is tracked separately.
 *
 * This limitation is stated HERE, where a reader hits it, and not only in a PR
 * description — because the defect this file replaces is precisely a name that
 * claims more than the contents deliver. Both of the collisions that motivated
 * it dropped VALUE exports too, so this catches the observed failures.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * EJECT-SAFE WITHOUT KNOWING ABOUT RUNGS. The subject is the files that EXIST.
 * A fork that ejected rung 4 has no PlanCard.tsx to glob and a barrel
 * regenerated without it, so both sides shrink together and this stays true with
 * no manifest lookup — `rung-surface.test.ts` is the file that asserts the
 * rung-owned half, derived from rungs.json.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as barrel from "./index";

/**
 * Symbols a module exports for its own siblings rather than for consumers.
 *
 * EVERY ENTRY CARRIES A REASON, and that is a deliberate cost. An exception list
 * that is easy to append to is how the next snapshot forms: the first
 * genuinely-internal module becomes a one-line addition, then a habit. Having to
 * write down WHY makes extending it a decision instead of a reflex.
 */
const NOT_PUBLIC: Record<string, string> = {
  KNOWN_DATA_PART_TYPES:
    "test support, consumed only by schemas.test.ts so its cases are derived " +
    "from the ladder rather than hardcoded — the same anti-snapshot argument " +
    "this file is making. Exporting it would publish a list no consumer needs.",
};

/**
 * Every non-test module in this package.
 *
 * Enumerated with `readdirSync` rather than `import.meta.glob`: the latter is a
 * Vite API that this package's tsconfig does not type, and reaching for
 * `vite/client` types to hold a test would put a bundler dependency in the
 * package's type graph. `rung-surface.test.ts` beside this one reads the
 * filesystem for the same reason.
 */
function moduleFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...moduleFiles(join(dir, entry.name), rel));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    if (rel === "index.ts") continue;
    out.push(rel);
  }
  return out;
}

const SUBJECT = moduleFiles(__dirname);

const MODULE_COUNT = SUBJECT.length;
const BARREL_NAMES = new Set(Object.keys(barrel));

/*
 * THE COUNTS ARE IN THE TITLE, so the subject is part of the answer.
 *
 * "PASS" is not falsifiable at a glance and is how a guard that has lost its
 * subject survives review. "21 modules, 48 exports" is: if a directory rename or
 * a moved src silently stops the glob matching, the name reads "0 modules" and
 * the refusal below fires rather than a clean pass over nothing.
 */
describe(`the barrel covers every module's value exports — ${MODULE_COUNT} modules, ${BARREL_NAMES.size} exports (#438)`, () => {
  it("REFUSES to run against an empty subject", () => {
    /*
     * The vacuous-pass guard, and the reason it is first. With zero modules the
     * completeness check below iterates nothing and passes — "0 missing
     * exports" — which turns this file off permanently while it stays green.
     * That is the shape this repo keeps building by accident: a check that names
     * a property and cannot fail.
     */
    expect(
      MODULE_COUNT,
      "found no modules to check — the glob './**/*.{ts,tsx}' matched nothing " +
        "under packages/react/src. A moved or renamed source directory turns " +
        "this guard off silently; it must refuse instead."
    ).toBeGreaterThan(0);

    expect(
      BARREL_NAMES.size,
      "the barrel exported no value symbols at all — ./index.ts either failed " +
        "to import or has been emptied. Either way there is nothing to check " +
        "completeness against."
    ).toBeGreaterThan(0);
  });

  it("every value export of every module is reachable from the barrel", async () => {
    const missing: string[] = [];
    let symbolsSeen = 0;

    for (const path of SUBJECT) {
      const mod = (await import(`./${path}`)) as Record<string, unknown>;
      for (const name of Object.keys(mod)) {
        symbolsSeen++;
        if (BARREL_NAMES.has(name)) continue;
        if (name in NOT_PUBLIC) continue;
        missing.push(`${name}  (${path})`);
      }
    }

    expect(
      symbolsSeen,
      "the modules imported but exported nothing — the subject is empty one " +
        "level down, which the module count alone would not show."
    ).toBeGreaterThan(0);

    expect(
      missing,
      "these value exports are not reachable from ./index.ts. Either add them " +
        "to the barrel, or record them in NOT_PUBLIC WITH A REASON. This is the " +
        "assertion an additive merge conflict trips: taking one side of an " +
        "index.ts collision drops the other side's exports and still compiles."
    ).toEqual([]);
  });

  it("the exception list has not become a second snapshot", () => {
    /*
     * The list is allowed to exist and is not allowed to grow quietly. Each
     * entry must name a real symbol that is genuinely absent from the barrel —
     * so an entry whose symbol was later exported, renamed or deleted fails
     * here instead of sitting as permanent cover for a name that no longer
     * needs it. That is the expiry the file it replaces suffered from.
     */
    for (const [name, reason] of Object.entries(NOT_PUBLIC)) {
      expect(
        reason.length,
        `${name} is excepted without a reason — write down why it is internal`
      ).toBeGreaterThan(40);
      expect(
        BARREL_NAMES.has(name),
        `${name} is listed in NOT_PUBLIC but IS exported from the barrel — the ` +
          "exception is stale and should be deleted rather than left as cover."
      ).toBe(false);
    }
  });
});
