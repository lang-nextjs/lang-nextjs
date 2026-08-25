#!/usr/bin/env node
/**
 * matrix.mjs — emit the severability CI matrix from rungs.json.
 *
 * ONE JOB PER (RUNG, LANGUAGE PLANE), NOT ONE PER RUNG.
 *
 * A 5-job matrix — one eject per rung — would run `pnpm eject` then `pnpm build && pnpm test`,
 * all of which is pnpm tooling. Neither Python backend has a package.json, so despite the
 * `apps/*` workspace glob pnpm cannot see them: both are absent from the lockfile while all four
 * TS apps are present. Eject EDITS that plane — two ai_backends modules per rung, two __init__
 * registries, two _MODULES dispatch dicts — and a pnpm-only job would never execute a line of
 * it. Five green ticks over a plane nothing ran.
 *
 * That is the same shape as a grep over a missing file: a confident verdict about something the
 * check never looked at.
 *
 * Rungs 1-3 own files in both planes, rungs 4-5 in ts only:  3x2 + 2x1 = 8.
 *
 * The arity is DERIVED from each rung's `languages`, never hardcoded. Add a Python
 * implementation for open-swe and a ninth job appears on its own, rather than that plane going
 * quietly unverified — which is exactly how a hardcoded list rots.
 *
 * Usage:  node scripts/matrix.mjs [--github]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// RUNGS_MANIFEST / RUNGS_CWD, matching classify.mjs and validate-manifest.mjs.
//
// This read `join(ROOT, "rungs.json")` unconditionally, so it could only ever be run against the
// live manifest — the third script of mine tonight to hardcode its subject, after
// gen-rung-types.mjs ignoring --cwd. That is not merely inconvenient: it is WHY this file had no
// selftest. A generator that cannot be pointed at a hypothetical manifest cannot be asked "what
// would you emit for a one-rung fork?", so nothing could check that the arity follows the ladder.
// Untestable and untested are the same state from the outside.
const TREE = process.env.RUNGS_CWD || ROOT;
const manifest = JSON.parse(
  readFileSync(process.env.RUNGS_MANIFEST || join(TREE, "rungs.json"), "utf8")
);

const byId = new Map(manifest.rungs.map((r) => [r.id, r]));
const retainedOf = (id) => {
  const keep = new Set();
  (function visit(x) {
    if (keep.has(x)) return;
    keep.add(x);
    byId.get(x).requires.forEach(visit);
  })(id);
  return manifest.rungs.filter((r) => keep.has(r.id)).map((r) => r.id);
};

const jobs = [];
for (const rung of manifest.rungs) {
  for (const lang of rung.languages) {
    jobs.push({
      rung: rung.id,
      lang,
      name: `${rung.ordinal}-${rung.id} (${lang})`,
      state: rung.state,
      retained: retainedOf(rung.id).join(","),
      // For py jobs: the runtimes whose /health must list exactly the retained rungs.
      runtimes: Object.keys(rung.runtimes)
        .filter((rt) => rt !== "node")
        .join(","),
    });
  }
}

// Non-vacuity: a matrix that emits nothing is a green board over zero verification, which is the
// failure mode this whole issue exists to remove. Assert the arity the manifest implies.
const expected = manifest.rungs.reduce((n, r) => n + r.languages.length, 0);
if (jobs.length !== expected || jobs.length === 0) {
  console.error(`FAIL: matrix emitted ${jobs.length} jobs, manifest implies ${expected}.`);
  process.exit(1);
}

// EVERY DECLARED RUNG MUST GET AT LEAST ONE JOB.
//
// The arity check above compares the total against the manifest's own arithmetic, so a rung with
// `languages: []` contributes nothing to BOTH sides and the totals still agree. That rung is then
// declared in the ladder and never ejected, never built, never verified — a green matrix that
// silently skips a rung, which is the shape of every defect this milestone removed.
//
// Found by matrix.selftest.mjs, which this script shipped without.
const uncovered = manifest.rungs.filter((r) => !jobs.some((j) => j.rung === r.id));
if (uncovered.length > 0) {
  console.error(
    `FAIL: ${uncovered.length} declared rung(s) get no job and would never be verified: ` +
      uncovered.map((r) => `${r.id} (languages: [${r.languages}])`).join(", ")
  );
  process.exit(1);
}

if (process.argv.includes("--github")) {
  process.stdout.write(`matrix=${JSON.stringify({ include: jobs })}\n`);
} else {
  console.log(`${jobs.length} severability jobs:`);
  for (const j of jobs) {
    console.log(`  ${j.name.padEnd(34)} retain=[${j.retained}]${j.runtimes ? ` runtimes=[${j.runtimes}]` : ""}`);
  }
}
