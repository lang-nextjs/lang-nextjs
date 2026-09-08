#!/usr/bin/env node
/**
 * A PULL REQUEST THAT COULD MERGE IS COVERED BY ITS REVIEW.
 *
 * THE NAME OF THIS FILE IS NARROWER THAN ITS SUBJECT, DELIBERATELY AND FOR NOW (#1053). It reads
 * armed pull requests AND every merge candidate. Renaming it means renaming the REGISTRATION,
 * which is the key its census row is filed under, which obliges a fresh `pnpm eject-audit` — and
 * three registrations are already contending for `scripts/checks.json`. The rename is worth doing
 * and worth doing alone. `isMergeCandidate` is where the subject is actually defined, and this
 * paragraph exists so nobody takes the filename as the answer.
 *
 * WHY THE SUBJECT MOVED. The armed subject was correct and became EMPTY: #945 produced both this
 * gate and the practice that empties it — we stopped arming and merge one at a time by hand — so
 * `armed` has been zero continuously and every row short-circuited to UNARMED. The check reported
 * `ok` and covered none of the four merges the night #1053 was filed. Nothing about it was broken;
 * its population had left.
 *
 * Auto-merge makes MERGE TIME unpredictable: an armed PR lands the moment its last check goes
 * green, which may be before a reviewer has read it and may be after content was added that
 * nobody read. #945 merged that way — an amendment fixing two paragraphs that the merge itself
 * made false was in flight, and the paragraphs reached main asserting the opposite of the
 * contract. The rule "do it before you arm it" was already held for the STACKED case and did not
 * fire for this one, which is why this is a check rather than a written rule.
 *
 * WHY `reviewDecision` IS NOT USED, MEASURED RATHER THAN ASSUMED. `gh pr view --json
 * reviewDecision` is the obvious field and it returns "" for EVERY pr in this repo, because no
 * required reviewers are configured. A check wired on it would print a confident, well-formed,
 * identical nothing on every row, and "no review is open anywhere" is exactly the answer a reader
 * wants to see. The field exists and does not discriminate.
 *
 * WHY A TOKEN AND NOT THE PROSE. Reviews are posted as comments whose wording has drifted —
 * `**Reviewed by DEV1 at ...**`, `## Review:`, `**Delta review by DEV3 at ...**`. Matching that is
 * a claim about wording, the same dependency #946 exists to assert. The cheaper proxy is worse:
 * comment COUNT breaks two ways, because Dependabot posts its own comment and because every agent
 * authenticates under one login, so authorship cannot separate a reviewer's report from the
 * author's own note. `READER-REPORT: <agent> @ <sha>` cannot be satisfied by either.
 *
 * WHY A SHA MISMATCH IS NOT THE FINDING. The first version of this reported `report sha != head`
 * and would have fired on nearly every armed PR on the board, because promoting a PR calls
 * `update-branch` and every promotion moves the head. A line that fires on everything is a line
 * nobody reads. What matters is whether the PR CONTRIBUTES anything the review did not cover, so
 * the comparison is what the PR adds over main — three-dot, so main's own movement drops out —
 * at the reviewed sha versus at the head.
 *
 * WHAT THIS TOKEN IS NOT, STATED HERE BECAUSE A THREAD DOES NOT SURVIVE. It is a COORDINATION
 * MARKER, NOT EVIDENCE OF REVIEW. This check can verify that a sha names something real and that
 * it covers what merges; it cannot verify that anybody read anything. A mistyped sha, or a token
 * pasted onto an abandoned read, is well formed and passes. It exists to stop a PR being armed
 * while a read is outstanding, and THE MOMENT IT IS CITED AS "this PR was reviewed" IT ASSERTS
 * MORE THAN IT MEASURES.
 *
 * Sharper, and the reason that limit is written here rather than left to be rediscovered: the
 * token INHERITS THE REVIEWER'S ERRORS RATHER THAN CATCHING THEM. DEV1's "inert confirmed" on
 * #945 rested on two of the three readers that mattered, and a token on that review would have
 * been perfectly well formed. The token records that a read HAPPENED, never that it was adequate,
 * and nothing automatable closes that gap.
 *
 * AND IT CANNOT TELL YOU WHO READ IT, WHICH IS A STRONGER LIMIT THAN THE PARAGRAPH ABOVE AND WAS
 * NOT WRITTEN DOWN UNTIL SOMEBODY ASSUMED OTHERWISE. Every agent on this repository authenticates
 * as ONE GitHub login, so `author.login` distinguishes nobody and the agent name in a token is
 * SELF-DECLARED AND UNVERIFIABLE. Any session can post `READER-REPORT: <anyone> @ <any sha>` and
 * this check will accept it. So "covered by a review" means, exactly and only, THAT SOMEBODY TYPED
 * A WELL-FORMED TOKEN.
 *
 * THE PARAGRAPH ABOVE WAS TRUE, CORRECTLY PLACED, AND DID NOT PREVENT THIS. On 2026-09-07 three
 * tokens were posted carrying coverage forward across a promotion, each naming the ORIGINAL reader
 * and a sha that reader had never seen. The prose beside them disclosed the carry; the token did
 * not, and THE GATE READS THE TOKEN. They were inert only because they were emphasised at a time
 * when the pattern was anchored — an accident, not a safeguard. A reader who assumed the name in a
 * token was attested by anything then re-posted one bare under their own name, converting an
 * attributed guess into a first-person attestation. A limit stated as a PROPERTY ("cannot verify
 * that anybody read anything") did not do the work; it needed to state the CONSEQUENCE.
 *
 * WHAT THE HONEST FORM LOOKS LIKE, since the need is real: a promotion merge cannot change a
 * branch's three-dot contribution, so re-reading after one is genuinely redundant. But the carry
 * must be posted BY THE READER, as a delta naming both endpoints —
 * `READER-REPORT: DEV3 @ <read-sha>..<head-sha> (delta only)` — which this check supports
 * natively and which asserts exactly what was done. It still does not bind identity. Nothing here
 * can.
 *
 * Exit 0 every armed PR is covered · Exit 1 at least one is not · Exit 2 the question could not
 * be asked at all, which is NOT the same answer as "all covered".
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

/** GitHub's per-compare file cap. Named because two sides of one comparison must use ONE. */
export const COMPARE_FILE_CAP = 300;

/**
 * `READER-REPORT: DEV1 @ 00d5f110` for a full read, `... @ 959ea154..47063cf2 (delta only)` for a
 * delta. The agent names itself because the git identity cannot: every agent authenticates under
 * one login. THE RANGE FORM IS NOT A CONVENIENCE — forcing a single sha would make a delta reader
 * overclaim, reading as "DEV1 read 47063cf2" when what they read was the difference, and `..` is
 * the discriminator. Trailing prose after the range is allowed and ignored.
 *
 * A SYMMETRIC `**` WRAPPER IS STRIPPED, AND ONLY THAT ONE. The board decided this, not taste:
 * swept over 19 open pull requests, DEV2 writes `**READER-REPORT: ...**` for 5 of 5 of their
 * tokens and DEV3 for 1 of 3, so bolding is a CONVENTION here and not a slip. Four pull requests
 * -- #990, #1003, #1004 and #1005 -- carried a read and no parseable token, and would have been
 * told `ARMED, NO READER REPORT` the moment they were armed.
 *
 * WHY THIS IS NOT THE LOOSENING THAT WAS REFUSED. A symmetric wrapper is semantically empty: the
 * token content is still matched character for character and nothing about the agent, the sha or
 * the form is inferred. Blockquote, list, heading, indent and backticks genuinely CHANGE the line
 * and remain refusals that quote themselves, so the direction-of-failure argument survives for
 * all five. `\k<bold>` is what makes it symmetric -- an unmatched group backreferences the empty
 * string, so a bare `READER-REPORT:` line is unaffected and `**READER-REPORT: ...` with no
 * closing pair is NOT accepted, it is a refusal.
 *
 * THE GROUPS ARE NAMED BECAUSE ADDING THE WRAPPER WOULD HAVE RENUMBERED THEM. `agent` was `m[1]`
 * and the wrapper is now first; positional reads would have silently taken `**` as the agent
 * rather than failing. A name cannot be shifted by inserting a group beside it.
 */
