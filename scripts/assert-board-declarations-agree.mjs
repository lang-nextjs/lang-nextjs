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
import { reportSubject } from "./lib/subject.mjs";
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

/**
 * The page size asked of `gh issue list`. Named because the truncation guard below
 * compares against it: a literal in two places is a pair that can silently disagree.
 */
export const BOARD_LIMIT = 500;

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
      String(BOARD_LIMIT),
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

  /*
   * GUARD 1b — A FETCH AT THE PAGE SIZE IS NOT A BOARD (#735).
   *
   * `gh issue list --limit N` returning exactly N is indistinguishable from a board with
   * more than N open issues. Every verdict below would then be about a SUBSET, reported as
   * though it were the board — which is the failure the #16 control marker existed to catch,
   * sitting latent in this function the whole time the marker was being argued about.
   *
   * WHY THIS ONE CANNOT EXPIRE, and the marker did. #16 was a proxy: "the epic is in the
   * fetched set" stood in for "the fetch was complete", and the proxy was retired the moment
   * someone closed the issue (#720). The relationship between a page size and a result count
   * is not a fact about any issue, so nothing anyone does on the board can retire it.
   *
   * REFUSAL, NOT FAILURE, and the distinction is this file's own: exit 2 says the subject
   * could not be established, which is exactly the situation. A board of exactly 500 open
   * issues is a false positive here, and the honest one — at the page size the two cases are
   * genuinely indistinguishable, and the repair is to raise BOARD_LIMIT, which is a one-line
   * change a reader can see rather than a verdict they cannot.
   */
  if (parsed.length === BOARD_LIMIT)
    throw new Refusal(
      `\`gh issue list\` returned exactly ${BOARD_LIMIT} issues, which is the --limit it was ` +
        `given. A full page cannot be told apart from a truncated one, so this set may be a ` +
        `SUBSET of the open board and every verdict about it would be about the wrong subject. ` +
        `Raise BOARD_LIMIT above the real board size.`
    );

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

/**
 * THE OPEN-ISSUE COUNT, FROM A DIFFERENT ENDPOINT THAN THE LIST.
 *
 * WHY A COUNT AND NOT A BETTER MARKER (#861). #16 was a PROXY: "the epic is in the fetched
 * set" stood in for "the fetch was complete", and the proxy was retired the day someone
 * closed the issue. Picking a different open issue reproduces that on a delay — every issue
 * can be closed, so every member-marker has a scheduled death.
 *
 * The truncation guard above already names the way out: "the relationship between a page size
 * and a result count is not a fact about any issue, so nothing anyone does on the board can
 * retire it." This is that same move applied to the gap the marker left. A COUNT IS A
 * STRUCTURAL RELATIONSHIP, not a fact about a member, so there is nothing for the board to
 * expire.
 *
 * AND IT COVERS THE RANGE THE OTHER GUARDS DO NOT. The truncation guard fires only at exactly
 * BOARD_LIMIT; the registry's `floor: 1` fires only at zero; the marker branches concern one
 * issue. A response of 1..499 issues that silently omits some satisfies every one of them,
 * and that is the case #861 was filed about.
 *
 * A BOARD THAT MOVED BETWEEN THE TWO READS REFUSES, AND THAT IS CORRECT RATHER THAN FLAKY.
 * If someone opens or closes an issue between these calls the counts differ, and the honest
 * report is that this run did not read one consistent board — which is what exit 2 means
 * here. Passing would be reporting a verdict over a subject that changed underneath it.
 *
 * GRAPHQL ERRORS ARRIVE AS HTTP 200 WITH THE ERROR IN THE BODY, so a status check alone would
 * accept one. The integer parse below is the guard that matters.
 */
export function fetchOpenCount(runner = spawnSync) {
  const r = runner(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      'query={ repository(owner: "lang-nextjs", name: "lang-nextjs") ' +
        "{ issues(states: OPEN) { totalCount } } }",
      "--jq",
      ".data.repository.issues.totalCount",
    ],
    { encoding: "utf8" }
  );
  if (r.error)
    throw new Refusal(`could not run \`gh api graphql\`: ${r.error.message}`);
  if (r.status !== 0)
    throw new Refusal(
      `\`gh api graphql\` exited ${r.status}. stderr: ${
        (r.stderr || "").trim() || "(empty)"
      }`
    );
  const raw = String(r.stdout ?? "").trim();
  if (!/^\d+$/.test(raw))
    throw new Refusal(
      `the open-issue count query returned ${JSON.stringify(
        raw.slice(0, 120)
      )}, which is not a count. A GraphQL error is HTTP 200 with the error in the body, so ` +
        `this is what one looks like here — not a number to compare against.`
    );
  return Number(raw);
}

