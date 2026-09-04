#!/usr/bin/env node
/**
 * A RUNG-OWNED SOURCE FILE'S SIBLING TEST MUST BE OWNED BY THE SAME RUNG (#716).
 *
 * WHAT THIS EXISTS TO CATCH, concretely. `rungs.json` names owned files by
 * EXPLICIT ENUMERATION. A new test file therefore belongs to no rung until
 * somebody remembers to add the row — and #709 forgot. `AgentModeBanner.tsx`
 * was owned by open-swe; the `AgentModeBanner.test.tsx` written beside it was
 * not. On `eject 1-langchain`, `2-langgraph` and `3-deepagents`, which prune
 * open-swe, the component was deleted and the test SURVIVED, importing a module
 * that no longer existed and dying at collection in the ejected fork.
 *
 * WHY IT WAS EXPENSIVE TO DIAGNOSE, which is the real argument for this file.
 * `eject 4` and `eject 5` retain open-swe and stayed green, so the defect was
 * invisible to every local test run and to two thirds of the eject matrix. It
 * surfaced as seven red jobs whose failure was an ejected fork failing at test
 * COLLECTION — several inferential steps from "add one line to rungs.json".
 * This says the line.
 *
 * THE RULE. For every rung-owned, non-test source file, if a sibling test file
 * is tracked by git, that test must be owned by the SAME rung. Same rung, not
 * merely "some rung": a test owned by a rung that outlives its subject is the
 * identical defect one step along.
 *
 * A test beside SHARED source is not this check's business — shared files
 * survive every eject, so their tests may too.
 *
 * WHY IT CONSUMES classify()'s `owner` MAP rather than re-globbing. classify.mjs
 * says it directly: "A second implementation is a second answer, and the two
 * drift silently." Ownership here means exactly what it means to eject.
 *
 * ZERO PAIRS IS A REFUSAL, NOT A PASS. If no rung-owned source has a tracked
 * sibling test, this check cannot have examined anything, and reporting success
 * would be the vacuous green that let #716 exist in the first place. Exit 2 —
 * the same status this repo's other checkers use for "the question could not be
 * asked" — and say so.
 *
 * Exit 0 clean, 1 on a violation, 2 when the question could not be asked.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Extensions that can carry a test, longest-first so `.tsx` wins over `.ts`. */
const SOURCE_EXT = /\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;
const IS_TEST = /\.(test|selftest|spec)\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;
const TEST_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.mts",
  ".test.js",
  ".test.jsx",
  ".test.mjs",
];

/** Candidate sibling test paths for a source file. */
export function siblingTestsOf(file) {
  const stem = file.replace(SOURCE_EXT, "");
  return TEST_SUFFIXES.map((s) => stem + s);
}

/**
 * The pure core: given who owns what and which files git tracks, find every
 * sibling test that would outlive its subject.
 *
 * Kept free of git and of the filesystem so the self-test can drive it with
 * constructed inputs — including the shapes this repo does not currently
 * contain, which are exactly the ones a fixture built from the real tree could
 * never exercise.
 */
export function siblingViolations({ owner, tracked }) {
  const violations = [];
  let pairs = 0;

  for (const [file, rung] of owner) {
    if (!SOURCE_EXT.test(file) || IS_TEST.test(file)) continue;
    for (const sib of siblingTestsOf(file)) {
      if (!tracked.has(sib)) continue;
      pairs++;
      const sibOwner = owner.get(sib);
      if (sibOwner === rung) continue;
      violations.push({
        source: file,
        rung,
        test: sib,
        testOwner: sibOwner ?? null,
      });
    }
  }
  return { pairs, violations };
}

