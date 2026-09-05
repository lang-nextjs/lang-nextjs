#!/usr/bin/env node
/**
 * Property: CI'S PLAYWRIGHT RUNS EMIT ANNOTATIONS THAT NAME THE FAILING TEST.
 *
 * WHAT THIS EXISTS FOR (#362). A failing e2e job's check run said this and only
 * this:
 *
 *     [FAILURE] .github   "Process completed with exit code 1."
 *
 * Conclusion FAILURE, and every field that could name a subject empty or
 * absent — confirmed by three independent GraphQL probes: `annotations` held
 * one generic node, `output` is not a field on CheckRun in this schema, and
 * `title`/`summary`/`text` were all null. So the check run reported THAT
 * something failed and nothing about WHAT.
 *
 * The cost was not theoretical. Three investigations in one day needed the same
 * rate-limited log download to answer "which test failed", and two stalled on
 * it — #351's eject red, a firefox flake on #358, and #114's single remaining
 * Mocked failure, which is still unidentified because REST never recovered
 * inside the hour it was worth spending. A repo this invested in checks that
 * name their subject had a CI surface that could not name its own.
 *
 * Playwright's `github` reporter emits `::error file=…,line=…::` lines, which
 * GitHub turns into annotations attached to the check run. Nothing else in this
 * pipeline writes those fields, which is why this is the fix and also why it
 * needs proving: see the selftest.
 *
 * ── WHY A CHECKER AND NOT JUST THE CONFIG LINE ──────────────────────────────
 *
 * Because the fixed and unfixed states are INDISTINGUISHABLE from outside. Both
 * produce a check run whose conclusion is FAILURE and which says nothing else.
 * A reporter that is dropped in a refactor, or gated on an env var CI does not
 * set, reverts the repo to the state above and NOTHING GOES RED — the next
 * person just finds the annotations missing, months later, while chasing
 * something else. So the wiring is asserted rather than assumed.
 *
 * Usage: node scripts/check-github-reporter.mjs [--cwd DIR]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { reportSubject } from "./lib/subject.mjs";
const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD = ci >= 0 ? resolve(argv[ci + 1]) : process.cwd();

/**
 * The root config is the only one this repo RUNS. `rungs/5-…/apps/open-swe/
 * playwright.config.ts` is vendored upstream code that no workflow invokes —
 * see the PR for why it is deliberately left alone.
 */
const CONFIG = join(CWD, "playwright.config.ts");

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

if (!existsSync(CONFIG)) {
  // Deliberately fatal. A checker that cannot find its subject must not report
  // a clean bill of health — that is the defect it exists to prevent, wearing
  // the checker's own uniform.
  fail([
    `FAIL: ${CONFIG} does not exist, so the reporter wiring cannot be checked.`,
    "      This is a hard failure, NOT a skip.",
  ]);
}

const src = readFileSync(CONFIG, "utf8");

/**
 * The whole `reporter:` DECLARATION, not the line it starts on.
 *
 * The first version of this checker matched a single line and reported the
 * reporter missing the moment the declaration was formatted across several —
 * which is how it is written now. A checker that fails on formatting is a
 * checker people delete.
 *
 * Bracket-balanced from the first `[` after `reporter:`, and it returns null
 * rather than guessing if the brackets never close, because a half-read
 * declaration would be scored as if it were the whole thing.
 */
function reporterDeclaration(text) {
  // NOT ANCHORED TO LINE START, and `:[` is required rather than just `:`.
  // The line-anchored version reported the reporter missing for a config that
  // wrote it mid-line (`export default { reporter: [...] }`) — the same
  // formatting brittleness this function was extracted to fix, one layer down.
  // Requiring the bracket keeps it from matching the word in a comment.
  const m = /reporter\s*:\s*\[/.exec(text);
  if (!m) return null;
  const at = m.index;
  const open = text.indexOf("[", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return null;
}

const line = reporterDeclaration(src);

if (!line) {
  fail([
    "FAIL: playwright.config.ts declares no readable `reporter:` list.",
    "      Playwright's default is `list`, which emits no annotations, so a CI",
    "      failure would name nothing. See #362.",
  ]);
}

// Matched on the config's own text rather than by importing it: importing would
// execute the config, which resolves projects and devices and needs the browsers
// installed. A checker that only runs where the suite runs is a checker that
// does not run.
const hasGithub = /\[\s*["']github["']\s*\]|["']github["']/.test(line);
const gatedOnCi = /process\.env\.CI/.test(line);

const problems = [];
if (!hasGithub) {
  problems.push(
    "FAIL: the `github` reporter is not in playwright.config.ts's reporter list.",
    "      Without it a failing CI job produces a check run that says only",
    '      "Process completed with exit code 1" — no file, no line, no test',
    "      name — and the only way to learn what failed is downloading the log",
    "      over a rate-limited API. See #362."
  );
}
if (hasGithub && !gatedOnCi) {
  problems.push(
    "FAIL: the `github` reporter is present but not gated on process.env.CI.",
    "      It would print ::error:: lines into local runs, where nothing renders",
    "      them and they are noise. Gate it so local output is unchanged."
  );
}
if (problems.length) {
  fail([
    ...problems,
    "",
    "      reporter declaration:",
    ...line
      .trim()
      .split("\n")
      .map((l) => `        ${l}`),
  ]);
}

reportSubject(line ? 1 : 0, "reporter declaration read");
console.log(
  "PASS: playwright.config.ts wires the `github` reporter under CI, so a failing " +
    "job's check run names the test, file and line."
);
