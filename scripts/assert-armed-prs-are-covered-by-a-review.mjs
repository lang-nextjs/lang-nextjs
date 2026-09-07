#!/usr/bin/env node
/**
 * AN ARMED PR IS COVERED BY ITS REVIEW.
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
 * Exit 0 every armed PR is covered · Exit 1 at least one is not · Exit 2 the question could not
 * be asked at all, which is NOT the same answer as "all covered".
 */

import { spawnSync } from "node:child_process";

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
  UNARMED: "unarmed",
  OK: "covered",
  NO_REPORT: "ARMED, NO READER REPORT",
  NO_SHA: "ARMED, REPORT NAMES NO SHA - COULD NOT CHECK",
  UNCOVERED: "ARMED, CONTENT ADDED SINCE THE REVIEW",
  UNREADABLE: "ARMED, COULD NOT COMPARE - COULD NOT CHECK",
  PARTIAL: "ARMED, ONLY A DELTA WAS READ AND NOBODY READ ITS BASE",
  REMOVED_ONLY: "armed, and only REMOVALS have appeared since the review",
  UNFETCHED: "ARMED, ITS COMMENTS COULD NOT BE FETCHED - COULD NOT CHECK",
  UNPARSED:
    "ARMED, A REPORT IS PRESENT THAT THE TOKEN DOES NOT MATCH - COULD NOT CHECK",
  WITHDRAWN: "ARMED, EVERY READER REPORT ON IT HAS BEEN WITHDRAWN",
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
export const REFUSALS = new Set([STATE.UNFETCHED]);

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
export function unanchoredDeltas(reports) {
  const ends = (reports ?? []).filter((r) => r.sha).map((r) => r.sha);
  return (reports ?? []).filter(
    (r) =>
      r.from &&
      !ends.some((e) => !sameCommit(e, r.sha) && sameCommit(e, r.from))
  );
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
export function unreadableReason(files, expected = null) {
  const n = files?.length ?? 0;
  if (n >= COMPARE_FILE_CAP)
    return `the compare listed ${n} files, at GitHub's cap of ${COMPARE_FILE_CAP}, so the list may be truncated`;
  if (expected !== null && n !== expected)
    return `the compare listed ${n} files but the pull request reports ${expected} changed, so one of the two readings is incomplete`;
  for (const f of files ?? []) {
    if (f.status === "unchanged") continue;
    if (typeof f.patch !== "string")
      return `${f.filename} carries no patch — binary or too large — so what it contributes cannot be read`;
  }
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
export function contribution(files, expected = null) {
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
  if (unreadableReason(files, expected)) return null;
  const adds = new Set();
  const rems = new Set();
  for (const f of files ?? []) {
    if (f.status === "unchanged") continue;
    // unreachable: unreadableReason above rejects an absent patch first
    if (typeof f.patch !== "string") return null;
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) adds.add(`${f.filename}\u0000${line.slice(1)}`);
      else if (line.startsWith("-"))
        rems.add(`${f.filename}\u0000${line.slice(1)}`);
    }
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
  armed,
  reports,
  unreadable = null,
  atHead,
  atReviewed,
  reviewedInBranch,
}) {
  if (!armed) return { state: STATE.UNARMED, detail: "" };
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

  const dangling = unanchoredDeltas(live);
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
  if (unreadable) return { state: STATE.UNREADABLE, detail: unreadable };

  if (atHead === null || atReviewed === null)
    return {
      state: STATE.UNREADABLE,
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

function main() {
  const open = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefOid,autoMergeRequest,changedFiles,baseRefName",
  ]);
  if (open === null) {
    process.stderr.write(
      "\nCOULD NOT CHECK: `gh pr list` did not answer, so no pull request was examined.\n" +
        "      Exit 2, not 0 — this check made no comparison, which is a different answer\n" +
        "      from every armed pull request being covered.\n\n"
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

  const armed = open.filter((p) => p.autoMergeRequest);
  const rows = [];
  for (const p of armed) {
    const detail = gh(["pr", "view", String(p.number), "--json", "comments"]);
    const reports = detail === null ? null : reportsFrom(detail.comments);
    const head = p.headRefOid;
    let atHead = null;
    let atReviewed = null;
    let unreadable = null;
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
      const hc = gh(["api", `repos/{owner}/{repo}/compare/main...${head}`]);
      atHead = hc ? contribution(hc.files, expectedFileCount(p)) : null;
      unreadable =
        (hc !== null && unreadableReason(hc.files, expectedFileCount(p))) ||
        null;

      const parts = [];
      let ok = true;
      for (const sha of endpoints) {
        const rc = gh(["api", `repos/{owner}/{repo}/compare/main...${sha}`]);
        const c = rc ? contribution(rc.files) : null;
        if (c === null) {
          ok = false;
          unreadable =
            unreadable ||
            (rc !== null && unreadableReason(rc.files)) ||
            `the review names ${sha}, which this repository cannot resolve` ||
            null;
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
        armed: true,
        // NOT `reports ?? []` — null means the fetch FAILED and must not read as "no comments"
        reports,
        unreadable,
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
      `\nCOULD NOT CHECK: ${refused.length} of ${armed.length} armed pull request${plural} ` +
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
        `\n      Exit 2, not 1 — part of the armed set was never looked at, so neither ` +
        `"covered"\n      nor a count of failures is a true statement about it.\n\n`
    );
    process.exit(2);
  }

  if (bad.length === 0) {
    process.stdout.write(
      `\nOK: ${armed.length} armed pull request${plural} examined, each covered by a reader ` +
        `report naming a sha that adds nothing the reader did not see.\n${removalNote}\n`
    );
    process.exit(0);
  }
  process.stderr.write(
    `\nFAIL: ${bad.length} of ${armed.length} armed pull request${plural} will merge on green ` +
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
