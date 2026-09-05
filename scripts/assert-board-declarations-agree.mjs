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
 *   2. A POSITIVE CONTROL MARKER, AND ITS SUBJECT IS EXISTENCE, NOT OPENNESS (#720). The
 *      marker was originally "the fetched set must contain the epic (#16)", carrying the
 *      prediction "it outlives the check". It did not: #16 closed on 2026-09-02 and this
 *      checker refused on every run afterwards, correctly by its own rule and uselessly in
 *      fact. An issue's OPENNESS expires; its EXISTENCE does not. So the marker is now
 *      established by a targeted `gh issue view 16`, which cannot be truncated and cannot
 *      expire, and the board must contain #16 IFF that query reports it OPEN.
 *
 *      While #16 is open that is exactly the old guarantee — a well-formed empty or filtered
 *      response passes guard 1 and dies here. While it is closed the guarantee is weaker:
 *      identity and reachability are still established (a token pointed at another repo, or
 *      one that cannot read issues, fails the marker query), and a board wrongly containing
 *      #16 is still caught, but a filtered subset that merely omits some open issues is not.
 *      The PASS line says which of the two it established, because a reader cannot otherwise
 *      tell, and a guarantee nobody can see the strength of is one that quietly decays.
 *
 *      THAT MITIGATION DOES NOT REACH THE CHANNEL THIS CHECK ACTUALLY RUNS IN, and saying so
 *      here is the point (#741, found by DEV2-lang reviewing this). board-declarations is a
 *      checks.json entry, so run-checks.mjs invokes it — and on SUCCESS run-checks prints only
 *      `ok  board-declarations (checker)` and discards the checker's stdout
 *      (scripts/run-checks.mjs:438; stdout is printed only on failure, at :435). So the PASS
 *      line above is visible to somebody running this file by hand and to nobody reading CI.
 *      The strength of the guarantee is therefore still invisible where it matters, and the
 *      sentence before this one would otherwise read as though the problem were solved.
 *      Fixing it belongs to run-checks rather than here — a checker cannot make its caller
 *      print it.
 *   3. NAME THE SUBJECT. Report how many issues were examined and which disagreed. A green
 *      with no number tells a later reader nothing about whether anything was looked at.
 *
 * --marker-state OPEN|CLOSED goes with --fixture and only with it. The fixtures are recorded
 * boards, and a recording carries no live marker state; without this flag the marker-closed
 * branch above would be a path no test could reach, which is the shape that let #720 land.
 * Defaults to OPEN, because every fixture here was recorded while #16 was open.
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

/**
 * The epic. It EXISTS on every real board this check will ever see — issues are not deleted —
 * and that is the property relied on here.
 *
 * It is not always OPEN, and the earlier version of this line predicted that it would be:
 * "Present on every real board this check will ever see, and it outlives the check." #16
 * closed on 2026-09-02 and the prediction was falsified two days later, in the only channel
 * where this checker actually runs (#720).
 */
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

/**
 * Is the control marker open? Established by asking for it BY NUMBER, which no board-wide
 * filter or page limit can affect.
 *
 * Every failure here is a Refusal rather than a default, and that is the whole point: an
 * unanswerable control must never resolve to a value that lets the check proceed. A `false`
 * returned on error would read downstream as "the marker is closed" and quietly relax guard 2
 * into its weaker form — the inverse of the bug this replaces, and harder to see.
 */
export function fetchMarkerState(runner = spawnSync) {
  const r = runner(
    "gh",
    ["issue", "view", String(CONTROL_MARKER), "--json", "number,state"],
    { encoding: "utf8" }
  );
  if (r.error)
    throw new Refusal(
      `could not run \`gh\` for the control marker: ${r.error.message}`
    );
  if (r.status !== 0)
    throw new Refusal(
      `\`gh issue view ${CONTROL_MARKER}\` exited ${r.status}. stderr: ${
        (r.stderr || "").trim() || "(empty)"
      }`
    );
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Refusal(
      `\`gh issue view ${CONTROL_MARKER}\` exited 0 but its output is not JSON`
    );
  }
  // Asking for #16 and being handed something else means the repo context is not the one
  // this check is about — the exact condition the marker exists to detect.
  if (parsed?.number !== CONTROL_MARKER)
    throw new Refusal(
      `asked for #${CONTROL_MARKER} and got #${
        parsed?.number ?? "<none>"
      } — \`gh\` is not ` + `pointed at the repository this check reads`
    );
  const state = String(parsed?.state ?? "").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED")
    throw new Refusal(
      `\`gh\` reports #${CONTROL_MARKER} in state ${JSON.stringify(
        parsed?.state
      )}, which is ` + `neither OPEN nor CLOSED`
    );
  return state === "OPEN";
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

export function analyse(issues, { markerIsOpen }) {
  // GUARD 2 — the positive control, as a CONSISTENCY test between two responses rather than a
  // bare presence test. A response that is well-formed, parseable, and NOT the board passes
  // every other check here and reports zero disagreements.
  if (typeof markerIsOpen !== "boolean")
    throw new Refusal(
      `the control marker's state was not established, so there is nothing to check the ` +
        `fetched set against`
    );
  const present = issues.some((i) => i.number === CONTROL_MARKER);
  if (markerIsOpen && !present)
    throw new Refusal(
      `the fetched set does not contain #${CONTROL_MARKER} (the v2.0 epic), which GitHub ` +
        `reports as OPEN, so it is not the open board — refusing rather than reporting 0 ` +
        `disagreements over the wrong subject`
    );
  if (!markerIsOpen && present)
    throw new Refusal(
      `the fetched set contains #${CONTROL_MARKER}, which GitHub reports as CLOSED. An ` +
        `open-board query returning a closed issue is not the board this check means to read`
    );
  return {
    examined: issues.length,
    offenders: disagreements(issues),
    markerIsOpen,
  };
}

/**
 * `--marker-state` is accepted ONLY beside `--fixture`, and an unrecognised value is fatal
 * rather than a fallback to the default. A flag that silently ignores what it was given is a
 * flag whose test can pass while exercising the other branch.
 */
function parseMarkerState(argv) {
  const i = argv.indexOf("--marker-state");
  if (i === -1) return true; // every fixture here was recorded while #16 was open
  if (!argv.includes("--fixture")) {
    console.error(
      `--marker-state is only meaningful with --fixture. Against the live API the marker's ` +
        `state is MEASURED, and accepting an override there would let a caller assert the ` +
        `control this check exists to derive.`
    );
    process.exit(2);
  }
  const v = String(argv[i + 1] ?? "").toUpperCase();
  if (v !== "OPEN" && v !== "CLOSED") {
    console.error(
      `--marker-state takes OPEN or CLOSED, got ${JSON.stringify(argv[i + 1])}`
    );
    process.exit(2);
  }
  return v === "OPEN";
}

function main() {
  const i = process.argv.indexOf("--fixture");
  const fixture = i !== -1 ? process.argv[i + 1] : null;
  // VALIDATED BEFORE THE BRANCH, not inside the fixture arm. Parsing it only where it is used
  // means the live path IGNORES it silently, which is the failure this flag's own rule names.
  parseMarkerState(process.argv);
  let result;
  try {
    const issues = fixture ? readFixture(fixture) : fetchBoard();
    // ORDER MATTERS. The board is fetched first so that guard 1 reports a failed board query
    // as itself, rather than as a failed marker query — two different causes with two
    // different fixes, and the marker query is the more likely of the two to succeed while
    // the board query is rate-limited.
    const markerIsOpen = fixture
      ? parseMarkerState(process.argv)
      : fetchMarkerState();
    result = analyse(issues, { markerIsOpen });
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

  const { examined, offenders, markerIsOpen } = result;
  // GUARD 3 — name the subject, on the pass path too. A bare PASS cannot be audited.
  const subject = `${examined} open issue(s)${
    fixture ? ` from ${fixture}` : ""
  }`;
  // AND NAME WHAT THE CONTROL ESTABLISHED, not just that one ran. The two branches of guard 2
  // give different guarantees (#720), and a PASS that does not say which one it earned is a
  // guarantee that can weaken without any reader noticing.
  const basis = markerIsOpen
    ? `control: #${CONTROL_MARKER} is OPEN and was found in the fetched set, so the response ` +
      `was the board and not a filtered or empty one`
    : `control: #${CONTROL_MARKER} is CLOSED, so its absence is expected — this run ` +
      `established that \`gh\` reads the right repository and that the board does not ` +
      `contain a closed issue, but NOT that the response was unfiltered`;
  if (offenders.length === 0) {
    console.log(
      `PASS: examined ${subject}, 0 label/milestone disagreement(s). ` +
        `"${LABEL}" and the "${MILESTONE}" milestone agree on every issue that declares ` +
        `either.\n  ${basis}.`
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