export const TOKEN =
  /^(?<bold>\*\*)?READER-REPORT:\s*(?<agent>\S+)\s*@\s*(?<a>[0-9a-f]{7,40})(?:\.\.(?<b>[0-9a-f]{7,40}))?\s*(?:\(.*\))?\s*\k<bold>\s*$/mu;

/**
 * A report with the token but no usable sha still counts as a REPORT, so that a malformed one is
 * reported as unverifiable rather than as absent. The two are different findings and conflating
 * them is a defect this check was written after committing: a prototype labelled a report that
 * named no sha as "stale", which reports the unverifiable as verified.
 *
 * THE LEADING DECORATION IS THE WHOLE POINT AND IT WAS MEASURED ON THE LIVE BOARD. This was
 * `/^READER-REPORT:/mu` -- anchored exactly like `TOKEN` -- so a token wearing any markdown
 * decoration matched NEITHER, and the pull request reported `NO READER REPORT`: nobody looked.
 * #974 carried `**READER-REPORT: ARCHITECT @ 87e8c6eb**` and that is what it said. Driven over
 * bold, blockquote, list, heading and indent, all five read as absent. The verdict was right and
 * THE CAUSE WAS FALSE, which is the `unreadableReason` defect this file already fixed once: a
 * reader told a read did not happen looks for a reader, not for two asterisks.
 *
 * IT DELIBERATELY DOES NOT MATCH MID-SENTENCE PROSE. The character class admits only decoration
 * -- horizontal whitespace, `>`, `*`, `_`, `#`, backtick, `-` -- so a comment DISCUSSING the
 * token, of which this repository writes many, is not mistaken for one.
 *
 * THE WHITESPACE IS HORIZONTAL, AND THE LIVE ARTIFACT IS WHAT CAUGHT IT. Written as `\s`, the
 * class matched NEWLINES too, so the capture ran backwards across blank lines and swallowed
 * whatever decoration-shaped text preceded it: driven against #974's real comment it quoted
 * `"---\n\n**READER-REPORT: ..."`, reporting a horizontal rule as part of the offending line.
 * Every fixture in the proof was a single line, so nothing local could see it.
 */
