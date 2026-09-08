#!/usr/bin/env node
/**
 * A BRANCH THAT WAS PUSHED BUT NEVER RAISED IS INVISIBLE TO EVERY SWEEP WE RUN.
 *
 * Three times on 2026-09-07 finished work sat on a remote branch with no pull request:
 * #1022's content, #1023's, and #1026's. Each was found by a person noticing, and each could
 * have sat indefinitely — because every instrument this repository has reads the BOARD, and
 * the board is a list of pull requests. `assert-armed-prs-are-covered-by-a-review` examines
 * open pull requests. `assert-bot-silence-is-classified` examines pull requests. A branch with
 * no pull request is not failing any of them; it is absent from all of their subjects.
 *
 * THAT IS WHY THIS IS A CHECK AND NOT A RULE. "Raise a pull request when you push" was held
 * by three different agents on the day it was broken three times. The rule was not disputed
 * and did not fire; the failure is that pushing and raising are two actions and only the first
 * one is reflexive. A check reads the same channel the rule asks a person to remember.
 *
 * THE QUESTION IS "WAS IT EVER RAISED", NOT "DOES IT HAVE AN OPEN PULL REQUEST", AND THE
 * DIFFERENCE IS THE ENTIRE SUBJECT. Measured on this repository: 559 remote branches, 540 with
 * no OPEN pull request, and 14 with no pull request in ANY state. The first number is every
 * branch whose work has already landed; the second is the defect. Asking the open-only question
 * would report 540 findings, which is a check nobody reads.
 *
 * AND `git branch --merged` CANNOT ANSWER IT HERE. This repository squash-merges, so a merged
 * branch's tip is NOT an ancestor of main and every merged branch reads as unmerged. The
 * pull-request record is the only place the merge is written down in a form that survives the
 * squash.
 *
 * A BRANCH THAT IS ZERO AHEAD IS EXCLUDED BY RULE RATHER THAN BY LIST. It contributes nothing,
 * so there is no invisible work to find — `feat/ai-backend-matrix` is the live example, 0 ahead
 * and 510 behind. That is a property, checked every run, not a name someone froze.
 *
 * THE REMAINING EXCEPTIONS ARE FROZEN WITH A REASON EACH, AND DELIBERATELY NOT A TIME WINDOW.
 * A staleness threshold would be a constant chosen from today's board — the shape #768 records
 * — and it would answer "old" when the question is "recorded". A frozen list makes each
 * surviving branch a decision somebody wrote down, and makes a NEW unraised branch fire on the
 * next run, which is the case that costs.
 *
 * Exit 0 every branch was raised or is recorded · Exit 1 at least one was not · Exit 2 the
 * question could not be asked, which is NOT the same answer as a clean board.
 */

import { spawnSync } from "node:child_process";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

/**
 * The page size asked of `gh pr list --state all`.
 *
 * IT REFUSES AT THE LIMIT RATHER THAN TRUSTING IT. A listing that returns exactly as many rows
 * as it was asked for is a CAP, not a board, and this check's finding is an ABSENCE — a branch
 * missing from the raised set. A truncated raised set turns branches that were raised into
 * findings, so the failure direction is a false accusation rather than a silent pass, which is
 * the more expensive one.
 */
export const RAISED_LIMIT = 2000;

