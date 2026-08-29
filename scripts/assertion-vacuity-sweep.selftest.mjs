#!/usr/bin/env node
/**
 * THE SWEEP IS WATCHED FINDING KNOWN INSTANCES BEFORE IT IS TRUSTED ON UNKNOWN
 * ONES (#328).
 *
 * A sweep that reports "0 found" is indistinguishable from a sweep that
 * searched wrong. That is the defect #328 collects, so an uncalibrated sweep
 * for it would be an instance of its own subject — and it would be the worst
 * kind, because its output is used to decide NOT to look further.
 *
 * WHY POSITIVE FIXTURES RATHER THAN A MUTATION. DEV3's corollary on #328: the
 * mutation is a check too, and it has the same failure mode as everything else
 * here — #339 specified a mutation that could not fail, so following the issue
 * faithfully would have shipped the defect it was written to prevent. A
 * fixture that CONTAINS a known instance is stronger: a broken regex cannot
 * find it, whatever else the sweep reports, and the evidence does not expire
 * the way a one-off mutation's does.
 *
 * THE FIXTURES ARE REAL — the code as it stood at commit 9b5e64e, before #327
 * fixed it. Not written for this test: an invented fixture proves only that the
 * sweep matches what I imagined the bug looked like.
 *
 * THEY ARE VENDORED AS LITERALS, NOT READ FROM GIT, and that is deliberate. The
 * first version ran `git show 9b5e64e:<path>` and passed here and failed in CI:
 * actions/checkout clones shallow, so the commit is simply not in the runner's
 * history. Unshallowing would have fixed the symptom and left the cause — a
 * fixture fetched from history is not a fixture, it is a REFERENCE to one, and
 * it inherits every property of the thing storing it. Today that is clone
 * depth; tomorrow a rebase, a force-push, or a gc makes the sha unreachable and
 * the failure reads as "the sweep is broken" rather than "the reference rotted".
 * Git history is not maintained as test infrastructure by anyone.
 *
 * Vendoring also makes them READABLE: the locator that motivated each shape is
 * visible here, without resolving a sha to see it.
 *
 * SHAPE B'S FIXTURE PAIRS AN OLD SPEC WITH NEW DEFINITIONS, and that is the
 * mechanism rather than a convenience. `framework-select` did not exist when
 * `[data-testid^="framework-"]` was written; #327 introduced it. The locator
 * never became wrong — the family it ranges over grew a member. Pairing the
 * old spec with the old app source would find nothing, correctly, and prove
 * nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SWEEP = join(HERE, "assertion-vacuity-sweep.mjs");

/* --------------------------------------------------------------------------
 * THE FIXTURES. Verbatim excerpts, kept minimal so each one shows the single
 * construct it is a fixture for.
 * ------------------------------------------------------------------------ */

/**
 * SHAPE A, BEFORE — open-swe-mobile.spec.ts at 9b5e64e.
 *
 * `if (!b) continue` was correct when written: it guarded an element that had
 * not laid out yet. #327 turned the pills into `<option>`s, an `<option>` in a
 * closed native select has no bounding box, so every iteration took the guard
 * and the test passed having executed ZERO assertions. The guard did not become
 * wrong — the thing being iterated changed underneath it.
 */
const FIXTURE_A_BEFORE = `
  test("nothing overflows the viewport at phone width", async ({ page }) => {
    const vw = page.viewportSize()!.width;
    const pills = page.locator('[data-testid^="framework-"]');
    for (let i = 0; i < (await pills.count()); i++) {
      const b = await pills.nth(i).boundingBox();
      if (!b) continue;
      expect(b.x + b.width, \`framework pill \${i} runs off screen\`).toBeLessThanOrEqual(vw + 1);
    }
  });
`;

