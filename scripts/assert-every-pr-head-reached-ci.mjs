/**
 * EVERY OPEN PULL REQUEST'S HEAD HAS REACHED CI, OR SAYS SO (#1095).
 *
 * A force-push can land, `git push` can report success, and NO WORKFLOW RUN IS EVER CREATED for the
 * new head. Observed on #1086: `2a654bcc` was the branch tip, `git ls-remote` confirmed it, and the
 * commit has 0 check-runs and 0 workflow runs to this day. The pull request read BLOCKED with an
 * empty checks section, which is what a pull request waiting for CI also looks like.
 *
 * WHY THIS IS SILENT RATHER THAN NOISY, which is the whole argument for a gate. The push succeeded,
 * so nothing local says otherwise. The runs from BEFORE the force-push still exist, attached to
 * shas that are no longer the head, so the branch does not look untested from a distance. And the
 * page shows no checks section at all -- #963's shape, "a pull request page with no checks section
 * reads as fine to anyone scrolling past". Every channel that would normally complain is quiet.
 *
 * THE DETECTOR DOES NOT DEPEND ON THE CAUSE, AND NO CAUSE SURVIVES. Three explanations have been
 * proposed and all three are falsified, the last of them by a control that arrived AFTER this file
 * was written:
 *
 *     a NON-main base            falsified below
 *     rebase AND retarget        falsified below
 *     a retarget landing inside  #1086's retarget was 14s after the push, which looked like a
 *     the dispatch window        race. Then #1163 was rebased and retargeted with the push and
 *                                the retarget ONE SECOND apart -- a tighter gap than the failure
 *                                -- and its head got 35 check-runs. Closer is not worse, so the
 *                                mechanism is not the gap.
 *
 * So NEITHER instance is explained, and that is the argument FOR this gate rather than against it: a
 * condition nobody can predict is one nothing else will warn about. This checks the CONDITION --
 * a head with no CI is unmergeable and unannounced however it got there -- and it fires whatever
 * the mechanism turns out to be.
 *
 * TWO INSTANCES ARE KNOWN, AND THEY ARE NOT THE SAME KIND OF PUSH:
 *
 *     2a654bcc   #1086   a FORCE-PUSH head
 *     538b742f   #1121   an ORDINARY-PUSH head
 *
 * Both carry the identical signature -- 0 check-runs, 0 workflow runs, and ONE check-suite,
 * belonging to a third-party app rather than to GitHub Actions. A healthy head of the same era
 * carries twelve Actions suites beside that one.
 *
 * WHAT WAS FALSIFIED, so nobody re-derives it. Measured over the 200 most recent pull requests,
 * #814..#1165 -- 225 force-push events, 224 distinct head shas, one with zero check-runs:
 *
 *     a NON-main base            #1086's own `b2ed51e6` was force-pushed with base
 *                                `fix/1074-...`, the exact suspect, and got 35 check-runs.
 *                                So do #953's and #937's stacked pushes.
 *
 *     rebase AND retarget        #953's `8d77bc7c` is the same shape 61 seconds before its
 *                                retarget, and it RAN. The conjunction is not sufficient.
 *
 * WHAT THE POPULATION IS, BECAUSE A READER MEETING A RATE HERE LATER WILL NOT HAVE THE COMMIT
 * MESSAGE. My own sweep covered FORCE-PUSH events only -- `HeadRefForcePushedEvent.afterCommit` is
 * the only place the API names a head outright. `Commit.pushedDate` is null on this repository, so
 * for an ORDINARY push "was ever a head" cannot be told from "was an intermediate commit in some
 * push", and I recorded that population as unsampleable.
 *
 * THAT WAS WRONG, AND WHY IT LOOKED TRUE IS THE STRONGEST ARGUMENT THIS FILE HAS. A runs-side sweep
 * classifies a head as INDETERMINATE exactly when Actions failed on it: a head WITH runs appears in
 * the runs set and is never a candidate, and a head WITHOUT runs is indistinguishable from an
 * intermediate commit. THE DEFECT ERASES ITS OWN INSTANCES FROM THE INSTRUMENT BUILT TO COUNT THEM.
 * ARCHITECT resolved it through a third channel -- CHECK-SUITES, which a push creates even when no
 * workflow run materialises. Of 146 indeterminate commits, 145 had zero suites and one had a suite
 * and no run: `538b742f`.
 *
 * SO THE SHAPE IS SOUND IN THE AFFIRMATIVE AND INCOMPLETE IN THE NEGATIVE. An instance found is a
 * real instance. No rate over head changes has been established, and TWO is a floor rather than a
 * count. Do not read it as a frequency, and do not lower the grace window on the strength of how
 * rare this looks -- the instrument that made it look rare is the one this defect hides from.
 *
 * THE GRACE WINDOW IS DERIVED FROM THE COST ASYMMETRY, NOT FROM THE SAMPLE, and the distinction is
 * the point. Sixty randomly sampled force-push shas, measured from the push event to the workflow
 * run being created:
 *
 *     min 2s   p50 4s   p90 4s   p99 4s   max 5s      over 120s: 0      with no run at all: 0
 *
 * A threshold of `max x k` would be a threshold pinned to today: that sample cannot contain a
 * GitHub incident window, and setting 30 seconds because 5 was the worst seen is how a gate becomes
 * a scheduled failure. So the number comes from the costs instead:
 *
 *     a false POSITIVE   a red on a pull request whose CI was merely slow
 *                        -> somebody re-reads a rollup. Minutes.
 *     a false NEGATIVE   a pull request that will NEVER get CI, silently
 *                        -> unmergeable, unannounced, and the reason #1095 exists.
 *
 * 30 minutes is far above any plausible dispatch delay and far below the point where a person would
 * have noticed anyway. **Move it for a reason, not by re-measuring**: a faster observed dispatch
 * does not argue for a smaller window, because the window is not measuring dispatch.
 *
 * AND THE TRANSIENT IT MUST NOT FIRE ON IS REAL. `zero check runs` was seen twice on 2026-09-09,
 * on #1158 and #1163, both times a query landing inside that few-second window. Any grace at all
 * separates those from the permanent state -- which is why "has not started" versus "will never
 * start" is the easy half of this problem and not the hard one.
 */