/**
 * HOW LONG A PUSH MAY GO UNRAISED BEFORE IT IS A FINDING (#1007).
 *
 * WHY A CHECK WITH A BOARD-WIDE SUBJECT NEEDED A TIME DIMENSION. This runs inside
 * `Build, Test, Validate`, a REQUIRED PER-PULL-REQUEST context, and its subject is the whole
 * board. So an unraised branch reds whichever unrelated pull request happens to be in CI at
 * that moment — measured on #1015, which was reddened twice by two different people's branches
 * and cost roughly 45 minutes at ~15 minutes a cycle (#999). Worse, the red is NOT reproducible
 * from the reddened branch's own tree and clears when a third party opens a pull request, which
 * makes it look like a flake and invites a blind re-run.
 *
 * THE PREDICATE WAS WRONG, NOT MERELY UNLUCKY, and that is why this is a grace period rather
 * than a retry. The property worth having is that no finished work STAYS invisible. "No branch
 * is unraised" is false for the seconds between a push and the pull request that follows it —
 * it fails the legitimate workflow, every time anyone uses it. A branch inside the window is
 * not a violation being tolerated; it is not a violation.
 *
 * THE NUMBER IS DERIVED FROM A GAP, NOT PICKED. The two populations are far apart, measured on
 * 2026-09-08 over every remote branch carrying commits and no pull request:
 *
 *     transient collisions (#1015's two reds)      ~10 minutes
 *     #1028, the catch this check exists for       ~600 minutes
 *     every persistent unraised branch, 12 of them  866 .. 28159 minutes
 *
 * Nothing at all lies between 10 and 866. Any threshold in that empty region separates them,
 * so the choice is not delicate: 60 minutes sits 6x above the transient class and 10x below the
 * nearest real one. A threshold whose margin is an order of magnitude on BOTH sides is not the
 * kind that becomes a scheduled failure.
 *
 * AN UNKNOWN AGE IS TREATED AS OLD, never as young. A missing or unreadable date must not
 * DISMISS a finding — an underived constant may accuse and must not clear — so the grace is
 * granted only on a date actually read.
 */
export const GRACE_MINUTES = 60;

/**
 * Branches that exist, contribute commits, and were never raised — each with why that is
 * allowed to stand. Not a suppression list: a name here is a recorded decision, and anything
 * NOT here fires.
 */
export const KNOWN_UNRAISED = {
  "changeset-release/main":
    "the changesets bot's own branch. It raises its own pull request when a release is due; between releases it carries a version bump nobody should raise by hand.",
  "chore/flake-experiment":
    "a deliberate experiment branch from 2026-08-25, kept because its commits are the record of what was tried. 430 behind; nothing here is intended to land.",
  "feat/124-queue-readiness":
    "superseded by the readiness work that landed via other branches; kept for the two commits' reasoning, 433 behind.",
  "feat/555-citation-syntax":
    "a design spike from 2026-08-31 whose conclusion was recorded on #555 rather than shipped.",
  "fix/156-correct-migration-reason":
    "five commits from 2026-08-25, 419 behind; the migration reason was corrected on main by a different route.",
  "fix/851-the-read-is-not-the-spawn":
    "the finding landed as prose on #851; the branch is the working copy that produced it.",
  "fix/banner-does-not-claim-scripted-mid-run":
    "superseded by the banner work that landed 2026-09-04; 326 behind.",
  "fix/langfuse-console-url":
    "three commits from 2026-08-27, 334 behind; the URL fix landed via a later branch.",
  "fix/readiness-message-reads-like-a-banner":
    "same cluster as the banner branch above and superseded with it.",
  "fix/969-the-testingcard-exemption-is-recorded-and-guarded":
    "a SECOND, different attempt at #969 whose open pull request is #1005. Same file, genuinely different contributions -- patch-ids baf9c0d1e40b93a7 against 7ffcd0872f273cd9, compared by patch-id rather than by size because equal sizes would have proved nothing. Raising it would put two readers on one question. Recorded rather than raised, which is the case a staleness window could not express: six hours old and perfectly current.",
  "rescue/dev2-158-wip":
    "a rescue copy of work in progress, kept as a recovery point rather than as a candidate.",
  "specimen/stale-tree-reverts-398":
    "a SPECIMEN branch. It exists to be stale — it is the fixture a stale-tree check reads, and raising it would defeat its purpose.",
};

export const STATE = {
  RAISED: "raised",
  WITHIN_GRACE:
    "pushed recently and not yet raised - inside the grace window, not a finding",
  NOTHING_TO_LOSE: "never raised, but contributes nothing",
  RECORDED: "never raised, and recorded",
  UNRAISED: "PUSHED BUT NEVER RAISED - invisible to every sweep",
};

/** The one state that fails. */
export const FINDINGS = new Set([STATE.UNRAISED]);