/** SHAPE A, AFTER — the remedy #327 used: assert the box exists, never skip. */
const FIXTURE_A_AFTER = `
  test("nothing overflows the viewport at phone width", async ({ page }) => {
    const box = await card.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box, "the card has no box").not.toBeNull();
    expect(box!.width, "the card is wider than the screen").toBeLessThanOrEqual(vw);
  });
`;

/**
 * SHAPE B, BEFORE — open-swe-remaining-paths.spec.ts at 9b5e64e.
 *
 * `framework-` was unambiguous when written. #327 added `framework-select`,
 * `framework-substituted` and `framework-switch-separator`, and the prefix
 * silently began matching the control it was meant to exclude. Pairing this
 * with CURRENT definitions is the whole point: against the definitions of its
 * own day it finds nothing, correctly, and proves nothing.
 */
const FIXTURE_B_BEFORE = `
  test("every framework button carries aria-pressed", async ({ page }) => {
    const buttons = page.locator('[data-testid^="framework-"]');
    await expect(buttons.first()).toBeVisible();
    const n = await buttons.count();
    expect(n).toBeGreaterThan(1);
    await expect(
      page.locator('[data-testid^="framework-"][aria-pressed="true"]')
    ).toHaveCount(1);
  });
`;

/** SHAPE B, AFTER — an exact testid, which cannot range over its siblings. */
const FIXTURE_B_AFTER = `
  test("choosing a framework MOVES the selection", async ({ page }) => {
    const select = page.getByTestId("framework-select");
    await expect(select).toBeVisible();
  });
`;

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(
    `  ${cond ? "ok  " : "FAIL"}   ${name}${detail ? `   ${detail}` : ""}`
  );
  if (!cond) failures++;
};

function sweep(dir, defs) {
  const out = execFileSync(
    process.execPath,
    [SWEEP, "--dir", "e2e", "--defs", defs, "--json"],
    { cwd: dir, encoding: "utf-8", maxBuffer: 1024 * 1024 * 8 }
  );
  return JSON.parse(out);
}