import { spawnSync } from "node:child_process";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

/** The page size asked of `gh pr list`. A truncated board would understate the subject. */
export const PR_LIMIT = 200;

/**
 * Minutes a head may carry no checks before it is a finding. See the derivation above: this is a
 * function of what a wrong answer costs in each direction, NOT of the measured dispatch delay.
 */
export const GRACE_MINUTES = 30;

export const STATE = {
  HAS_CI: "CI reached this head",
  WITHIN_GRACE: "no checks yet, but inside the grace window - not a finding",
  NO_CI: "NO CI WILL EVER RUN ON THIS HEAD - and nothing else says so",
};

/** The one state that fails. */
export const FINDINGS = new Set([STATE.NO_CI]);

/**
 * Classify ONE pull request. Pure: every fact is passed in, so the proof drives every state
 * without a network, including the state the live board does not currently hold.
 *
 * `rollupCount` is null when the field could not be read. That is NOT zero -- an unreadable rollup
 * and an empty one are opposite answers, and the whole defect is that an empty one looks like
 * nothing being wrong. A null refuses rather than classifies.
 *
 * `ageMinutes` null falls THROUGH to the finding, copying the choice
 * `assert-every-branch-was-raised` made and for the same reason: an age we could not read is not
 * evidence of youth, and granting grace on it would let a missing date dismiss a real one.
 */
export function classify({
  number,
  rollupCount,
  ageMinutes = null,
  grace = GRACE_MINUTES,
}) {
  if (rollupCount === null || rollupCount === undefined)
    return {
      state: STATE.NO_CI,
      detail:
        "its check rollup could not be read at all, which is not the same as being empty - " +
        "and the unreadable case must not inherit the empty one's benefit of the doubt",
    };
  if (rollupCount > 0)
    return { state: STATE.HAS_CI, detail: `${rollupCount} check(s)` };
  if (typeof ageMinutes === "number" && ageMinutes < grace)
    return {
      state: STATE.WITHIN_GRACE,
      detail: `head is ${ageMinutes} minute(s) old; the ${grace}-minute grace has not elapsed`,
    };
  const age =
    typeof ageMinutes === "number"
      ? `${ageMinutes} minute(s) after the head was written`
      : "and the head's age could not be read, so the grace window was not granted";
  return {
    state: STATE.NO_CI,
    detail: `zero checks ${age}. A push that triggered nothing looks exactly like one still starting, and #${number} would sit unmergeable with no channel saying why`,
  };
}

/**
 * Minutes since a head commit was written, or null.
 *
 * THIS IS A PROXY AND THE DIRECTION OF ITS ERROR IS THE REASON IT IS ACCEPTABLE. What matters is
 * when the sha was PUSHED; what is cheaply available is when it was COMMITTED. A rebase or amend
 * rewrites the committer date, so for the force-push case these coincide. Where they diverge --
 * a commit written hours ago and pushed just now -- the head reads OLDER than it is, so this fires
 * EARLY. That is the false positive, which costs somebody a second look, rather than the false
 * negative, which is the defect itself.
 */