/**
 * Classify ONE branch. Pure: every fact is passed in, so the proof drives every state without a
 * network — including the states the live board does not currently hold.
 *
 * `aheadBy` is null when the comparison could not be made; that is NOT zero, and treating it as
 * zero would silently excuse exactly the branch nobody can see.
 */
export function classify({
  branch,
  raised,
  aheadBy,
  ageMinutes = null,
  known = KNOWN_UNRAISED,
  grace = GRACE_MINUTES,
}) {
  if (raised) return { state: STATE.RAISED, detail: "" };
  if (Object.prototype.hasOwnProperty.call(known, branch))
    return { state: STATE.RECORDED, detail: known[branch] };
  if (aheadBy === null)
    return {
      state: STATE.UNRAISED,
      detail:
        "and its comparison against main could not be made, so whether it carries work is unknown",
    };
  if (aheadBy === 0)
    return { state: STATE.NOTHING_TO_LOSE, detail: "0 commits ahead of main" };
  /*
   * `ageMinutes === null` falls THROUGH to the finding rather than into the grace: an age we
   * could not read is not evidence of youth, and granting grace on it would let a missing date
   * dismiss real work.
   */
  if (typeof ageMinutes === "number" && ageMinutes < grace)
    return {
      state: STATE.WITHIN_GRACE,
      detail: `pushed ${ageMinutes} minute(s) ago; ${grace}-minute grace has not elapsed`,
    };
  const age =
    typeof ageMinutes === "number"
      ? `unraised for ${ageMinutes} minute(s)`
      : "age unknown, so the grace window was not granted";
  return {
    state: STATE.UNRAISED,
    detail: `${aheadBy} commit(s) ahead of main that no pull request describes, ${age}`,
  };
}

/** `gh` as data, or null when the call failed — a failure must not read as an empty list. */
function gh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function refuse(why) {
  process.stderr.write(
    `\nCOULD NOT CHECK: ${why}\n` +
      `      Exit 2, not 0 — no branch was examined, which is a different answer from\n` +
      `      every branch having been raised.\n\n`
  );
  process.exit(2);
}

/**
 * Minutes since the branch tip was committed, read from the COMPARE RESPONSE THIS CHECK ALREADY
 * MAKES — no extra API call. Verified against `repos/{owner}/{repo}/branches/<name>` as a second
 * source: same sha, same date.
 *
 * Returns null rather than a number whenever the tip is not certainly in hand, and `classify`
 * treats every such case as OLD:
 *
 *   - the compare failed, so there is nothing to read;
 *   - `commits` is shorter than `ahead_by`, which happens past GitHub's 250-commit cap — the
 *     last element is then NOT the tip and its date would understate the age;
 *   - the date is missing or unparseable.
 *
 * A committer date is a PROXY for push time and can be older than the push (an amend rewrites
 * it, a rebase does not preserve it). It errs toward looking OLDER, hence toward reporting a
 * finding, which is the safe direction for a proxy standing in for a grace.
 */
export function tipAgeMinutes(cmp, now = Date.now()) {
  if (cmp === null || cmp === undefined) return null;
  const commits = Array.isArray(cmp.commits) ? cmp.commits : null;
  if (commits === null || commits.length === 0) return null;
  if (typeof cmp.ahead_by === "number" && commits.length < cmp.ahead_by)
    return null;
  const iso = commits[commits.length - 1]?.commit?.committer?.date;
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 60000);
}

