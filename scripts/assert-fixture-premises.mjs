#!/usr/bin/env node
/**
 * Property: A FIXTURE THAT PLANTS INTO A DIRECTORY-GLOB-OWNED LOCATION ASSERTS THAT OWNERSHIP.
 *
 * A fixture builds a scenario, runs the subject at it, and reports a verdict. When the
 * scenario stops being constructible it does not go red: the setup runs, achieves nothing,
 * and the subject answers a question about a situation that is no longer there. The answer is
 * green. Three of these landed in one night, each leaving a passing suite (#375).
 *
 * WHY THIS EXACT SHAPE, AND NOT "FIXTURES SHOULD CHECK THEIR PREMISES".
 *
 * The broad version cannot be enforced without judgement, and a rule that fires on clean
 * fixtures gets deleted rather than fixed — #328 has a detector that went 63, then 4, then 0
 * findings and was dropped. Measured here first: 11 of 34 fixtures name a real path under a
 * shared or owned glob, and nearly all of them merely READ that path. Requiring premise
 * assertions from all 11 would be that detector again.
 *
 * The enforceable subset is the one where the premise is invisible BY CONSTRUCTION:
 *
 *   a plant     the path does not exist in the tree, so the fixture creates it
 *   into a      a rung claims it through a DIRECTORY glob (`e2e/rungs/open-swe/**`)
 *   directory   rather than by naming the file
 *   glob
 *
 * That combination is precisely what makes a plant work WITHOUT a manifest edit — and
 * therefore precisely what a reparent takes away without touching the fixture. It is the
 * mechanism behind the assert-census-fresh failure: its plant sat under `apps/open-swe/**`,
 * the reparent narrowed that glob to the run surface, the path became shared, both branches
 * froze identically, and the SILENT case reported the checker passing on a collision it could
 * no longer build.
 *
 * A path a rung owns BY NAME is not in scope: removing it from the manifest is an edit
 * someone makes deliberately to that line, and the fixture's own diff review sees it.
 *
 * WHAT A PASS HERE DOES AND DOES NOT MEAN. It means every plant of this shape has premise
 * verification. It does NOT mean the premise asserted is the right one — that stays a review
 * question, and no static check can answer it. Saying so here rather than letting the PASS
 * line imply more is the point of the distinction.
 *
 * Usage: node scripts/assert-fixture-premises.mjs [--cwd DIR]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { globToRegExp } from "./classify.mjs";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
const cwdFlag = process.argv.indexOf("--cwd");
const ROOT =
  cwdFlag !== -1 && process.argv[cwdFlag + 1]
    ? resolve(process.argv[cwdFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/** Calls that constitute premise verification. Adding one here widens what counts. */
const PREMISE_CALLS =
  /\b(requirePremise|requireSharedFrozen|requireRungOwned|requireSetupChanged)\s*\(/;

export function findPlants(root) {
  const manifest = JSON.parse(readFileSync(join(root, "rungs.json"), "utf8"));

  // DIRECTORY globs only — a rung claiming a path by name is out of scope, see the header.
  const dirGlobs = [];
  for (const rung of manifest.rungs ?? []) {
    for (const [lang, globs] of Object.entries(rung.owns ?? {})) {
      for (const g of globs) {
        if (g.endsWith("/**"))
          dirGlobs.push({ rung: rung.id, lang, glob: g, re: globToRegExp(g) });
      }
    }
  }

  const scriptsDir = join(root, "scripts");
  const files = existsSync(scriptsDir)
    ? readdirSync(scriptsDir).filter((f) => /\.selftest\./.test(f))
    : [];

  const results = [];
  for (const f of files) {
    const src = readFileSync(join(scriptsDir, f), "utf8");
    const verified = PREMISE_CALLS.test(src);
    for (const m of src.matchAll(
      /"((?:apps|packages|e2e|scripts)\/[A-Za-z0-9._/-]+)"/g
    )) {
      const rel = m[1];
      // A path that EXISTS is being read, not planted. Only a plant can silently stop being
      // owned without anyone touching the fixture.
      if (existsSync(join(root, rel))) continue;
      const hit = dirGlobs.find((d) => d.re.test(rel));
      // Deduped: a fixture naming the same plant in two cases is one plant with one premise,
      // and reporting it twice teaches the reader to skim the output.
      if (
        hit &&
        !results.some((r) => r.file === `scripts/${f}` && r.rel === rel)
      ) {
        results.push({ file: `scripts/${f}`, rel, ...hit, verified });
      }
    }
  }
  return { results, dirGlobCount: dirGlobs.length, fixtureCount: files.length };
}

function main() {
  const { results, dirGlobCount, fixtureCount } = findPlants(ROOT);

  /*
   * POSITIVE CONTROLS FIRST. "no unverified plants" and "I found no fixtures / no directory
   * globs" print the same green, and the second is the likelier failure once someone moves
   * scripts/ or rewrites the manifest. Both inputs must be non-empty before any verdict.
   */
  if (fixtureCount === 0) {
    console.error(
      `FAIL: no *.selftest.* files under ${ROOT}/scripts.\n` +
        `      Nothing was examined, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }
  if (dirGlobCount === 0) {
    console.error(
      `FAIL: no rung owns anything by directory glob in ${ROOT}/rungs.json.\n` +
        `      That is the ownership this checker is about, so it cannot compute the property.`
    );
    process.exit(2);
  }

  const unverified = results.filter((r) => !r.verified);
  if (unverified.length > 0) {
    for (const r of unverified) {
      console.error(
        `FAIL: ${r.file} plants ${r.rel}\n` +
          `      owned by rung "${r.rung}" ONLY through the directory glob ${r.glob}.\n` +
          `      Nothing in the fixture says so, so a reparent that narrows that glob makes the\n` +
          `      plant shared, the scenario unbuildable, and this fixture green about nothing.\n` +
          `      Assert it: requireRungOwned(dir, "${r.rel}", "<what the case needs it for>")\n` +
          `      from scripts/lib/fixture-premise.mjs.\n`
      );
    }
    process.exit(1);
  }

  reportSubject(fixtureCount, "fixture(s) scanned");
  console.log(
    `PASS: ${fixtureCount} fixture(s) scanned against ${dirGlobCount} directory-owned glob(s); ` +
      `${results.length} plant(s)\n` +
      `      land in one and all ${results.length} verify that ownership. (Presence of a premise ` +
      `check, not\n      correctness of it — which premise is right stays a review question.)`
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
