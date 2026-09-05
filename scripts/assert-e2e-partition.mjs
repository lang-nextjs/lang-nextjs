#!/usr/bin/env node
/**
 * Property: WHICH PROJECT RUNS WHICH SPEC IS DECLARED, AND WHAT RUNS MATCHES THE DECLARATION.
 *
 * A spec joining an EXTRA project runs against whatever baseURL that project's jobs set. On
 * #473 an unanchored pattern gave `chromium` an open-swe accessibility spec, and in the Django
 * and FastAPI jobs `chromium` points at the EXAMPLE APP — so an open-swe gate ran against the
 * wrong application. It failed only because that spec asserts which app answered; otherwise it
 * would have been green in two jobs while never looking at open-swe (#475).
 *
 * The mirror is just as quiet: a pattern tightened too far removes a spec from a project, and
 * a project running one fewer spec reports exactly the same green.
 *
 * ── NEITHER EXISTING CHECK SEES THIS, AND THAT WAS MEASURED, NOT ASSUMED ──────────────────
 *
 * `check-e2e-registration.mjs` covers both EMPTINESS directions — a spec no project runs, a
 * project that runs nothing. I expected it to cover the tightening case too and wrote that
 * down; it does not. Planting an over-tight pattern:
 *
 *     /(^|\/)shared\/nextjs\.spec\.ts$/  ->  /(^|\/)shared\/nextjs-NOPE\.spec\.ts$/
 *
 *     assert-testmatch-anchored     exit 0   (it is still anchored — correctly indifferent)
 *     check-e2e-registration        exit 0   (the spec still runs in other projects, so it is
 *                                             not an orphan; the project still matches twelve
 *                                             others, so it is not a ghost)
 *
 * The partition changed and nothing objected. Emptiness at both ends is a weaker property than
 * membership, and the gap between them is exactly where a wrong-subject test lives.
 *
 * ── SO THE MAPPING IS FROZEN, THE WAY THE CENSUS IS ───────────────────────────────────────
 *
 * The declared list is what runs, and what ran is what coverage reads. Adding a spec, or moving
 * one between projects, is then a step someone TAKES — `--freeze` — rather than something that
 * happens. The churn is the point: a silent membership change is the defect.
 *
 * Ground truth comes from `playwright test --list --reporter=json`, never from re-reading the
 * config. Re-implementing testMatch would have to reproduce regex form, string form, array
 * form, testDir resolution, testIgnore and shared consts, and every gap in that would be a
 * pattern silently scored as "no match".
 *
 * Usage:
 *   node scripts/assert-e2e-partition.mjs [--cwd DIR]
 *   node scripts/assert-e2e-partition.mjs --freeze
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const ROOT = resolve(
  argOf("--cwd") ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
const FROZEN = join(ROOT, "scripts", "e2e-partition.json");

/** `project\tspec` for every pair Playwright actually resolves. */
export function resolvePartition(root = ROOT) {
  let raw;
  try {
    raw = execFileSync(
      join(root, "node_modules", ".bin", "playwright"),
      ["test", "--list", "--reporter=json"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    return {
      problem: `playwright --list failed: ${String(e.message).split("\n")[0]}`,
    };
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return { problem: "playwright --list did not emit JSON" };
  }
  const pairs = new Set();
  (function walk(suites) {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? [])
          pairs.add(`${t.projectName}\t${s.file ?? spec.file}`);
      }
      walk(s.suites);
    }
  })(d.suites);
  return { pairs: [...pairs].sort() };
}

function main() {
  const r = resolvePartition(ROOT);
  if (r.problem) {
    console.error(
      `FAIL: ${r.problem}.\n      This checker is about which project runs which spec, so a ` +
        `listing it could not read means\n      it COULD NOT COMPUTE the property — not that ` +
        `the partition is intact.`
    );
    process.exit(2);
  }
  /*
   * VACUITY. "no differences" and "I resolved nothing" print the same green, and the second is
   * what a config error or a moved testDir produces.
   */
  if (r.pairs.length === 0) {
    console.error(
      `FAIL: resolved 0 project/spec pairs. A partition with nothing in it cannot differ from ` +
        `anything,\n      so every comparison below would pass vacuously.`
    );
    process.exit(2);
  }

  if (process.argv.includes("--freeze")) {
    writeFileSync(FROZEN, JSON.stringify(r.pairs, null, 2) + "\n");
    console.log(
      `froze ${r.pairs.length} project/spec pair(s) -> scripts/e2e-partition.json`
    );
    return;
  }

  if (!existsSync(FROZEN)) {
    console.error(
      `FAIL: no scripts/e2e-partition.json. Run --freeze to declare the partition.`
    );
    process.exit(2);
  }
  const want = new Set(JSON.parse(readFileSync(FROZEN, "utf8")));
  const got = new Set(r.pairs);
  const gained = [...got].filter((p) => !want.has(p)).sort();
  const lost = [...want].filter((p) => !got.has(p)).sort();

  const projects = new Set(r.pairs.map((p) => p.split("\t")[0]));
  const files = new Set(r.pairs.map((p) => p.split("\t")[1]));
  // NAME THE SUBJECT: a verdict that does not say what it resolved cannot be told from one
  // that resolved the wrong tree.
  console.log(
    `resolved ${r.pairs.length} project/spec pair(s): ${files.size} spec(s) across ${projects.size} project(s)`
  );

  for (const p of gained) {
    const [proj, file] = p.split("\t");
    console.error(
      `FAIL: ${file}\n        JOINED project "${proj}", which the frozen partition does not declare. It will run against that project's baseURL.`
    );
  }
  for (const p of lost) {
    const [proj, file] = p.split("\t");
    console.error(
      `FAIL: ${file}\n        LEFT project "${proj}", which the frozen partition declares. That project no longer runs it, and reports the same green.`
    );
  }
  if (gained.length || lost.length) {
    console.error(
      `\n${gained.length} joined, ${lost.length} left. If deliberate, re-declare with ` +
        `--freeze so the change is\nin the diff someone reviews rather than in behaviour ` +
        `nobody sees.`
    );
    process.exit(1);
  }
  reportSubject(r.pairs.length, "declared pair(s)");
  console.log(
    `\nPASS: what runs matches what is declared, pair for pair. Membership is asserted here;\n` +
      `      emptiness at either end is check-e2e-registration.mjs's, and neither implies the ` +
      `other.`
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
