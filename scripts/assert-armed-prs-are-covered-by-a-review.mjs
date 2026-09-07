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

/**
 * `READER-REPORT: DEV1 @ 00d5f110` for a full read, `... @ 959ea154..47063cf2 (delta only)` for a
 * delta. The agent names itself because the git identity cannot: every agent authenticates under
 * one login. THE RANGE FORM IS NOT A CONVENIENCE — forcing a single sha would make a delta reader
 * overclaim, reading as "DEV1 read 47063cf2" when what they read was the difference, and `..` is
 * the discriminator. Trailing prose after the range is allowed and ignored.
 */
export const TOKEN =
  /^READER-REPORT:\s*(\S+)\s*@\s*([0-9a-f]{7,40})(?:\.\.([0-9a-f]{7,40}))?\s*(?:\(.*\))?\s*$/mu;

/**
 * A report with the token but no usable sha still counts as a REPORT, so that a malformed one is
 * reported as unverifiable rather than as absent. The two are different findings and conflating
 * them is a defect this check was written after committing: a prototype labelled a report that
 * named no sha as "stale", which reports the unverifiable as verified.
 */
export const TOKEN_LOOSE = /^READER-REPORT:/mu;

export const STATE = {
  UNARMED: "unarmed",
  OK: "covered",
  NO_REPORT: "ARMED, NO READER REPORT",
  NO_SHA: "ARMED, REPORT NAMES NO SHA - COULD NOT CHECK",
  SUPERSEDED: "ARMED, REVIEWED SHA IS NOT IN THE BRANCH - FORCE-PUSHED SINCE",
  UNCOVERED: "ARMED, CONTENT ADDED SINCE THE REVIEW",
  UNREADABLE: "ARMED, COULD NOT COMPARE - COULD NOT CHECK",
  PARTIAL: "ARMED, ONLY A DELTA WAS READ AND NOBODY READ ITS BASE",
  REMOVED_ONLY: "armed, and only REMOVALS have appeared since the review",
};

/** The states that fail the check. `UNARMED` and `OK` do not. */
export const FINDINGS = new Set([
  STATE.NO_REPORT,
  STATE.NO_SHA,
  STATE.SUPERSEDED,
  STATE.UNCOVERED,
  STATE.UNREADABLE,
  STATE.PARTIAL,
]);

/** Every reader report on a PR, as {agent, sha}; sha null when the token carried none. */
export function reportsFrom(comments) {
  const out = [];
  for (const c of comments ?? []) {
    const body = c?.body ?? "";
    const m = TOKEN.exec(body);
    if (m)
      out.push({ agent: m[1], from: m[3] ? m[2] : null, sha: m[3] ?? m[2] });
    else if (TOKEN_LOOSE.test(body))
      out.push({ agent: null, from: null, sha: null });
  }
  return out;
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
   * THE ASYMMETRY IS REAL AND WORTH STATING. Only the HEAD comparison has such a total; the
   * reviewed sha is not a pull request and has none, so it falls back to the cap itself. That
   * fallback constant is not derived, and it is allowed here for the reason an underived
   * threshold is ever allowed: it can only make this REFUSE, never make it pass.
   */
  if (expected !== null) {
    if ((files?.length ?? 0) !== expected) return null;
  } else if ((files?.length ?? 0) >= 300) return null;
  const adds = new Set();
  const rems = new Set();
  for (const f of files ?? []) {
    if (f.status === "unchanged") continue;
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
 * Classify ONE pull request. Pure: every fact it needs is passed in, so the proof can drive all
 * seven states without a network. `atHead` and `atReviewed` are contribution sets, or null when
 * the comparison could not be made — null is a distinct answer and must not read as "equal".
 */
export function classify({
  armed,
  reports,
  atHead,
  atReviewed,
  reviewedInBranch,
}) {
  if (!armed) return { state: STATE.UNARMED, detail: "" };
  if (!reports || reports.length === 0)
    return { state: STATE.NO_REPORT, detail: "" };

  const withSha = reports.filter((r) => r.sha);
  if (withSha.length === 0)
    return {
      state: STATE.NO_SHA,
      detail: "a report is present but names no sha, so nothing was compared",
    };

  const dangling = unanchoredDeltas(reports);
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
   * rather than a verdict replacing it, and SUPERSEDED is kept only for the case where the
   * divergence actually costs the answer: the reviewed sha is gone AND what it contributed can no
   * longer be read.
   */
  if (reviewedInBranch === false && atReviewed === null)
    return {
      state: STATE.SUPERSEDED,
      detail: `reviewed ${withSha
        .map((r) => r.sha)
        .join(
          ", "
        )}, which is no longer in the branch and whose contribution can no longer be read`,
    };

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
    "number,headRefOid,autoMergeRequest,changedFiles",
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
    let reviewedInBranch = null;
    // the LATEST endpoint, not the first: a delta report supersedes the read before it
    const sha = reports?.filter((r) => r.sha).at(-1)?.sha;
    if (sha) {
      const hc = gh(["api", `repos/{owner}/{repo}/compare/main...${head}`]);
      const rc = gh(["api", `repos/{owner}/{repo}/compare/main...${sha}`]);
      const link = gh(["api", `repos/{owner}/{repo}/compare/${sha}...${head}`]);
      atHead = hc ? contribution(hc.files, p.changedFiles ?? null) : null;
      atReviewed = rc ? contribution(rc.files) : null;
      reviewedInBranch = link ? link.status !== "diverged" : null;
    }
    rows.push({
      number: p.number,
      ...classify({
        armed: true,
        reports: reports ?? [],
        atHead,
        atReviewed,
        reviewedInBranch,
      }),
    });
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
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
