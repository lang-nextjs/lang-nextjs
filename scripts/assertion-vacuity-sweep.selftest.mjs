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
 * THE FIXTURES ARE REAL, recovered from commit 9b5e64e — the tree before #327
 * fixed them. Not written for this test: an invented fixture proves the sweep
 * matches what I imagined the bug looked like.
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

/** The commit whose tree still contains both instances. */
const BEFORE = "9b5e64e";
const SHAPE_A_SPEC = "e2e/rungs/open-swe/open-swe-mobile.spec.ts";
const SHAPE_B_SPEC = "e2e/rungs/open-swe/open-swe-remaining-paths.spec.ts";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(
    `  ${cond ? "ok  " : "FAIL"}   ${name}${detail ? `   ${detail}` : ""}`
  );
  if (!cond) failures++;
};

function gitShow(rev, path) {
  return execFileSync("git", ["show", `${rev}:${path}`], {
    cwd: REPO,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 8,
  });
}

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
/* 0. The fixtures are real and non-trivial.                              */
/*    Without this, every "found it" below could be matching an empty      */
/*    string, and every "clean" could be a file that failed to load.       */
/* ---------------------------------------------------------------------- */
let oldA, oldB, newA, newB;
try {
  oldA = gitShow(BEFORE, SHAPE_A_SPEC);
  oldB = gitShow(BEFORE, SHAPE_B_SPEC);
  newA = gitShow("HEAD", SHAPE_A_SPEC);
  newB = gitShow("HEAD", SHAPE_B_SPEC);
} catch (e) {
  console.log(`  FAIL   fixtures unreadable at ${BEFORE}: ${e.message}`);
  process.exit(2);
}
ok(
  "fixture A (before) is non-empty",
  oldA.length > 500,
  `${oldA.length} bytes`
);
ok(
  "fixture B (before) is non-empty",
  oldB.length > 500,
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