export const TOKEN_LOOSE = /^([ \t>*_#`-]*READER-REPORT:.*)$/mu;

/**
 * A token comment that has been RETRACTED by its author, marked in the comment itself.
 *
 * WHY THIS EXISTS AT ALL, AND IT IS THE HALF THAT CHANGES A VERDICT. A withdrawn token used to
 * COUNT: TEAMLEAD withdrew a coverage carry on #974 by editing a `> [!CAUTION]` block above it,
 * and this check -- which has no concept of withdrawal -- classified the pull request `covered`
 * off the retracted read. Measured, not argued: with the token intact below the caution block,
 * `classify` returned `covered` and did not fail. That is silent in the direction that costs.
 *
 * WHY IN THE TOKEN'S OWN COMMENT AND NOT A SIBLING. A withdrawal posted as a SEPARATE comment
 * cannot be tied to the token it retracts by anything this check can read, so the marker has to
 * live where the token lives. That is also what the author did, and the artifact proved it: the
 * comment carried `updated_at != created_at`.
 *
 * A FALSE POSITIVE HERE FAILS TOWARD "NOT COVERED", which is why the marker is a plain word at
 * the start of a line rather than something harder to write by accident.
 */
export const WITHDRAWN_MARKER = /^[ \t>*_#`-]*WITHDRAWN\b/mu;

export const STATE = {
  UNARMED: "not a merge candidate",
  OK: "covered",
  NO_REPORT: "A MERGE CANDIDATE, NO READER REPORT",
  NO_SHA: "A MERGE CANDIDATE, REPORT NAMES NO SHA - COULD NOT CHECK",
  UNCOVERED: "A MERGE CANDIDATE, CONTENT ADDED SINCE THE REVIEW",
  UNREADABLE: "A MERGE CANDIDATE, COULD NOT COMPARE - COULD NOT CHECK",
  UNCOMPARED:
    "A MERGE CANDIDATE, A COMPARISON DID NOT ANSWER - COULD NOT CHECK",
  PARTIAL: "A MERGE CANDIDATE, ONLY A DELTA WAS READ AND NOBODY READ ITS BASE",
  REMOVED_ONLY:
    "a merge candidate, and only REMOVALS have appeared since the review",
  UNFETCHED:
    "A MERGE CANDIDATE, ITS COMMENTS COULD NOT BE FETCHED - COULD NOT CHECK",
  UNPARSED:
    "A MERGE CANDIDATE, A REPORT IS PRESENT THAT THE TOKEN DOES NOT MATCH - COULD NOT CHECK",
  WITHDRAWN: "A MERGE CANDIDATE, EVERY READER REPORT ON IT HAS BEEN WITHDRAWN",
};

/**
 * The states meaning the question COULD NOT BE ASKED for a pull request — exit 2, not exit 1.
 *
 * `gh pr view` FAILING WAS REPORTED AS "NOBODY READ THIS", which is this file's own thesis used
 * against it. `main()` carefully kept `null` to mean "could not fetch" and then handed
 * `reports ?? []` to `classify`, so a failed fetch became an empty comment list and came back
 * `ARMED, NO READER REPORT` at exit 1 — sending a reader to a pull request whose comments were
 * never retrieved, and which may carry a perfect token. Driven with a `gh` whose `pr list`
 * answers and whose `pr view` fails, that is exactly what it printed.
 *
 * THE FILE ALREADY KNEW. A failed `gh pr list` exits 2 with a paragraph saying no comparison was
 * made; one call later the same distinction was discarded. The neighbouring gate
 * `assert-census-fresh` draws it too — it refuses with exit 2 when a dirty branch makes freshness
 * uncomputable, rather than reporting a stale census.
 */
/*
 * `UNCOMPARED` JOINS IT, AND THE SPLIT IS THE POINT (#1082). `UNREADABLE` STAYS A FINDING.
 *
 * The rule above was stated for `reports` and abandoned ninety lines later for the compare: a
 * null contribution is a fetch that did not answer, exactly like `reports === null`, and it was
 * classified as a finding AGAINST THE PULL REQUEST. Observed live -- #1078 was named as failing
 * coverage while both compares answered by hand, the rate limit sat at 4380/5000, and two
 * consecutive re-runs were clean. A transient hiccup reddened a required context and told a
 * reader to re-read a pull request that was already covered.
 *
 * MOVING `UNREADABLE` WHOLESALE WOULD BE WRONG, and this is a split rather than a move. A
 * compare that ANSWERS and carries a file with no patch -- binary, or too large -- is a genuine
 * finding: the pull request contains something no reader can have read, and that must fail.
 *
 * THE DISCRIMINATOR NEEDED NO NEW DETECTION. It is whether the endpoint answered:
 *
 *     the fetch did not answer      nothing is known, including whether the answer would have
 *                                   been readable                            -> UNCOMPARED, exit 2
 *     it answered and cannot be     the pull request carries an unreadable diff
 *     used                                                                   -> UNREADABLE, exit 1
 *
 * AND A REFUSAL OUTRANKS A FINDING HERE TOO, so `uncompared` is read first in `classify`. If one
 * endpoint did not answer, coverage is not computable, whatever the other endpoint said.
 */
export const REFUSALS = new Set([STATE.UNFETCHED, STATE.UNCOMPARED]);

/** The states that fail the check. `UNARMED` and `OK` do not. */
export const FINDINGS = new Set([
  STATE.NO_REPORT,
  STATE.NO_SHA,
  STATE.UNCOVERED,
  STATE.UNREADABLE,
  STATE.PARTIAL,
  STATE.UNPARSED,
  STATE.WITHDRAWN,
]);

/**
 * Every reader report on a PR, as {agent, sha, unparsed, withdrawn}; sha null when the token
 * carried none, `unparsed` the offending LINE when a report is present that `TOKEN` does not
 * match, `withdrawn` when its own comment retracts it.
 *
 * A REPORT THAT CANNOT BE COUNTED IS STILL RECORDED, because the three reasons it cannot be
 * counted -- names no sha, does not parse, was withdrawn -- are three different things to tell a
 * reader, and none of them is "nobody read this".
 */
export function reportsFrom(comments) {
  const out = [];
  for (const c of comments ?? []) {
    const body = c?.body ?? "";
    const withdrawn = WITHDRAWN_MARKER.test(body);
    const m = TOKEN.exec(body);
    if (m)
      out.push({
        agent: m.groups.agent,
        from: m.groups.b ? m.groups.a : null,
        sha: m.groups.b ?? m.groups.a,
        unparsed: null,
        withdrawn,
      });
    else {
      const loose = TOKEN_LOOSE.exec(body);
      if (loose)
        out.push({
          agent: null,
          from: null,
          sha: null,
          unparsed: loose[1].trim(),
          withdrawn,
        });
    }
  }
  return out;
}

/**
 * The reports that can still carry coverage -- everything not withdrawn.
 *
 * EXPORTED AND USED BY BOTH CALLERS ON PURPOSE. `main()` unions the contributions of the shas the
 * reports name, so filtering withdrawal in `classify` ALONE would leave a retracted read still
 * widening the covered set on the way in. Two places must agree, and the arms below assert the
 * call site rather than only the function.
 */
export function liveReports(reports) {
  return (reports ?? []).filter((r) => !r.withdrawn);
}

/**
 * Two shas naming the same commit, allowing for different abbreviations. Reports are written by
 * hand, so one may say `959ea154` where another says the full forty.
 */
function sameCommit(a, b) {
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

/**
 * The delta reports whose range START nobody has reported on.
 *
 * A DELTA READ COVERS THE DIFFERENCE, NOT THE PULL REQUEST. #935 is the benign shape: DEV1 read
 * `959ea154` in full and then read the delta after DEV2's fixes, so the two reports COMPOSE and
 * between them cover everything. From outside, that is indistinguishable from a delta read of a
 * PR whose base nobody ever read — and the distinction CANNOT BE RECOVERED afterwards, which is
 * why the range lives in the token rather than being inferred here.
 */
export function unanchoredDeltas(reports, head = null) {
  /*
   * A FULL READ AT THE CURRENT HEAD ANCHORS EVERYTHING, AND THE QUESTION IS COVERAGE RATHER THAN
   * PRESENCE (#1105).
   *
   * A BARE token has no `from`, so it could never satisfy the test below -- it contributes to
   * `ends`, but only a delta starting at exactly that sha was anchored by it. That made a chain of
   * deltas permanently PARTIAL even when a reader had since read the WHOLE contribution: driven on
   * #1086, the returned set was byte-identical with and without the full read, so the sentence
   * "no report names <from>" stayed true while being the wrong thing to say. That is the defect
   * `unreadableReason` exists to prevent one screen up in this same file -- a true-shaped finding
   * carrying a cause that did not occur.
   *
   * WHY THE HEAD AND NOT MERELY ANY BARE TOKEN. "Any bare token clears everything" converts a
   * false finding into a FALSE CLEAR, which is the direction that costs: a bare read at an OLD sha
   * says nothing about content pushed after it, and those are exactly the deltas that need
   * anchoring. A bare read at the CURRENT head is different in kind -- its subject is
   * `main...head`, which by construction contains every delta's range -- so there is nothing left
   * for a delta to be the only cover for.
   *
   * NO ANCESTRY IS CONSULTED, AND THAT IS THE MORE FAITHFUL PREDICATE RATHER THAN A RETREAT.
   * An ancestry test would be wrong in the FALSE-CLEAR direction specifically: a bare token at an
   * ANCESTOR of the head passes reachability while saying nothing about content pushed after it --
   * which is the same hole the stale-bare-token arm guards, arriving through a different door. The
   * claim is not "this sha reaches that one"; it is "somebody read the whole of what this pull
   * request contributes, AS IT STANDS NOW", and that is a statement about the head rather than
   * about what the head reaches.
   *
   * (It is also undefeatable by a squash, where a reachability test is not. That is a second
   * reason and deliberately the second one: on its own it reads as a workaround forced by the
   * merge strategy, and invites someone to "fix" this when the merge strategy changes.)
   *
   * ABBREVIATION IS WHY `sameCommit` AND NOT `===`. `main()` passes `p.headRefOid`, forty hex
   * characters; every token a human writes is abbreviated to eight. Strict equality would clear
   * NOTHING on any real run while every fixture -- equal-length on both sides -- stayed green.
   * That failure is invisible in the worst way: it under-clears, so it is indistinguishable from
   * the bug this repair exists to fix, with a passing suite saying the repair is present.
   */
  const readWhole = (reports ?? []).some(
    (r) => !r.from && r.sha && head && sameCommit(r.sha, head)
  );
  if (readWhole) return [];
  /*
   * ANCHORING IS REACHABILITY, NOT ONE HOP (#1073).
   *
   * The property being asserted is THE CHAIN REACHES A FULL READ. What the previous test asked
   * was MY BASE IS SOMEBODY'S TIP -- a local stand-in that coincides with the property on every
   * acyclic shape and comes apart on a cycle:
   *
   *     full(A) + A..B + B..C          anchored   correct under both
   *     A..B and B..A, NO FULL READ    anchored   *** WRONG *** under the old test
   *
   * In that second shape nobody has read the base of anything, no full read exists anywhere, and
   * the gate reported the pull request covered. Two deltas anchored each other. It is unusual
   * input rather than absurd -- a re-read posted as a delta backwards over a revert produces it --
   * and the cost is a FALSE CLEAR, which is the direction this file cares about.
   *
   * So the walk follows `from` links until it terminates, and only ONE ending is anchoring:
   *
   *     a report with no `from`      a FULL read -- the chain is grounded          ANCHORED
   *     no report at that sha        the root dangles, nobody read the base        unanchored
   *     a sha already visited        a cycle, so the chain never reaches ground    unanchored
   *
   * A CHAIN WITH NO FULL READ NOW REPORTS EVERY MEMBER, WHERE THE OLD TEST REPORTED ONLY ITS
   * ROOT. That is a deliberate consequence rather than an accident: under the property, no member
   * of an ungrounded chain is covered, and naming only the root understated what is unread. No
   * arm pinned the old count -- the three-delta fixtures in the proof are UNRELATED deltas, not a
   * chain, so they answer 3 under both.
   *
   * `sameCommit` throughout, never `===`: `main()` passes 40 hex characters and every token a
   * human writes is abbreviated to eight, so strict equality would ground NOTHING on a live run
   * while every equal-length fixture stayed green.
   */
  const all = reports ?? [];
  const grounded = (start) => {
    const seen = [];
    let cursor = start;
    while (cursor) {
      if (seen.some((s) => sameCommit(s, cursor))) return false;
      seen.push(cursor);
      const at = all.find((r) => r.sha && sameCommit(r.sha, cursor));
      if (!at) return false;
      if (!at.from) return true;
      cursor = at.from;
    }
    return false;
  };
  return all.filter((r) => r.from && !grounded(r.from));
}

/**
 * The independent file total to check a `main...head` compare against, or null when there is none.
 *
 * `changedFiles` IS MEASURED AGAINST THE PULL REQUEST'S OWN BASE, and this compare is against
 * `main`. For a pull request based on `main` those are the same quantity and the second reading is
 * worth having. For a STACKED pull request they are DIFFERENT QUANTITIES, so `expected` stops
 * being a second reading of the same thing -- which is the entire premise the guard rests on.
 *
 * DRIVEN AGAINST THIS PULL REQUEST ITSELF: compare(main...head) listed 5 files, `changedFiles`
 * said 2, and the guard reported one of the readings incomplete when neither was.
 *
 * THE GREEN COULD NOT SEE IT, WHICH IS THE PART WORTH KEEPING. On the day it was written the board
 * held 20 open and 16 armed with exactly ONE stacked pull request -- this one, deliberately
 * unarmed by a policy stated in its own body -- so `stacked AND armed` was zero and the live run
 * was silent by construction. The table in that body was true of the sample and false of the
 * population: 11 pull requests here have had a non-main base. An instrument that cannot observe
 * its own author's case is the narrowest possible subject.
 */
export function expectedFileCount(pr) {
  return pr?.baseRefName === "main" ? pr.changedFiles ?? null : null;
}

/**
 * WHY a contribution cannot be read, as the sentence a reader gets, or null when it can.
 *
 * SEPARATE FROM `contribution` BECAUSE THREE CAUSES SHARED ONE NAME. The first version passed a
 * boolean called `truncated`, set whenever the compare succeeded and the contribution came back
 * null — true for a list at the cap, for a count disagreeing with the pull request's own, AND for
 * a file whose patch is absent. A single binary file then produced "the compare file list was
 * truncated", asserting a cause that had not occurred.
 *
 * THE REACHABILITY IS INVERTED, WHICH IS WHY IT MATTERED. Truncation needs 300 changed files; the
 * largest pull request this repository has ever had is #81 at 253, so it is rare. A missing patch
 * needs ONE binary file, and four PNG baselines are tracked here, so any pull request touching a
 * visual baseline hit it — and was told its file list was truncated.
 */
/**
 * The files whose `patch` GitHub withheld — binary, or over its size threshold.
 *
 * MEASURED, because "too large" was a guess until it was not. GitHub omits `patch` above a
 * threshold on the PATCH TEXT, not on the file and not at random. Sampled on this repository:
 *
 *     pnpm-lock.yaml    991 changes ->  76687 chars   PRESENT
 *     pnpm-lock.yaml   1293 changes -> 151152 bytes   ABSENT
 *
 * Six identical fetches of the same compare, and the response carries its own control — nine of
 * its ten files DO have patches, so the endpoint is not refusing wholesale. The same file is also
 * withheld on `pulls/:n/files`, so it is the file's patch and not the compare's response budget.
 *
 * That rules out both of the shapes this looked like: it is not permanent (a small lockfile
 * change is readable) and it is not flaky (it is deterministic for a given diff).
 *
 * ONLY EVER CONSULTED WHERE `patch` IS NOT A STRING. `contribution` has a second caller whose
 * files come from a LOCAL `git diff` and carry `{ filename, patchLines }` — no `status`, no
 * `contents_url`, no `sha`. Reading any of those unconditionally would break that caller at a
 * distance, in a file this change does not touch. Found by DEV2 before this was written.
 */
export function withheldPatchFiles(files) {
  return (files ?? []).filter(
    (f) => f.status !== "unchanged" && typeof f.patch !== "string"
  );
}

/**
 * THE REASONS THAT ARE ABOUT THE LIST ITSELF, split out because they have NO fallback and the
 * per-file one does. Truncation and a file-count disagreement both say the list is MISSING
 * ENTRIES; nothing per-file repairs that, because the files you would repair are the ones you
 * cannot see. A withheld patch is the opposite — the entry is present and names where its
 * content lives.
 *
 * Keeping them in one function would have made the fallback look like it covered both.
 */
export function unreadableReasonOfList(files, expected = null) {
  const n = files?.length ?? 0;
  if (n >= COMPARE_FILE_CAP)
    return `the compare listed ${n} files, at GitHub's cap of ${COMPARE_FILE_CAP}, so the list may be truncated`;
  if (expected !== null && n !== expected)
    return `the compare listed ${n} files but the pull request reports ${expected} changed, so one of the two readings is incomplete`;
  return null;
}

/**
 * Unchanged in behaviour, and deliberately so — 24 call sites in the proof and two in `main`
 * depend on it answering exactly as before when no fallback is in play.
 */
export function unreadableReason(files, expected = null) {
  const listReason = unreadableReasonOfList(files, expected);
  if (listReason) return listReason;
  for (const f of withheldPatchFiles(files))
    return `${f.filename} carries no patch — binary or too large — so what it contributes cannot be read`;
  return null;
}

/**
 * A PR's contribution, as the LINES it adds and removes, from a THREE-DOT comparison against main.
 *
 * Three-dot is what makes this survive `update-branch`: it compares against the merge base, so
 * commits that arrived from main are not part of the contribution and moving the base changes
 * nothing.
 *
 * WHY LINES AND NOT `path@blob`, WHICH IS WHAT THIS USED TO BE AND WHAT THE LIVE BOARD REFUTED.
 * A blob comparison is exact for a hand-written file and WRONG for a generated one. A rebase
 * regenerates `pnpm-lock.yaml`, so its blob differs essentially always, and three dependabot pull
 * requests were reported as "content added since the review" when measured against their own
 * bases they add EXACTLY what they added at review time. Since promotion is a rebase, every
 * rebased dependabot PR would have flagged forever — the check loudest on the pull requests
 * needing least attention, which is the failure this file's own header warns about.
 *
 * A MISSING PATCH IS NOT AN EMPTY ONE. GitHub omits `patch` for binary and very large diffs, and
 * a file whose patch is absent cannot be compared at all, so this returns null rather than a set
 * that silently excludes it.
 */
export function contribution(files, expected = null, ctx = null) {
  /*
   * A TRUNCATED LIST IS NOT A SHORTER CONTRIBUTION. The compare endpoint caps `files` at 300 and
   * carries NO total to check it against — `ahead_by`, `behind_by` and `total_commits` are the
   * only counts it returns — so a pull request over the cap would silently compare a subset and
   * pass. `expected` is that missing total, taken from an INDEPENDENT source: the pull request's
   * own `changedFiles`, which agrees with the compare length exactly on every PR measured.
   *
   * THE CAP REFUSES UNCONDITIONALLY, AND THE FIRST VERSION DID NOT. It trusted an agreeing
   * `expected` even at 300, which is safe ONLY IF the pull request's `changed_files` is not
   * itself capped at 300 — an unstated, load-bearing premise, and if it is capped the two
   * readings agree FOR THE WRONG REASON at precisely the size this guard exists for. That is the
   * two-readings-of-one-quantity failure the paragraph above claims to avoid. Neither DEV2 nor I
   * could test it. So the premise is removed rather than documented, and the cost is a false
   * refusal on a very large pull request. MEASURED over all 615, rather than carried from a
   * summary: the largest is #81 at 253 files, 10 exceed 32, and 0 reach 300. Until #953 this
   * paragraph carried a much smaller figure and called the cap unapproachable; both were wrong,
   * and the second mattered more, because a reader weighing whether the unconditional refusal
   * is worth its cost was handed the understated number. The old figures are described rather
   * than quoted, so a grep for them does not return this correction reading as a live claim.
   *
   * THE ASYMMETRY IS REAL AND WORTH STATING, AND IT HAS THREE MEMBERS RATHER THAN TWO SINCE
   * `expectedFileCount` landed: a main-based head has a second reading, a STACKED head has
   * none because its own count is measured against a different base, and the reviewed sha; the
   * reviewed sha is not a pull request and has none, so it falls back to the cap itself. That
   * fallback constant is not derived, and it is allowed here for the reason an underived
   * threshold is ever allowed: it can only make this REFUSE, never make it pass.
   */
  const withheld = withheldPatchFiles(files);
  /*
   * THE LIST-LEVEL REASONS STILL REFUSE OUTRIGHT. Truncation and a file-count disagreement are
   * statements that the LIST is incomplete, and no per-file route repairs a list that is missing
   * entries. Only the per-file "no patch" reason has a fallback, and only when one is supplied.
   */
  if (withheld.length === 0 || !ctx) {
    if (unreadableReason(files, expected)) return null;
  } else if (unreadableReasonOfList(files, expected)) {
    return null;
  }

  const adds = new Set();
  const rems = new Set();
  for (const f of files ?? []) {
    if (f.status === "unchanged") continue;
    if (typeof f.patch === "string") {
      for (const line of f.patch.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+"))
          adds.add(`${f.filename}\u0000${line.slice(1)}`);
        else if (line.startsWith("-"))
          rems.add(`${f.filename}\u0000${line.slice(1)}`);
      }
      continue;
    }
    /*
     * A WITHHELD PATCH CONTRIBUTES ITS WHOLE CONTENT ON EACH SIDE, and the over-statement is
     * DELIBERATE. A diff of the two blobs would be tighter, but the two methods disagree on
     * lines that MOVED — a patch marks a moved line as both added and removed, a content
     * comparison marks it as neither — and that disagreement runs in the fail-OPEN direction:
     * an understated `adds` makes `head.adds \ reviewed.adds` empty and the gate says COVERED
     * for a line nobody read.
     *
     * Every line a patch could mark as added is a line present in the head blob, so the whole
     * content is a guaranteed SUPERSET and can only ever make this refuse or demand another
     * read. It is never sharper than the truth in the direction that matters.
     *
     * It costs nothing in practice because both sides are measured the same way: for a file
     * unchanged between the reviewed sha and the head, the two whole-content sets are equal and
     * the difference is empty — which is the correct answer, reached without reading a patch
     * that does not exist.
     */
    /*
     * THE FALLBACK ENGAGES ONLY WHERE IT HAS SOMETHING TO FETCH WITH (DEV3, #1140). There is a
     * fourth file shape in neither caller's world — NO patch AND none of the REST fields — and a
     * branch keyed only on "patch is not a string" lands in it. The two wrong answers there are
     * a THROW, which turns an odd shape into a crash instead of a refusal, and an EMPTY SET,
     * which is worse: an empty contribution compares EQUAL to every other empty one, and false
     * identity is the family this gate exists to catch.
     *
     * The right answer is the one the file already gave. Refuse, with the reason it already has.
     *
     * This resolver needs only a filename and two refs — it builds the contents path itself
     * rather than following `contents_url`, so it never reads a REST-only field and cannot
     * demand one from a local-git file. The guard is still explicit, because "it happens not to
     * need it" is a property of today's implementation and this is a gate.
     */
    if (typeof f.filename !== "string" || !f.filename) return null;
    const wantsHead = f.status !== "removed";
    const wantsBase = f.status !== "added";
    const head = wantsHead ? ctx.readBlob(ctx.head, f.filename) : "";
    const base = wantsBase ? ctx.readBlob(ctx.base, f.filename) : "";
    if (head === null || base === null) return null;
    for (const line of head.split("\n")) adds.add(`${f.filename}\u0000${line}`);
    for (const line of base.split("\n")) rems.add(`${f.filename}\u0000${line}`);
  }
  return { adds, rems };
}

/**
 * The distinct commits a set of reports names, deduped by COMMIT rather than by string.
 *
 * EXPORTED BECAUSE THE ARM THAT COVERED THIS RE-IMPLEMENTED IT. The proof case compared two shas
 * with its own inline `startsWith` and called nothing from this module, so reverting the
 * production code to a plain string Set left the suite green. An arm that tests its own copy
 * asserts nothing about the code.
 */
export function endpointsOf(reports) {
  const out = [];
  for (const r of reports ?? [])
    if (r.sha && !out.some((e) => sameCommit(e, r.sha))) out.push(r.sha);
  return out;
}

/**
 * What a set of reports has covered BETWEEN them, or null if any could not be read.
 *
 * REPORTS COMPOSE; THE LAST ONE POSTED DOES NOT SUPERSEDE THE REST. #950 carried a full read of
 * `22460e29` and a delta `22460e29..71c12b05`, and the FULL read reached the pull request
 * seventeen minutes later, having been sent in a message first. Taking the last endpoint selected
 * the older sha and discarded the delta's coverage, reporting content added since a review that
 * had covered it. A union needs no ordering and no ancestry, so the order somebody pasted things
 * in cannot change the answer.
 */
export function unionContributions(contributions) {
  const union = { adds: new Set(), rems: new Set() };
  for (const c of contributions) {
    if (c === null) return null;
    for (const a of c.adds) union.adds.add(a);
    for (const r of c.rems) union.rems.add(r);
  }
  return union;
}

/**
 * Classify ONE pull request. Pure: every fact it needs is passed in, so the proof can drive every
 * state in `STATE` without a network. `atHead` and `atReviewed` are contribution sets, or null
 * when the comparison could not be made — null is a distinct answer and must not read as "equal".
 *
 * THIS SENTENCE USED TO CARRY A COUNT AND THE COUNT WAS ALREADY WRONG. It said "all seven states"
 * while `STATE` held eight, because `REMOVED_ONLY` arrived without it. A number in prose expires
 * the moment the thing it counts changes and nothing announces it, so it names the object now.
 */
export function classify({
  inSubject,
  reports,
  unreadable = null,
  uncompared = null,
  head = null,
  atHead,
  atReviewed,
  reviewedInBranch,
}) {
  if (!inSubject) return { state: STATE.UNARMED, detail: "" };
  /*
   * NULL IS NOT EMPTY, and the caller must not collapse them. `null` means the fetch did not
   * answer; `[]` means it answered and there was nothing there. Only the second is a finding.
   */
  if (reports === null)
    return {
      state: STATE.UNFETCHED,
      detail:
        "`gh pr view --json comments` did not answer, so its comments were never read — " +
        "a token may be sitting on it",
    };
  if (reports.length === 0) return { state: STATE.NO_REPORT, detail: "" };

  /*
   * THE THREE WAYS A REPORT IS PRESENT AND CANNOT BE COUNTED, KEPT APART FROM "ABSENT".
   *
   * NO_REPORT means nobody posted anything, and it is the sentence that sends somebody to read
   * the pull request. Every branch below means somebody DID post something, and sends them
   * somewhere else entirely: unbold a line, name a sha, or read it again because the last read
   * was retracted. Giving any of them NO_REPORT's sentence is the defect `unreadableReason`
   * records one screen up -- a true verdict carrying a cause that did not occur.
   *
   * WITHDRAWN COMES FIRST because a withdrawn token is well formed: it parses, it names a sha,
   * and every test below it would pass. Placing it after any of them would make it unreachable
   * for exactly the tokens it exists to catch.
   */
  const live = liveReports(reports);
  if (live.length === 0)
    return {
      state: STATE.WITHDRAWN,
      detail: `${reports.length} report(s) present, all marked WITHDRAWN in their own comment`,
    };

  const withSha = live.filter((r) => r.sha);
  if (withSha.length === 0) {
    const unparsed = live.find((r) => r.unparsed);
    if (unparsed)
      return {
        state: STATE.UNPARSED,
        detail:
          `a report is present that the token pattern does not match, so nothing was ` +
          `compared: ${JSON.stringify(
            unparsed.unparsed
          )} — the token must be the whole ` +
          `line, bare or wrapped in a symmetric **`,
      };
    return {
      state: STATE.NO_SHA,
      detail: "a report is present but names no sha, so nothing was compared",
    };
  }

  const dangling = unanchoredDeltas(live, head);
  if (dangling.length > 0)
    return {
      state: STATE.PARTIAL,
      detail:
        `a delta read of ${dangling[0].from}..${dangling[0].sha} is the only cover for its base, ` +
        `and no report names ${dangling[0].from}`,
    };

  /*
   * A REBASE IS NOT ITSELF THE FINDING, AND THE FIRST VERSION OF THIS SHORT-CIRCUITED ON IT.
   * Run against the live board, six pull requests came back as "force-pushed since" and nothing
   * else, which is the least useful true thing that could be said about them. All six turned out
   * to contribute content the reader had not seen -- same file COUNT, different blobs -- and the
   * message named none of it. A divergence is therefore an ANNOTATION on the content comparison
   * rather than a verdict replacing it. The force-pushed state that used to sit here is gone,
   * for the reason recorded below it.
   */
  /*
   * THERE IS NO SEPARATE FORCE-PUSHED STATE, AND MEASURING KILLED IT RATHER THAN AN OPINION.
   * It required the reviewed contribution to be unreadable AND the sha known to be out of the
   * branch, and those cannot both hold: `compare/main...<sha>` succeeds with `diverged` for a
   * force-pushed sha (measured on #950's own amended-away 22460e29) and 404s only for a sha this
   * repository does not have -- and such a sha 404s on `sha...head` too, so its branch membership
   * is equally unknowable. The conjunction was contradictory at one report, which is 11 of the 15
   * armed pull requests today. A state that cannot fire while its name says it can is the vacuity
   * this file exists to prevent, so it is gone rather than resurrected.
   *
   * WHAT IT CARRIED IS NOW CARRIED BETTER. A diverged-but-readable sha reaches the content
   * comparison, which is correct -- a rebase alone is not the finding -- and gets ", and the
   * branch was rebased since" on its detail. An unresolvable sha is named by the reason below,
   * which the old state did not do.
   */

  /*
   * THE REASON IS READ BEFORE THE GENERIC BRANCH, AND THE ORDER IS THE WHOLE FIX. Removing the
   * force-pushed state took this line with it, so `unreadable` was computed in main(), passed
   * in, and READ NOWHERE -- every cause fell through to the sentence below and printed one
   * generic line. That reintroduced the entire subject of the commit that had just removed it.
   *
   * IT MUST COME FIRST because `atReviewed === null` holds in every unreadable case, so placing
   * it after the generic branch would change nothing at all.
   */
  /*
   * AND A COMPARE THAT DID NOT ANSWER IS READ BEFORE EITHER (#1082). If an endpoint never
   * replied, nothing about coverage is known -- INCLUDING whether the answer would have been
   * readable -- so it cannot be outranked by a reason derived from the other endpoint.
   */
  if (uncompared) return { state: STATE.UNCOMPARED, detail: uncompared };

  if (unreadable) return { state: STATE.UNREADABLE, detail: unreadable };

  /*
   * THE LAST RESORT, AND ITS PROSE WAS ALWAYS REFUSAL-SHAPED SITTING UNDER A FINDING-SHAPED
   * STATE. "The comparison could not be made, so coverage is unknown" describes a question that
   * could not be asked, which is exit 2. With both assignments in `main()` now gated on the
   * fetch having answered, this is unreachable from either compare path and remains only as the
   * floor: a null contribution with no reason attached is an unknown, never a verdict.
   */
  if (atHead === null || atReviewed === null)
    return {
      state: STATE.UNCOMPARED,
      detail: "the comparison could not be made, so coverage is unknown",
    };

  const newAdds = [...atHead.adds].filter((l) => !atReviewed.adds.has(l));
  const newRems = [...atHead.rems].filter((l) => !atReviewed.rems.has(l));
  const rebased =
    reviewedInBranch === false ? ", and the branch was rebased since" : "";
  const paths = (ls) => [...new Set(ls.map((l) => l.split("\u0000")[0]))];

  /*
   * FAILURE IS DECIDED BY ADDITIONS, AND REMOVALS ARE REPORTED RATHER THAN DROPPED.
   *
   * An additions-only rule alone would be wrong in the way this file keeps warning about: a
   * removal since the review is content the reader did not see, and a deleted guard would vanish
   * silently. But a removal is not new material to READ, and on the live board every removal-only
   * difference was one orphan pruned by a rebase's fresh resolution — mechanical, identical
   * across three pull requests, and present on every promotion.
   *
   * So the two are separated rather than collapsed, which is the same rule applied to NO_SHA
   * versus UNREADABLE above: a state that cannot be told apart from another must not be given
   * the other's verdict. REMOVED_ONLY does not fail, and the runner prints it.
   */
  if (newAdds.length > 0)
    return {
      state: STATE.UNCOVERED,
      detail: `${
        paths(newAdds).length
      } file(s) the review did not cover${rebased}: ${paths(newAdds)
        .slice(0, 5)
        .join(", ")}`,
    };
  if (newRems.length > 0)
    return {
      state: STATE.REMOVED_ONLY,
      detail: `${
        newRems.length
      } line(s) removed since the review${rebased}, none added: ${paths(newRems)
        .slice(0, 5)
        .join(", ")}`,
    };
  return { state: STATE.OK, detail: "" };
}

/**
 * The line printed when nothing failed — separate, exported and driven, because ZERO ARMED IS THE
 * ORDINARY CASE and its sentence used to assert what it had not measured.
 *
 * At zero it read `OK: 0 armed pull requests examined, EACH COVERED by a reader report ...`, which
 * is vacuously true over an empty set and reads in CI as coverage confirmed. The vacuity guard for
 * this check is real and lives one level OUT — `checks.json` floors the count of OPEN pull
 * requests at 1, deliberately not the armed count, because a board with nothing armed overnight is
 * legitimate and a floor there would be the scheduled failure #768 records. So the SUBJECT was
 * protected and the SENTENCE was not, and those are two different claims.
 */
/**
 * EVERY CHECK HAS CONCLUDED AND CONCLUDED WELL. An absent rollup and an EMPTY one are both "no",
 * and the empty case is the one that bites: `[].every(...)` is TRUE, so the obvious spelling calls
 * a pull request with no checks at all fully green and admits it to the subject. That is the
 * vacuous green this file exists to refuse, one function up from where it usually appears.
 */
export function allChecksGreen(pr) {
  const rollup = pr?.statusCheckRollup;
  if (!Array.isArray(rollup) || rollup.length === 0) return false;
  return rollup.every((c) =>
    ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c?.conclusion ?? c?.state)
  );
}

/**
 * THE SUBJECT: A PULL REQUEST THAT COULD BE MERGED WITH NO FURTHER WORK ON IT (#1053).
 *
 * WHY NOT `CLEAN`, WHICH IS THE OBVIOUS REPLACEMENT AND REBUILDS THE BUG ONE PREDICATE OVER.
 * Measured live at main 0eb40cb7:
 *
 *     BEHIND 10   DIRTY 3   BLOCKED 1   CLEAN 0
 *     fully green 6, and ALL SIX are BEHIND
 *
 * Under `strict: true` with one merge per cycle, BEHIND is the STEADY STATE — a branch is behind
 * from the moment anything else lands. A subject keyed on CLEAN would be empty today for exactly
 * the reason `armed` is, and would go green saying so. BEHIND must be IN.
 *
 * WHY DIRTY AND BLOCKED ARE OUT, and this is what keeps the check readable rather than a line
 * nobody reads — the failure this file's own header identifies. Both need work ON THE PULL
 * REQUEST, and that work CHANGES THE HEAD, so any reading of today's head is superseded before it
 * can matter. Being behind is the only thing a candidate may be waiting on, because a promotion
 * does not change what the branch contributes.
 *
 * AND A DRAFT IS NOT A CANDIDATE. #1028 is green and BEHIND and cannot be merged; admitting it
 * made the live subject 6 where 5 is right.
 *
 * ARMED STAYS IN THE UNION rather than being replaced. An armed pull request merges itself the
 * moment its last check goes green — the original #945 hazard — and the candidate test does not
 * cover it, because an armed row can be DIRTY today and land later.
 */
export function isMergeCandidate(pr) {
  if (pr?.autoMergeRequest) return true;
  if (pr?.isDraft) return false;
  if (!["CLEAN", "BEHIND"].includes(pr?.mergeStateStatus)) return false;
  return allChecksGreen(pr);
}

/**
 * THE PULL REQUEST THIS RUN IS GATING, NAMED BY THE EVENT PAYLOAD (#1074).
 *
 * A PULL REQUEST IS NEVER IN ITS OWN GATE'S SUBJECT DURING ITS OWN CI RUN, and that is a
 * property of the construction rather than a bug in the predicate. `isMergeCandidate` is defined
 * over CHECK STATE and evaluated BY a check, so the thing being gated cannot be in it: at the
 * moment this executes, at least one check has not concluded — the one executing — and
 * `allChecksGreen` is false for that reason alone. Every verdict this check has ever published
 * about X came from a run in which X was invisible.
 *
 * The board is still covered IN AGGREGATE, which is what made this survive: every OTHER candidate
 * is examined on every run, so an uncovered X is caught by the next pull request's run while X is
 * still green. X escapes only if it merges before any other run happens — AND THAT WINDOW WIDENS
 * AS THE BOARD GOES QUIET, which is the opposite of the usual shape. A quiet board is exactly when
 * an unexamined pull request has time to merge and when somebody is most likely to merge it
 * without waiting for another cycle.
 *
 * SO THE SUBJECT IS TOLD WHICH PULL REQUEST IT IS RUNNING ON, rather than being asked to infer it
 * from state its own execution is determining. `pull_request.number` in the event payload is the
 * one fact about this run that no check state can contradict.
 *
 * WHY NOT DROP THE IN-FLIGHT RUN FROM THE ROLLUP, which is the other repair the issue offers.
 * MEASURED on #1080 while its CI job was IN_PROGRESS: the rollup holds 35 entries from SIX
 * workflows and CI contributes 2, so dropping them leaves 33 — of which 12 were still pending,
 * because E2E and Severability are the long poles and are still running when `pnpm checks`
 * executes. `allChecksGreen` is false after the drop for that reason.
 *
 * And it would not be sound even when it worked: whether it works depends on whether the other
 * five workflows happened to conclude first, so THE SUBJECT WOULD BE A FUNCTION OF RELATIVE JOB
 * DURATIONS. The same pull request is examined or not depending on runner speed and queue depth,
 * and it looks like it is working every time it wins the race. A gate whose subject is decided by
 * a race is worse than one with a documented hole, because the hole announces itself.
 *
 * FAILS TO A REFUSAL, NEVER TO A SILENT PASS. Inside a `pull_request` event the payload is the
 * only thing that names the subject, so if it cannot be read this check cannot say what it
 * examined — exit 2, which is a different answer from every candidate being covered. Outside one
 * (a `push` build, a local run) there is no pull request under test and `null` is the truth.
 */
export function prUnderTest(env = process.env, read = readFileSync) {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "pull_request_target")
    return { number: null, reason: null };
  const path = env.GITHUB_EVENT_PATH;
  if (!path)
    return {
      number: null,
      reason:
        "GITHUB_EVENT_NAME is `" +
        event +
        "` but GITHUB_EVENT_PATH is unset, so the pull request under test cannot be named",
    };
  let payload;
  try {
    payload = JSON.parse(read(path, "utf8"));
  } catch (e) {
    return {
      number: null,
      reason: `the event payload at ${path} could not be read or parsed (${e.message})`,
    };
  }
  const n = payload?.pull_request?.number;
  if (!Number.isInteger(n))
    return {
      number: null,
      reason: `the event payload at ${path} carries no integer \`pull_request.number\``,
    };
  return { number: n, reason: null };
}

/**
 * WHETHER THE PULL REQUEST UNDER TEST BELONGS IN THE SUBJECT — the exclusions that are still TRUE
 * while its own run is in flight, and only those.
 *
 * NOT `isMergeCandidate`, which is the whole point: both of its check-derived filters are
 * determined by the run doing the asking. `mergeStateStatus` reads BLOCKED for a pull request that
 * is up to date with pending checks and BEHIND for one that is not, because behind-ness takes
 * precedence over check state — so a mid-run pull request presents as either depending only on
 * whether main moved under it, and a repair aimed at that field alone would appear to work on
 * exactly the days it did nothing.
 *
 * WHAT SURVIVES THE RUN. A DRAFT is not a candidate and its own CI says nothing about that: it is
 * a declaration by the author that this is not for merging, and it is how work in progress is
 * raised here. Admitting drafts would red-light every one on its first push, which converts the
 * team's own push-and-raise practice into a permanent failure. DIRTY survives too — conflicts are
 * not a function of check state, they need work ON the pull request, and that work changes the
 * head, so any reading of today's head is superseded before it can matter.
 *
 * EVERYTHING ELSE IS ADMITTED, INCLUDING A PULL REQUEST WHOSE OTHER CHECKS ARE RED. The two cases
 * cannot be told apart from inside the run, and the asymmetry decides it: admitting one that turns
 * out not to be mergeable costs a comment, while excluding one that is costs an unexamined merge.
 */
export function admitsUnderTest(pr) {
  if (!pr) return false;
  if (pr.isDraft) return false;
  return pr.mergeStateStatus !== "DIRTY";
}

export function passLine(subjectCount, openCount, underTest = null) {
  /*
   * THE SENTENCE NAMES THE PULL REQUEST UNDER TEST, because the whole of #1074 is that a reader
   * could not tell whether this run had examined the thing it was gating. A line saying "N
   * candidates examined" is true either way, and was true on every run that examined none of them.
   */
  const self =
    underTest === null
      ? ``
      : `, INCLUDING #${underTest}, the pull request this run is gating`;
  if (subjectCount === 0)
    return (
      `no open pull request is a merge candidate and none is under test, so NOTHING was ` +
      `examined and this check asserts nothing about coverage — the subject floor is on the ` +
      `${openCount} open pull request(s), not on the candidate count`
    );
  return (
    `${subjectCount} merge candidate${
      subjectCount === 1 ? "" : "s"
    } examined${self}, each covered ` +
    `by a reader report naming a sha that adds nothing the reader did not see`
  );
}

/** `gh` as data, or null when the call failed — the caller must not read a failure as an empty set. */
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

/**
 * One file's bytes at one commit, or null when the question could not be asked.
 *
 * `contents` rather than the blobs API because the compare entry names a PATH, not a base-side
 * blob sha — the head-side `sha` it does carry is useless for reading the OTHER side. A ref plus
 * a path answers for both sides with the same call shape.
 *
 * RETURNS null RATHER THAN "" ON FAILURE, and the difference is the whole point: an empty string
 * is a file with no lines, which would silently become an empty contribution and a green. A
 * refusal has to stay distinguishable from an answer of nothing.
 */
function readBlob(ref, path) {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/contents/${encodeURIComponent(path).replace(
      /%2F/g,
      "/"
    )}?ref=${ref}`,
  ]);
  if (!r || typeof r.content !== "string" || r.encoding !== "base64")
    return null;
  try {
    return Buffer.from(r.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The context a withheld patch needs, built from the compare that reported it.
 *
 * THE BASE IS `merge_base_commit`, NOT main. This is a THREE-DOT comparison, so its base side is
 * the merge base — reading main's blob instead would compare against a tree the pull request was
 * never diffed against, and every commit landing on main would silently change the answer.
 */
function blobContext(compare, headSha) {
  const base = compare?.merge_base_commit?.sha;
  return base ? { base, head: headSha, readBlob } : null;
}

function main() {
  const open = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefOid,autoMergeRequest,changedFiles,baseRefName,isDraft,mergeStateStatus,statusCheckRollup",
  ]);
  if (open === null) {
    process.stderr.write(
      "\nCOULD NOT CHECK: `gh pr list` did not answer, so no pull request was examined.\n" +
        "      Exit 2, not 0 — this check made no comparison, which is a different answer\n" +
        "      from every merge candidate being covered.\n\n"
    );
    process.exit(2);
  }

  /*
   * THE SUBJECT IS OPEN PULL REQUESTS, NOT ARMED ONES, AND THE DIFFERENCE IS THE FLOOR.
   * A count of ARMED prs is legitimately zero — nothing is armed at 3am — so a floor on it would
   * be a scheduled failure of exactly the shape #768 records. What the floor has to catch is the
   * query answering with NOTHING, and the open count does that: this repo does not reach zero
   * open pull requests, so a zero there is the API, not the board.
   */
  reportSubject(open.length, "open pull request(s)");

  /*
   * THE PULL REQUEST UNDER TEST JOINS THE SUBJECT, BYPASSING BOTH FILTERS (#1074).
   *
   * It has to bypass BOTH, because they fire independently and a fix to either alone changes
   * nothing while looking like it worked. `allChecksGreen` is false for every mid-run pull
   * request — one check has not concluded, and it is this one. `mergeStateStatus` is BLOCKED
   * when the branch is up to date and BEHIND when it is not, so it excludes some mid-run pull
   * requests and not others, on a criterion that has nothing to do with review.
   */
  const under = prUnderTest();
  if (under.reason) {
    process.stderr.write(
      `\nCOULD NOT CHECK: ${under.reason}.\n` +
        `      This run is gating a pull request it cannot name, so it cannot state whether\n` +
        `      that pull request was examined. Exit 2, not 0 — "the subject is unknown" is a\n` +
        `      different answer from "every merge candidate is covered".\n\n`
    );
    process.exit(2);
  }
  if (under.number !== null && !open.some((p) => p.number === under.number)) {
    process.stderr.write(
      `\nCOULD NOT CHECK: the event names #${under.number} as the pull request under test, ` +
        `and it is not in\n      the open board this check just read. Either it closed while ` +
        `this run was in flight, or\n      \`gh pr list\` truncated below it. Both make the ` +
        `subject a SUBSET reported as the whole.\n      Exit 2, not 0.\n\n`
    );
    process.exit(2);
  }
  const underTestAdmitted =
    under.number !== null &&
    admitsUnderTest(open.find((p) => p.number === under.number));

  const armed = open.filter(
    (p) =>
      isMergeCandidate(p) || (underTestAdmitted && p.number === under.number)
  );
  const rows = [];
  for (const p of armed) {
    const detail = gh(["pr", "view", String(p.number), "--json", "comments"]);
    const reports = detail === null ? null : reportsFrom(detail.comments);
    const head = p.headRefOid;
    let atHead = null;
    let atReviewed = null;
    let unreadable = null;
    let uncompared = null;
    let reviewedInBranch = null;
    /*
     * EVERY ENDPOINT, UNIONED -- NOT THE LAST ONE POSTED. This took the last report carrying a sha,
     * on the assumption that a later report supersedes an earlier one. The live board refuted it on
     * #950: DEV1 read `22460e29` in full and then the delta `22460e29..71c12b05`, but the full read
     * reached the pull request SEVENTEEN MINUTES LATER than the delta, because it had been sent in a
     * message and posted to the artifact afterwards. Last-posted therefore selected the OLDER sha and
     * threw away the delta's coverage, and the check reported content added since a review that had
     * in fact covered it.
     *
     * REPORTS COMPOSE, so what a reader has seen is the UNION of what each report covered. That is
     * both simpler and sounder than ordering them: it needs no ancestry, and it cannot be defeated by
     * the order somebody happened to paste things in.
     */
    const endpoints = endpointsOf(liveReports(reports));
    if (endpoints.length) {
      /*
       * THE TWO ENDPOINTS WERE ASYMMETRIC AND IT WAS TWELVE LINES (#1082). THIS one was already
       * gated on `hc !== null`, so a failed fetch left `unreadable` null and fell through to the
       * generic branch. The reviewed endpoint below was NOT, so a failed fetch there fell past a
       * false middle term into a sentence asserting the repository could not resolve the sha.
       */
      const hc = gh(["api", `repos/{owner}/{repo}/compare/main...${head}`]);
      atHead = hc
        ? contribution(hc.files, expectedFileCount(p), blobContext(hc, head))
        : null;
      if (hc === null)
        uncompared = `the compare of main against this pull request's head ${head.slice(
          0,
          12
        )} did not answer, so nothing is known about what it contributes`;
      else if (atHead === null)
        /*
         * ONLY WHEN THE CONTRIBUTION ACTUALLY FAILED. This used to be set whenever
         * `unreadableReason` had anything to say, which was the same thing before a withheld
         * patch had a route. It is not the same thing now: a file with no patch is a reason
         * `unreadableReason` still reports and the fallback may nonetheless have read, so
         * asking it unconditionally would announce a refusal that did not happen.
         */
        unreadable =
          unreadableReason(hc.files, expectedFileCount(p)) ||
          `a file whose patch GitHub withheld could not be read from its blobs either`;

      const parts = [];
      let ok = true;
      for (const sha of endpoints) {
        const rc = gh(["api", `repos/{owner}/{repo}/compare/main...${sha}`]);
        const c = rc
          ? contribution(rc.files, null, blobContext(rc, sha))
          : null;
        if (c === null) {
          ok = false;
          /*
           * THE SENTENCE THIS REPLACES WAS NEVER TRUE. `contribution` returns null only where
           * `unreadableReason` returns a reason -- its other `return null` is documented
           * unreachable -- so with `rc !== null` the middle term is always TRUTHY and the
           * fallback string was reachable ONLY on a failed fetch. It asserted that the
           * repository cannot resolve a sha, when what happened is that the request did not
           * answer, and it sent readers to check a sha that was fine.
           *
           * AND NO VERSION OF IT COULD BE JUSTIFIED, because `gh()` collapses every non-zero
           * exit to null: a 404 on a genuinely absent sha and a throttled request arrive here
           * identically. The honest statement names both and claims neither.
           */
          if (rc === null)
            uncompared =
              `the compare of main against ${sha.slice(
                0,
                12
              )}, named by a reader ` +
              `report, did not answer -- the sha may not exist in this repository, or the ` +
              `request was refused; these are indistinguishable from here`;
          else
            unreadable =
              unreadable ||
              unreadableReason(rc.files) ||
              `a file whose patch GitHub withheld could not be read from its blobs either`;
          break;
        }
        parts.push(c);
        const link = gh([
          "api",
          `repos/{owner}/{repo}/compare/${sha}...${head}`,
        ]);
        // in-branch if ANY endpoint still is: one superseded read does not undo a live one
        if (link && link.status !== "diverged") reviewedInBranch = true;
        else if (reviewedInBranch === null && link) reviewedInBranch = false;
      }
      atReviewed = ok ? unionContributions(parts) : null;
    }
    rows.push({
      number: p.number,
      ...classify({
        inSubject: true,
        // NOT `reports ?? []` — null means the fetch FAILED and must not read as "no comments"
        reports,
        unreadable,
        uncompared,
        head,
        atHead,
        atReviewed,
        reviewedInBranch,
      }),
    });
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
  const refused = rows.filter((r) => REFUSALS.has(r.state));
  const removals = rows.filter((r) => r.state === STATE.REMOVED_ONLY);
  const plural = armed.length === 1 ? "" : "s";
  /*
   * A REMOVAL-ONLY DIFFERENCE IS PRINTED ON BOTH PATHS, because it is the one thing here that is
   * reported without failing, and a state nobody is shown is a state nobody can act on.
   */
  const removalNote = removals.length
    ? `\n      ${removals.length} of them contribute REMOVALS since their review and nothing ` +
      `added, which does not fail:\n` +
      removals.map((r) => `        #${r.number}  ${r.detail}`).join("\n") +
      `\n`
    : "";

  /*
   * A REFUSAL OUTRANKS A FINDING, AND THE FINDINGS ARE STILL PRINTED RATHER THAN DROPPED.
   * Exit 1 asserts that the armed set WAS examined and that this many of it failed. If even one
   * row could not be fetched, that claim is false about the SUBJECT rather than about the
   * verdict — which is the distinction the rest of this file is built on.
   */
  if (refused.length) {
    process.stderr.write(
      `\nCOULD NOT CHECK: ${refused.length} of ${armed.length} merge candidate${plural} ` +
        `could not be examined at all:\n` +
        refused.map((r) => `  #${r.number}  ${r.detail}`).join("\n") +
        (bad.length
          ? `\n\n      and ${bad.length} that WILL merge on green without a covering ` +
            `review:\n` +
            bad
              .map(
                (r) =>
                  `  #${r.number}  ${r.state}${
                    r.detail ? ` — ${r.detail}` : ""
                  }`
              )
              .join("\n")
          : "") +
        removalNote +
        `\n      Exit 2, not 1 — part of the subject was never looked at, so neither ` +
        `"covered"\n      nor a count of failures is a true statement about it.\n\n`
    );
    process.exit(2);
  }

  if (bad.length === 0) {
    process.stdout.write(
      `\nOK: ${passLine(
        armed.length,
        open.length,
        underTestAdmitted ? under.number : null
      )}.\n${removalNote}\n`
    );
    process.exit(0);
  }
  process.stderr.write(
    `\nFAIL: ${bad.length} of ${armed.length} merge candidate${plural} could merge ` +
      `without a review that covers what merges:\n` +
      bad
        .map(
          (r) => `  #${r.number}  ${r.state}${r.detail ? ` — ${r.detail}` : ""}`
        )
        .join("\n") +
      removalNote +
      `\n      A reader clears one by posting  READER-REPORT: <agent> @ <sha>  naming the ` +
      `sha they read.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