export function analyse(issues, { markerIsOpen, openCount }) {
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
  // GUARD 2b — THE COUNT AGREEMENT, which is what watches the middle of the range. Asked
  // AFTER the marker branches so a marker inconsistency is reported as itself: the two detect
  // different corruptions and send a reader to different places.
  if (typeof openCount === "number" && issues.length !== openCount)
    throw new Refusal(
      `the fetched set has ${issues.length} issue(s) but the repository reports ` +
        `${openCount} open. The two readings are of different boards — either the list is a ` +
        `SUBSET, or the board changed between the two calls. Neither is a subject a verdict ` +
        `can be reported over.`
    );
  return {
    examined: issues.length,
    offenders: disagreements(issues),
    markerIsOpen,
    openCount: typeof openCount === "number" ? openCount : null,
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

/*
 * FIXTURE-ONLY, for the same reason `--marker-state` is: against the live API the count is
 * MEASURED, and accepting an override there would let a caller assert the agreement this guard
 * exists to derive. A fixture carries no count, so absent the flag the guard is SKIPPED rather
 * than handed `issues.length` — comparing a list against its own length is a check that cannot
 * fail, and one of those is worse than none.
 */
function parseOpenCount(argv) {
  const i = argv.indexOf("--open-count");
  if (i === -1) return null;
  if (!argv.includes("--fixture")) {
    console.error(
      `--open-count is only meaningful with --fixture. Against the live API the open count is ` +
        `MEASURED from a second endpoint, and accepting an override there would let a caller ` +
        `assert the agreement this check exists to derive.`
    );
    process.exit(2);
  }
  const v = String(argv[i + 1] ?? "");
  if (!/^\d+$/.test(v)) {
    console.error(
      `--open-count takes a non-negative integer, got ${JSON.stringify(
        argv[i + 1]
      )}`
    );
    process.exit(2);
  }
  return Number(v);
}

function main() {
  const i = process.argv.indexOf("--fixture");
  const fixture = i !== -1 ? process.argv[i + 1] : null;
  // VALIDATED BEFORE THE BRANCH, not inside the fixture arm. Parsing it only where it is used
  // means the live path IGNORES it silently, which is the failure this flag's own rule names.
  parseMarkerState(process.argv);
  parseOpenCount(process.argv);
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
    // Live: measured from a second endpoint. Fixture: null unless the case supplies one.
    const openCount = fixture ? parseOpenCount(process.argv) : fetchOpenCount();
    result = analyse(issues, { markerIsOpen, openCount });
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

  const { examined, offenders, markerIsOpen, openCount } = result;
  // GUARD 3 — name the subject, on the pass path too. A bare PASS cannot be audited.
  const subject = `${examined} open issue(s)${
    fixture ? ` from ${fixture}` : ""
  }`;
  // AND NAME WHAT THE CONTROL ESTABLISHED, not just that one ran. The two branches of guard 2
  // give different guarantees (#720), and a PASS that does not say which one it earned is a
  // guarantee that can weaken without any reader noticing.
  /*
   * THE BASIS LINE IS A CLAIM AND IT MUST TRACK WHAT ACTUALLY RAN (#861). Before the count
   * guard the closed-marker wording ended "but NOT that the response was unfiltered", which
   * was exactly right then and is exactly wrong now: the count agreement establishes it. A
   * line that UNDERSTATES the evidence is the same defect as one that overstates it, running
   * the other way. Each arm names the instrument that did the work.
   */
  const marker = markerIsOpen
    ? `#${CONTROL_MARKER} is OPEN and was found in the fetched set`
    : `#${CONTROL_MARKER} is CLOSED, so its absence is expected — \`gh\` reads the right ` +
      `repository and the board does not contain a closed issue`;
  const completeness =
    typeof openCount === "number"
      ? `and the repository independently reports ${openCount} open issue(s), matching the ` +
        `${examined} fetched — so the response was the whole board rather than a subset`
      : `and NO independent count was taken, so this run did not establish that the response ` +
        `was the whole board`;
  const basis = `control: ${marker}, ${completeness}`;
  if (offenders.length === 0) {
    reportSubject(examined, "open issue(s) examined");
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
