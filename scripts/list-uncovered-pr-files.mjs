#!/usr/bin/env node
/**
 * BEFORE YOU MERGE, WHAT WILL THE COVERAGE GATE SAY?
 *
 * The `armed-pr-review-coverage` check refuses a merge candidate whose
 * `READER-REPORT:` tokens do not cover everything the pull request
 * contributes. The check itself reports only the FAIL/OK verdict and the
 * first five files; this CLI runs the same logic ahead of time and prints
 * the FULL set of files a review would need to cover.
 *
 * Reuses `classify` and the contribution helpers from
 * `assert-armed-prs-are-covered-by-a-review.mjs` so the verdict here
 * matches what the gate will say. The only added computation is the
 * complete path list for an UNCOVERED state — `classify`'s detail
 * truncates at five paths by design.
 *
 * EXIT CODES (deliberately aligned with the gate)
 *   0  the pull request is covered by its reader reports
 *   1  one or more findings: NO_REPORT / UNCOVERED / WITHDRAWN / ...
 *   2  could not ask the question (a `gh` call failed)
 *
 * USAGE
 *   node scripts/list-uncovered-pr-files.mjs <PR_NUMBER>
 *
 * The PR_NUMBER is read from the first positional argument, or
 * `PR_NUMBER` in the environment. The script does not read any other
 * state — `gh` provides the rest.
 */

import { invokedAsProgram } from "./lib/is-main.mjs";
/** The NUL delimiter the gate's contribution() writes - built rather than typed, because a literal one travels badly. */
const NUL = String.fromCharCode(0);

import {
  STATE,
  FINDINGS,
  REFUSALS,
  reportsFrom,
  liveReports,
  endpointsOf,
  unionContributions,
  contribution,
  expectedFileCount,
  unreadableReason,
  classify,
  gh,
  blobContext,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";

export function prNumberFrom(args, env) {
  const fromArg = args.find((a) => /^\d+$/.test(a));
  if (fromArg) return Number(fromArg);
  const fromEnv = env.PR_NUMBER;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  return null;
}

/**
 * The exact same per-pull-request loop the gate runs, lifted out so a
 * caller can target ONE pull request without booting the whole board.
 *
 * The four inputs the gate computes inside its loop (atHead, atReviewed,
 * unreadable, uncompared) are computed here in the same order against the
 * same gh calls, and the same `classify` is asked to render a verdict. A
 * difference here from the gate's behaviour is the change.
 */
export function verdictFor(number) {
  const detail = gh(["pr", "view", String(number), "--json", "comments"]);
  if (detail === null)
    return {
      state: STATE.UNFETCHED,
      detail: "gh pr view did not answer",
      reports: null,
      atHead: null,
      atReviewed: null,
    };

  const reports = reportsFrom(detail.comments);
  const headView = gh([
    "pr",
    "view",
    String(number),
    "--json",
    "headRefOid,changedFiles,baseRefName,isDraft,mergeStateStatus",
  ]);
  if (headView === null)
    return {
      state: STATE.UNFETCHED,
      detail: "gh pr view did not answer for head",
      reports,
      atHead: null,
      atReviewed: null,
    };

  const head = headView.headRefOid;
  const pr = {
    number,
    headRefOid: head,
    changedFiles: headView.changedFiles,
    baseRefName: headView.baseRefName,
    isDraft: headView.isDraft,
    mergeStateStatus: headView.mergeStateStatus,
  };

  let atHead = null;
  let atReviewed = null;
  let unreadable = null;
  let uncompared = null;
  let reviewedInBranch = null;

  const endpoints = endpointsOf(liveReports(reports));
  if (endpoints.length) {
    const hc = gh(["api", `repos/{owner}/{repo}/compare/main...${head}`]);
    atHead = hc
      ? contribution(hc.files, expectedFileCount(pr), blobContext(hc, head))
      : null;
    if (hc === null)
      uncompared = `the compare of main against this pull request's head ${head.slice(
        0,
        12
      )} did not answer`;
    else if (atHead === null)
      unreadable =
        unreadableReason(hc.files, expectedFileCount(pr)) ||
        `a file whose patch GitHub withheld could not be read from its blobs either`;

    const parts = [];
    let ok = true;
    for (const sha of endpoints) {
      const rc = gh(["api", `repos/{owner}/{repo}/compare/main...${sha}`]);
      const c = rc ? contribution(rc.files, null, blobContext(rc, sha)) : null;
      if (c === null) {
        ok = false;
        if (rc === null)
          uncompared =
            `the compare of main against ${sha.slice(
              0,
              12
            )}, named by a reader ` + `report, did not answer`;
        else
          unreadable =
            unreadable ||
            unreadableReason(rc.files) ||
            `a file whose patch GitHub withheld could not be read from its blobs either`;
        break;
      }
      parts.push(c);
      const link = gh(["api", `repos/{owner}/{repo}/compare/${sha}...${head}`]);
      if (link && link.status !== "diverged") reviewedInBranch = true;
      else if (reviewedInBranch === null && link) reviewedInBranch = false;
    }
    atReviewed = ok ? unionContributions(parts) : null;
  }

  const cls = classify({
    inSubject: true,
    reports,
    unreadable,
    uncompared,
    head,
    atHead,
    atReviewed,
    reviewedInBranch,
  });

  return { ...cls, reports, atHead, atReviewed };
}

/**
 * Every distinct file the head contributes lines in that no reviewed sha
 * also contributed — the set a reader report would have to cover. Pulled
 * out of `classify` because the gate truncates its detail to five files.
 */
export function uncoveredPaths(verdict) {
  if (verdict.state !== STATE.UNCOVERED) return [];
  if (!verdict.atHead || !verdict.atReviewed) return [];
  const headAdds = verdict.atHead.adds;
  const reviewedAdds = verdict.atReviewed.adds;
  const newAdds = [...headAdds].filter((l) => !reviewedAdds.has(l));
  return [...new Set(newAdds.map((l) => l.split(NUL)[0]))];
}

export function formatVerdict(verdict, paths) {
  const lines = [];
  lines.push(`#${verdict.number ?? "?"}  ${verdict.state}`);
  if (verdict.detail) lines.push(`  ${verdict.detail}`);
  if (paths.length) {
    lines.push(`  ${paths.length} file(s) NOT covered by any reader report:`);
    for (const p of paths) lines.push(`    - ${p}`);
  }
  return lines.join("\n");
}

function main() {
  const number = prNumberFrom(process.argv.slice(2), process.env);
  if (number === null) {
    process.stderr.write(
      "Usage: node scripts/list-uncovered-pr-files.mjs <PR_NUMBER>\n" +
        "   or: PR_NUMBER=<n> node scripts/list-uncovered-pr-files.mjs\n"
    );
    process.exit(2);
  }

  const verdict = verdictFor(number);
  verdict.number = number;

  const paths = uncoveredPaths(verdict);
  process.stdout.write(formatVerdict(verdict, paths) + "\n");

  if (REFUSALS.has(verdict.state)) process.exit(2);
  if (FINDINGS.has(verdict.state)) process.exit(1);
  process.exit(0);
}

if (invokedAsProgram(import.meta.url)) main();