/** A scratch tree containing one spec under e2e/. */
function stage(specSource) {
  const dir = mkdtempSync(join(tmpdir(), "vac-selftest-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "fixture.spec.ts"), specSource);
  return dir;
}

console.log("assertion-vacuity-sweep selftest\n");

/* ---------------------------------------------------------------------- */
/* 0. THE FIXTURES STILL CONTAIN WHAT THEY ARE FIXTURES FOR.               */
/*    Vendoring removed the "unreadable at <sha>" failure mode by          */
/*    construction — there is no fetch left to fail. What replaces it is   */
/*    stronger, because it can catch something vendoring introduced: an    */
/*    edit to the literal that quietly removes the construct. Without      */
/*    these, every "found it" below could be matching an empty string.     */
/* ---------------------------------------------------------------------- */
const oldA = FIXTURE_A_BEFORE;
const newA = FIXTURE_A_AFTER;
const oldB = FIXTURE_B_BEFORE;
const newB = FIXTURE_B_AFTER;

ok(
  "fixture A (before) is non-empty",
  oldA.trim().length > 100,
  `${oldA.length} bytes`
);
ok(
  "fixture B (before) is non-empty",
  oldB.trim().length > 100,
  `${oldB.length} bytes`
);
ok(
  "fixture A still contains the guard it is a fixture FOR",
  /if \(!b\) continue;/.test(oldA)
);
ok(
  "fixture B still contains the prefix it is a fixture FOR",
  /data-testid\^="framework-"/.test(oldB)
);
ok(
  "fixture A (after) does NOT contain it — or the negative case is worthless",
  !/if \(!b\) continue;/.test(newA)
);
ok(
  "fixture B (after) does NOT contain it",
  !/data-testid\^="framework-"/.test(newB)
);

/* ---------------------------------------------------------------------- */
/* 1. SHAPE A — positive, then negative.                                   */
/* ---------------------------------------------------------------------- */
{
  const dir = stage(oldA);
  const { shapeA } = sweep(dir, "");
  ok(
    "SHAPE A finds the known instance (open-swe-mobile before #327)",
    shapeA.some((f) => /if \(!b\) continue/.test(f.guard)),
    `found ${shapeA.length}`
  );
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = stage(newA);
  const { shapeA } = sweep(dir, "");
  ok(
    "SHAPE A does NOT flag the fixed version",
    !shapeA.some((f) => /if \(!b\) continue/.test(f.guard)),
    `found ${shapeA.length}`
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------- */
/* 2. SHAPE B — old spec against CURRENT definitions.                      */
/* ---------------------------------------------------------------------- */
{
  const dir = stage(oldB);
  const { shapeB, definedCount } = sweep(
    dir,
    join(REPO, "apps") + "," + join(REPO, "packages")
  );
  /*
   * THE INSTRUMENT FOUND ITS INPUTS. Without this, the two assertions below
   * could only ever fail — and the FIRST version of this selftest did exactly
   * that: `--defs` got absolute paths, `join(cwd, abs)` walked nothing, the
   * definition set was empty, and SHAPE B was structurally incapable of
   * reporting anything. It had nonetheless printed 5 findings against the real
   * repo moments earlier, which is what made it look like it worked.
   */
  ok(
    "  ...having actually loaded the definitions",
    definedCount > 50,
    `${definedCount} testids`
  );
  const hit = shapeB.find((f) => f.prefix === "framework-");
  ok(
    "SHAPE B finds the known ambiguous prefix (framework- vs framework-select)",
    Boolean(hit),
    hit ? `matches ${hit.matches.join(", ")}` : "not found"
  );
  ok(
    "  ...and names the sibling that made it ambiguous",
    Boolean(hit?.matches.includes("framework-select"))
  );
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = stage(newB);
  const { shapeB } = sweep(
    dir,
    join(REPO, "apps") + "," + join(REPO, "packages")
  );
  ok(
    "SHAPE B does NOT flag the fixed version",
    !shapeB.some((f) => f.prefix === "framework-"),
    `found ${shapeB.length}`
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------- */
/* 3. THE VACUITY CASE, asserted rather than assumed.                      */
/*    An empty definition set makes SHAPE B structurally unable to fire.   */
/*    This is not hypothetical — the first calibration run of this sweep    */
/*    reported a clean 0 for that exact reason.                            */
/* ---------------------------------------------------------------------- */
{
  const dir = stage(oldB);
  const { shapeB } = sweep(dir, "");
  ok(
    "SHAPE B with NO definitions reports 0 — the false-clean this guards against",
    shapeB.length === 0,
    "sweep prints a WARNING in this case; see its output"
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------- */
/* 4. THE GATE ITSELF, watched failing and watched passing.                */
/*    `--strict A` is what CI runs. A gate that has only ever been seen     */
/*    exiting 0 is indistinguishable from one that cannot exit 1 — which    */
/*    is this issue's subject applied to the tool built for this issue.     */
/* ---------------------------------------------------------------------- */
function strictExit(dir) {
  try {
    execFileSync(
      process.execPath,
      [SWEEP, "--dir", "e2e", "--defs", "", "--strict", "A"],
      {
        cwd: dir,
        encoding: "utf-8",
        stdio: "pipe",
      }
    );
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}
{
  const dirty = stage(oldA);
  ok("--strict A EXITS 1 on the known instance", strictExit(dirty) === 1);
  rmSync(dirty, { recursive: true, force: true });

  const clean = stage(newA);
  ok("--strict A exits 0 on the fixed version", strictExit(clean) === 0);
  rmSync(clean, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nPASS: the sweep was watched finding both known instances, and not\n" +
        "      flagging either fixed version. A zero from it means something."
    : `\nFAIL: ${failures} calibration check(s) failed. Do not trust this sweep's output.`
);
process.exit(failures === 0 ? 0 : 1);