export function headAgeMinutes(committedDate, now = Date.now()) {
  if (typeof committedDate !== "string") return null;
  const t = Date.parse(committedDate);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.floor((now - t) / 60000);
  /*
   * A DATE IN THE FUTURE IS UNREADABLE, NOT YOUNG. Returning a negative number would make it
   * compare below the grace and silently excuse the finding for as long as the skew lasts --
   * the one direction this whole check exists to prevent. `null` sends it down the
   * grace-not-granted path instead, where an age we cannot trust belongs.
   */
  return minutes < 0 ? null : minutes;
}

/** `gh` as data, or null when the call failed — a failure must not read as an empty board. */
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
    `\nREFUSE: ${why}\n` +
      "        Exit 2, not 1 and not 0 — nothing was compared, which is a different\n" +
      "        answer from every head having reached CI.\n\n"
  );
  process.exit(2);
}

/**
 * When a head commit was written, or null when the question could not be asked.
 *
 * ON THE RARE PATH DELIBERATELY, AND THE FIRST VERSION HAD IT ON THE COMMON ONE. Asking `gh pr
 * list` for `commits` alongside the rollup gets every commit of every open pull request with its
 * authors attached, and GitHub refuses it outright:
 *
 *     GraphQL: ... requesting up to 1,000,000 possible nodes which exceeds the maximum of 500,000
 *
 * The checker REFUSED on the live board while its own proof passed, because the proof drove a
 * shim. Beyond being too expensive it was the wrong shape: the age only matters when the rollup is
 * EMPTY, which was 1 pull request in 225 force-pushes, so the common case now costs one call and
 * the date is fetched only for a candidate finding.
 *
 * RETURNS null ON FAILURE, and `classify` treats that as grace-not-granted rather than as youth --
 * so a commit lookup that cannot answer produces a finding to be looked at, not a silent pass.
 */
function headCommitDate(sha) {
  const r = gh(["api", `repos/{owner}/{repo}/commits/${sha}`]);
  const d = r?.commit?.committer?.date ?? r?.commit?.author?.date;
  return typeof d === "string" ? d : null;
}

function main() {
  const open = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(PR_LIMIT),
    "--json",
    "number,headRefOid,isDraft,statusCheckRollup",
  ]);
  if (open === null)
    refuse("`gh pr list` did not answer, so no pull request was examined");
  if (!Array.isArray(open))
    refuse("`gh pr list` answered something that is not a list");
  /*
   * A FULL PAGE IS INDISTINGUISHABLE FROM A TRUNCATED ONE, so it refuses rather than reporting a
   * subject it cannot vouch for. The floor in checks.json catches an EMPTY answer; this catches
   * the other end, which a floor structurally cannot see.
   */
  if (open.length >= PR_LIMIT)
    refuse(
      `\`gh pr list\` returned ${open.length} pull requests, the limit asked for — the board may ` +
        `extend past it and a subject that may be short is not a subject`
    );

  reportSubject(open.length, "open pull request(s)");

  const now = Date.now();
  const findings = [];
  for (const pr of open) {
    const rollupCount = Array.isArray(pr?.statusCheckRollup)
      ? pr.statusCheckRollup.length
      : null;
    /*
     * The date is fetched ONLY for a head with no checks. On a healthy board that is no calls at
     * all, and the cost of this gate does not grow with a board it almost never has findings on.
     */
    const ageMinutes =
      rollupCount === 0
        ? headAgeMinutes(headCommitDate(pr.headRefOid), now)
        : null;
    const r = classify({ number: pr.number, rollupCount, ageMinutes });
    if (FINDINGS.has(r.state))
      findings.push({
        number: pr.number,
        oid: pr.headRefOid,
        detail: r.detail,
      });
  }

  if (findings.length === 0) {
    process.stdout.write(
      `OK: ${open.length} open pull request(s) examined, each with a head that CI reached — ` +
        `or young enough that the ${GRACE_MINUTES}-minute grace still covers it.\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    `\nFAIL: ${findings.length} of ${open.length} open pull request(s) have a head no CI ran on:\n`
  );
  for (const f of findings)
    process.stderr.write(
      `  #${f.number}  ${String(f.oid).slice(0, 8)}  ${f.detail}\n`
    );
  process.stderr.write(
    `\n      A push can succeed and create no run (#1095). Re-push the head — an empty commit\n` +
      `      or a force-push of the same content is enough — and confirm a run appears at the\n` +
      `      NEW sha, because the push succeeding is not evidence that it did.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