/** The remedy, spelled out — this is the whole point of the check. */
export function describeViolation(v) {
  const where =
    v.testOwner === null
      ? "is owned by no rung (it is shared or unclassified)"
      : `is owned by rung '${v.testOwner}'`;
  return [
    `  ${v.test}`,
    `      ${where}, but its subject`,
    `      ${v.source}`,
    `      is owned by rung '${v.rung}'.`,
    ``,
    `      On an eject that prunes '${v.rung}', the subject is deleted and this`,
    `      test survives importing it — the fork dies at test collection.`,
    ``,
    `      FIX: add this line to the '${v.rung}' rung's owns.ts list in rungs.json,`,
    `      then re-run \`pnpm rungs:freeze\` so ownedFileCount is recomputed:`,
    ``,
    `          "${v.test}",`,
  ].join("\n");
}

/**
 * The three-way decision, separated from the I/O that feeds it.
 *
 * REFUSAL IS A DISTINCT OUTCOME from both pass and fail. `pairs === 0` means
 * this check examined nothing, and the one thing it must not do then is report
 * success — that vacuous green is the shape of defect #716 is about. Exit 2 is
 * what this repo's other checkers use for "the question could not be asked".
 *
 * Pure, because the real tree only ever produces ONE of these three, and a
 * self-test that can reach only the outcome the tree already has is not a test
 * of the decision.
 */
export function verdict({ pairs, violations, ownerSize }) {
  if (pairs === 0) {
    return {
      code: 2,
      level: "REFUSED",
      message:
        `REFUSED: no rung-owned source file has a tracked sibling test, so this\n` +
        `         check examined nothing. That is not a clean tree — it is a\n` +
        `         check that could not run. Owner map had ${ownerSize} entries.`,
    };
  }
  if (violations.length > 0) {
    return {
      code: 1,
      level: "FAIL",
      message:
        `FAIL: ${violations.length} sibling test(s) would outlive the subject they test.\n\n` +
        violations.map(describeViolation).join("\n\n"),
    };
  }
  return {
    code: 0,
    level: "PASS",
    // NAMES ITS SUBJECT. "PASS" alone cannot be told apart from a check whose
    // domain quietly shrank to nothing, which is the failure this file is about.
    message:
      `PASS: every sibling test is owned by the same rung as its subject — ` +
      `${pairs} source/test pair(s) checked across ${ownerSize} rung-owned file(s).`,
  };
}

// ---------------------------------------------------------------------------------------- //

async function main() {
  const cwd = process.env.RUNGS_CWD || ROOT;

  let owner;
  try {
    // Loaded here, inside the guard, so a classifier that cannot load REFUSES
    // rather than surfacing as an unhandled rejection that a CI log reader
    // could mistake for any other kind of crash.
    const { classify } = await import(join(ROOT, "scripts", "classify.mjs"));
    ({ owner } = classify(cwd));
  } catch (err) {
    console.error(
      `REFUSED: could not classify ownership, so the question could not be asked.\n` +
        `         ${err && err.message ? err.message : String(err)}`
    );
    process.exit(2);
  }

  let tracked;
  try {
    tracked = new Set(
      execFileSync("git", ["-C", cwd, "ls-files"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
    );
  } catch (err) {
    console.error(
      `REFUSED: could not list tracked files in ${cwd}.\n` +
        `         ${err && err.message ? err.message : String(err)}`
    );
    process.exit(2);
  }

  const { pairs, violations } = siblingViolations({ owner, tracked });
  const v = verdict({ pairs, violations, ownerSize: owner.size });
  (v.code === 0 ? console.log : console.error)(v.message);
  process.exit(v.code);
}

/*
 * invokedAsProgram, NOT a hand-rolled `resolve(argv[1]) === resolve(self)`.
 *
 * That comparison does not follow symlinks, and macOS hands mkdtemp a
 * /var/folders/... path whose real location is /private/var/folders/... — so
 * the two sides differ, main() never runs, and the checker exits 0 having
 * examined nothing. This file's own self-test caught exactly that while it was
 * being written: the planted-violation case went green because the program had
 * not run at all. scripts/lib/is-main.mjs exists for this and refuses rather
 * than guessing.
 */
if (invokedAsProgram(import.meta.url)) await main();
