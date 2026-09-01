#!/usr/bin/env node
/**
 * assert-board-declarations-agree.mjs — the `v2.0-reference` LABEL and the `v2.0` MILESTONE
 * are two declarations of one fact, and this asserts they agree (#410).
 *
 * THE DEFECT, MEASURED, TWICE. The milestone-filtered board once read "v2.0: 2 open, one of
 * which is the epic" — which reads as shippable — while the label-filtered view showed eight.
 * Six issues carried the label and no milestone. Someone deciding whether v2.0 could ship,
 * using the view the milestone is FOR, would have got the wrong answer. Corrected by hand,
 * and fully drifted back within one session. A one-time relabel is not a mechanism.
 *
 * THE RULE IS DISAGREEMENT, NOT UNIVERSAL LABELLING.
 *
 *   label + milestone   agree      pass
 *   neither             agree      pass   <- the COMMON case, and it must not fail
 *   label, no milestone DISAGREE   fail
 *   milestone, no label DISAGREE   fail
 *
 * Both directions. Label-without-milestone is what happened twice; milestone-without-label is
 * equally a disagreement and equally silent, and a rule that can only fail in the direction we
 * happen to have been bitten by is a rename, not a control.
 *
 * WHY "NEITHER" PASSES, STATED PLAINLY BECAUSE IT LOOKS LIKE A HOLE. An issue carrying neither
 * declaration is not making a claim about v2.0 at all, and deciding whether it OUGHT to is a
 * judgement no checker can make. That is a real second defect — the third drift was seven
 * issues carrying NEITHER, which this check passes and should pass — and it is recorded on
 * #410 rather than papered over here. This file is about two declarations disagreeing. It is
 * not, and cannot be, about an issue nobody declared.
 *
 * THE FAILURE MODE THIS CHECK HAS AND NO OTHER CHECKER IN THIS REPO HAS.
 *
 * Every other checker here reads a TREE. `payload-triangulation`, `classify.mjs`, `census`,
 * `check-doc-claims` — the subject is on disk, and a missing subject is an empty walk. This
 * one reads the GITHUB API, which makes "the query failed" and "nothing is wrong" the same
 * output:
 *
 *     403 / rate limit / rotated token  ->  0 issues  ->  0 disagreements  ->  PASS
 *
 * So it refuses (exit 2) rather than passing whenever it cannot establish that it actually
 * examined the board. THREE guards, because any one of them alone is defeatable:
 *
 *   1. EXIT STATUS, not output shape. `gh` exiting non-zero is a refusal even if it printed
 *      something parseable, and an empty stdout with status 0 is still a refusal.
 *   2. A POSITIVE CONTROL MARKER. The fetched set must contain the epic (#16). A well-formed
 *      empty or filtered response passes guard 1 and dies here — this is what distinguishes
 *      "the board is clean" from "I queried something that was not the board".
 *   3. NAME THE SUBJECT. Report how many issues were examined and which disagreed. A green
 *      with no number tells a later reader nothing about whether anything was looked at.
 *
 * --fixture <path> reads a recorded board instead of calling the API. That is not a testing
 * convenience: you cannot make GitHub drift on demand, so WITHOUT IT NO SELF-TEST CAN EXIST
 * and this check could only ever be exercised against a clean board — a check that has never
 * been red, which is indistinguishable from one that cannot fail. The fixtures are two real
 * historical boards plus one synthetic, and the selftest is what proves this file can fail.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { invokedAsProgram } from "./lib/is-main.mjs";
export const LABEL = "v2.0-reference";
export const MILESTONE = "v2.0 — Reference Implementation";

/** The epic. Present on every real board this check will ever see, and it outlives the check. */
export const CONTROL_MARKER = 16;

class Refusal extends Error {}

/** Fetch the open board. Throws Refusal — never returns a partial or empty set as data. */
export function fetchBoard(runner = spawnSync) {
  const r = runner(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,labels,milestone",
    ],
    { encoding: "utf8" }
  );
  // GUARD 1 — exit status, captured directly. Not `if (!r.stdout)`: a failed query can print
  // a well-formed empty array, and a successful one can print nothing if the board is empty.
  if (r.error) throw new Refusal(`could not run \`gh\`: ${r.error.message}`);
  if (r.status !== 0)
    throw new Refusal(
      `\`gh issue list\` exited ${r.status}. stderr: ${
        (r.stderr || "").trim() || "(empty)"
      }`
    );
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`\`gh issue list\` exited 0 but its output is not JSON`);
  }
  if (!Array.isArray(parsed))
    throw new Refusal(`expected a JSON array of issues`);
  return parsed;
}

export function readFixture(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Refusal(`fixture ${path} is not a JSON array`);
  return parsed;
}

const hasLabel = (i) => (i.labels ?? []).some((l) => l.name === LABEL);
const hasMilestone = (i) => (i.milestone?.title ?? null) === MILESTONE;

/**
 * The whole rule. Separated from I/O so the selftest drives the SAME function the checker
 * runs — a suite that reimplements the predicate proves only that two copies agree.
 */
export function disagreements(issues) {
  return issues
    .filter((i) => hasLabel(i) !== hasMilestone(i))
    .map((i) => ({
      number: i.number,
      direction: hasLabel(i) ? "label, no milestone" : "milestone, no label",
    }));
}

export function analyse(issues) {
  // GUARD 2 — the positive control. A response that is well-formed, parseable, and NOT the
  // board passes every other check here and reports zero disagreements.
  if (!issues.some((i) => i.number === CONTROL_MARKER))
    throw new Refusal(
      `the fetched set does not contain #${CONTROL_MARKER} (the v2.0 epic), so it is not the ` +
        `open board — refusing rather than reporting 0 disagreements over the wrong subject`
    );
  return { examined: issues.length, offenders: disagreements(issues) };
}

function main() {
  const i = process.argv.indexOf("--fixture");
  const fixture = i !== -1 ? process.argv[i + 1] : null;
  let result;
  try {
    result = analyse(fixture ? readFixture(fixture) : fetchBoard());
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(
        `REFUSING TO REPORT: ${err.message}\n\n` +
          `THIS IS NOT A PASS — it is the absence of a question. A board check that cannot\n` +
          `tell "every issue agrees" from "I could not ask" is green in both cases, and the\n` +
          `second is the one that happens the day a token rotates. Exiting 2.`
      );
      process.exit(2);
    }
    throw err;
  }

  const { examined, offenders } = result;
  // GUARD 3 — name the subject, on the pass path too. A bare PASS cannot be audited.
  const subject = `${examined} open issue(s)${
    fixture ? ` from ${fixture}` : ""
  }`;
  if (offenders.length === 0) {
    console.log(
      `PASS: examined ${subject}, 0 label/milestone disagreement(s). ` +
        `"${LABEL}" and the "${MILESTONE}" milestone agree on every issue that declares either.`
    );
    return;
  }
  console.error(
    `FAIL: examined ${subject}, ${offenders.length} label/milestone disagreement(s).\n\n` +
      `Each of these is declared v2.0 in one place and not the other, so the two views of the\n` +
      `board disagree about what remains — and the milestone view is the one people ship from.\n`
  );
  for (const o of offenders) console.error(`  #${o.number}  ${o.direction}`);
  console.error(
    `\nFix by making both declarations true or both false. Carrying NEITHER is legal and is\n` +
      `not reported here; whether such an issue OUGHT to be v2.0 is a judgement (#410).`
  );
  process.exit(1);
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
