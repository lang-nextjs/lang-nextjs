#!/usr/bin/env node
/**
 * CHECK: no workflow may filter `pull_request` on the BASE branch.
 *
 * `on.pull_request.branches` filters on the base. A pull request based on a
 * branch outside that list matches no trigger and runs NOTHING — and the PR
 * page then shows no checks section at all, which reads as "fine" to anyone
 * scrolling past. It is neither a red to investigate nor a green over nothing;
 * it is an ABSENCE that renders like an absence of problems.
 *
 * That is how #130 reached main with zero CI while being gated on a named
 * check that never ran. Every stacked PR had the same hole, and this team
 * stacks routinely.
 *
 * The filter cannot be an allowlist of base branches: it would need editing in
 * six files every time someone opens a stack, and it is stale the moment they
 * do. So the rule is that it must not exist. `push.branches` is untouched —
 * that answers "which branches deserve a build", a different question.
 *
 * SECOND PROPERTY, SAME SHAPE ONE FIELD OVER: no workflow may filter
 * `pull_request` on `paths` either (#380).
 *
 * cross-version.yml listed packages/**, apps/**, pnpm-lock.yaml and itself.
 * Those four miss the root files that configure the build they gate —
 * turbo.json, root package.json's overrides, pnpm-workspace.yaml. Of the last
 * 25 merged PRs, eight matched none of the globs while touching build inputs;
 * four edited root package.json and ran ZERO cross-version contexts.
 *
 * The remedy is the same and for the same reason: an allowlist of paths that
 * must be re-derived whenever the build gains an input is stale exactly when it
 * matters, and being wrong is SILENT. Widening it fixes today. Deriving it from
 * the build inputs moves the under-enumeration one level up and gives it a
 * checker's authority. Not having one makes the failure mode "a job ran when it
 * need not", which is visible and cheap.
 *
 * It is also what lets these checks be REQUIRED: a required check that can be
 * skipped blocks its PR forever, so a path-filtered job can never be in branch
 * protection. Without the filter it always reports, so it can be.
 *
 * FAILS CLOSED. A workflow it cannot parse is an error, not a skip: a parser
 * gap silently treated as "no filter found" would be this very defect wearing
 * the checker's uniform.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(process.env.PR_TRIGGERS_DIR || ROOT, ".github", "workflows");

let files;
try {
  files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
} catch (e) {
  console.error(`FAIL: cannot read ${DIR} — ${e.message}`);
  process.exit(1);
}

// VACUITY GUARD. "0 violations out of 0 workflows" is the shape being checked
// for, not a pass. A relocated directory must fail, not report clean.
if (files.length === 0) {
  console.error(`FAIL: no workflow files found in ${DIR}. Nothing was checked.`);
  process.exit(1);
}

const offenders = [];
const pathOffenders = [];
let withPr = 0;

for (const f of files) {
  const lines = readFileSync(join(DIR, f), "utf8").split("\n");
  const top = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (top === -1) {
    // `on: push` inline form, or no trigger block. Neither can carry a
    // pull_request base filter, but say so rather than passing silently.
    if (lines.some((l) => /^on:/.test(l))) continue;
    console.error(`FAIL: ${f} has no recognisable \`on:\` block — cannot verify.`);
    process.exit(1);
  }
  const prIdx = lines.findIndex((l, i) => i > top && /^ {2}pull_request:\s*$/.test(l));
  if (prIdx === -1) continue;
  withPr++;
  for (let i = prIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;     // blank or comment
    if (!/^ {4,}/.test(l)) break;            // dedented out of pull_request
    if (/^ {4}branches:/.test(l)) {
      offenders.push(`${f}:${i + 1}  ${l.trim()}`);
    }
    if (/^ {4}paths(-ignore)?:/.test(l)) {
      pathOffenders.push(`${f}:${i + 1}  ${l.trim()}`);
    }
  }
}

// Second vacuity guard: workflows exist but none declares pull_request. Either
// CI does not run on PRs at all, or the parser stopped matching the file shape.
if (withPr === 0) {
  console.error(
    `FAIL: ${files.length} workflow(s) found, NONE declaring \`pull_request:\`.\n` +
      `      Either no workflow runs on pull requests, or this check no longer\n` +
      `      recognises the file shape. Both need a human.`
  );
  process.exit(1);
}

if (pathOffenders.length > 0) {
  console.error(
    "FAIL: workflow(s) filter `pull_request` on paths:\n" +
      pathOffenders.map((o) => `       ${o}`).join("\n") +
      "\n\n       A PR whose diff matches none of those globs runs NO checks from\n" +
      "       this workflow, and the absence renders like an absence of problems.\n" +
      "       The list also cannot be kept correct: it has to be re-derived every\n" +
      "       time the build gains an input, and it is wrong silently. Delete it\n" +
      "       rather than adding your path — a job that runs when it need not is\n" +
      "       the cheap mistake, and only an unfiltered job can be REQUIRED."
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(
    "FAIL: workflow(s) filter `pull_request` on the base branch:\n" +
      offenders.map((o) => `       ${o}`).join("\n") +
      "\n\n       A PR based on a branch outside that list runs NO checks at all,\n" +
      "       and shows no checks section — which reads as fine. Delete the\n" +
      "       filter rather than adding your base branch to it."
  );
  process.exit(1);
}

console.log(
  `PASS: ${withPr} of ${files.length} workflow(s) run on pull_request; none filtered on\n` +
    `      base branch, none filtered on paths.`
);
