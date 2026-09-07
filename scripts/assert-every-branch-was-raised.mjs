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
export function classify({ branch, raised, aheadBy, known = KNOWN_UNRAISED }) {
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
  return {
    state: STATE.UNRAISED,
    detail: `${aheadBy} commit(s) ahead of main that no pull request describes`,
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
    rows.push({ branch, ...classify({ branch, raised: false, aheadBy }) });
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
  if (bad.length === 0) {
    process.stdout.write(
      `\nOK: ${names.length} remote branch(es) examined; every one is either raised as a ` +
        `pull request,\n    contributes nothing, or is recorded in KNOWN_UNRAISED with a ` +
        `reason.\n\n`
    );
    process.exit(0);
  }
  process.stderr.write(
    `\nFAIL: ${bad.length} branch(es) carry commits that no pull request describes, so they ` +
      `are\n      invisible to every sweep this repository runs:\n` +
      bad.map((r) => `        ${r.branch}  —  ${r.detail}`).join("\n") +
      `\n\n      Raise a pull request, delete the branch, or record it in KNOWN_UNRAISED with\n` +
      `      the reason it may stand.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