function main() {
  /*
   * READ AS TEXT, NOT THROUGH `gh()`. `--jq` over a PAGINATED list emits newline-delimited
   * values rather than one JSON document, so `JSON.parse` fails on the second page and `gh()`
   * would return null — a successful call reported as a failure, and this check refuses on
   * null. The first draft of this function called `gh()` here as well and threw the result
   * away, which is how the shape was found.
   */
  const raw = spawnSync(
    "gh",
    [
      "api",
      "repos/{owner}/{repo}/branches?per_page=100",
      "--paginate",
      "--jq",
      ".[].name",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (raw.error || raw.status !== 0)
    refuse(
      "`gh api .../branches` did not answer, so no branch list was obtained."
    );
  const names = raw.stdout.split("\n").filter(Boolean);
  if (names.length === 0)
    refuse(
      "the branch listing came back EMPTY. This repository always has branches, so an empty list is the API answering with nothing rather than a board with nothing on it."
    );

  const prs = gh([
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    String(RAISED_LIMIT),
    "--json",
    "headRefName",
  ]);
  if (prs === null)
    refuse(
      "`gh pr list --state all` did not answer, so the raised set is unknown."
    );
  if (prs.length >= RAISED_LIMIT)
    refuse(
      `\`gh pr list\` returned ${prs.length} rows against a limit of ${RAISED_LIMIT}, so the\n` +
        `      list is CAPPED rather than complete. A truncated raised set turns branches that\n` +
        `      WERE raised into findings, so this refuses rather than accusing them.`
    );
  const raised = new Set(prs.map((p) => p.headRefName));

  reportSubject(names.length, "remote branch(es)");

  const rows = [];
  for (const branch of names) {
    if (branch === "main") continue;
    if (raised.has(branch)) continue;
    const cmp = gh(["api", `repos/{owner}/{repo}/compare/main...${branch}`]);
    const aheadBy = cmp === null ? null : cmp.ahead_by ?? null;
    rows.push({
      branch,
      ...classify({
        branch,
        raised: false,
        aheadBy,
        ageMinutes: tipAgeMinutes(cmp),
      }),
    });
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
  if (bad.length === 0) {
    /*
     * A GREEN NAMES THE GRACE WINDOW WHEN IT USED ONE. Branches inside the window are exactly
     * the cases this check now declines to report, so folding them silently into "every one is
     * fine" would be a pass claiming more than it examined — and the window is where a
     * genuinely abandoned branch spends its first hour looking identical to a healthy push.
     */
    const waiting = rows.filter((r) => r.state === STATE.WITHIN_GRACE);
    const graceNote = waiting.length
      ? `\n    ${waiting.length} pushed within the last ${GRACE_MINUTES} minute(s) and not yet ` +
        `raised —\n    not a finding, and it becomes one if still unraised:\n` +
        waiting.map((r) => `      ${r.branch}  —  ${r.detail}`).join("\n") +
        `\n`
      : "";
    process.stdout.write(
      `\nOK: ${names.length} remote branch(es) examined; every one is either raised as a ` +
        `pull request,\n    contributes nothing, is recorded in KNOWN_UNRAISED with a reason, ` +
        `or was\n    pushed within the ${GRACE_MINUTES}-minute grace window.\n${graceNote}\n`
    );
    process.exit(0);
  }
  /*
   * THE BRANCH NAME GOES IN THE FIRST LINE, because that is the part run-checks.mjs puts in the
   * GitHub annotation and the annotation is all most readers see. The old first line counted
   * branches, and the name arrived twelve lines into a ten-thousand-line log (#1007).
   *
   * AND THE FIRST LINE SAYS IT IS NOT ABOUT THIS PULL REQUEST. The subject is the whole board
   * inside a per-pull-request context, so the reader's default reading — "my change broke
   * something" — is wrong, and acting on it means bisecting a tree that cannot contain the
   * cause. Saying so in the annotation is what stops the blind re-run.
   */
  const badNames = bad.map((r) => r.branch).join(", ");
  process.stderr.write(
    `\nFAIL: unraised branch(es) ${badNames} — NOT a defect in the pull request under test.\n` +
      `      This check's subject is the whole board, so nothing in this branch's diff caused\n` +
      `      it and nothing in this branch's tree can fix it. Do not bisect; do not re-run.\n\n` +
      `      ${bad.length} branch(es) carry commits that no pull request describes, so they are\n` +
      `      invisible to every sweep this repository runs:\n` +
      bad.map((r) => `        ${r.branch}  —  ${r.detail}`).join("\n") +
      `\n\n      WHOEVER PUSHED IT clears this: raise a pull request, delete the branch, or\n` +
      `      record it in KNOWN_UNRAISED with the reason it may stand. A branch pushed within\n` +
      `      the last ${GRACE_MINUTES} minutes is inside the grace window and is not listed\n` +
      `      here at all.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
