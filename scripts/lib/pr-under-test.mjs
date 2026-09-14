/**
 * WHICH PULL REQUEST IS THIS RUN GATING, AND WHAT A GATE MAY CONCLUDE WITHOUT KNOWING (#1226).
 *
 * Several gates read the WHOLE open board and fail the run on any finding, while CI runs them in a
 * per-pull-request context. One pull request's defect then reds whichever other pull request happens
 * to be in CI, and the reddened author cannot repair it from their own tree (#1007, closed for one
 * of four). `assert-armed-prs-are-covered-by-a-review` already solved it; this is that solution
 * lifted out so the other gates use it rather than growing a second copy of it (#1161).
 *
 * WHAT IS SHARED AND WHAT IS NOT, because only some of it turned out to be general:
 *   - `prUnderTest` is shared whole: it reads the event and answers, or says why it cannot.
 *   - The REFUSAL DECISION is shared; the sentence is not. Each gate passes what it would otherwise
 *     have concluded, so its own voice survives and the rule about WHEN to refuse does not fork.
 *   - Admission is NOT shared. Whether a draft or a DIRTY pull request belongs in a subject is each
 *     gate's own policy -- `armed` excludes both because they are not merge candidates, and that
 *     means nothing to a gate about authorship. The lib takes the gate's predicate.
 *   - A pass LINE is not shared either. Only the MODE CLAUSE is: which pull request was gated, or
 *     that this is a board-wide run and why.
 *
 * BOARD MODE OUTSIDE CI IS INTENDED (ARCHITECT's ruling). A developer running these locally gets the
 * whole board, and a bystander red costs a reader a minute where a missing gate costs a merge. The
 * condition is that the output SAYS which mode it is in, so "is this mine?" is answered without
 * reading the source.
 */
import { readFileSync } from "node:fs";

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
 * The refusal a scoped run owes, or null. `wouldConclude` is what THIS gate would otherwise have
 * said, so the sentence stays the gate's own and only the rule is shared.
 *
 * BOTH CAUSES REFUSE, and element 2 of #1226 is that a reason is never a pass: an unreadable event
 * payload, and a named pull request missing from the board this run just read. The second is the
 * subset-reported-as-the-whole case -- it closed mid-run, or the listing truncated below it.
 */
export function scopeRefusal(under, openNumbers, wouldConclude) {
  if (under.reason)
    return (
      `${under.reason}.\n` +
      `      This run is gating a pull request it cannot name, so it cannot state whether\n` +
      `      that pull request was examined. Exit 2, not 0 — "the subject is unknown" is a\n` +
      `      different answer from "${wouldConclude}".`
    );
  if (under.number !== null && !openNumbers.includes(under.number))
    return (
      `the event names #${under.number} as the pull request under test, and it is not in\n` +
      `      the open board this check just read. Either it closed while this run was in ` +
      `flight, or\n      \`gh pr list\` truncated below it. Both make the subject a SUBSET ` +
      `reported as the whole.\n      Exit 2, not 0.`
    );
  return null;
}

/** Which mode the run is in, for the pass line and for a reader asking "is this red mine?" */
export function modeClause(under) {
  return under.number === null
    ? `, judging the WHOLE BOARD because this run has no \`pull_request\` event`
    : `, INCLUDING #${under.number}, the pull request this run is gating`;
}

/**
 * The findings this run is entitled to fail on. In pull-request mode, only the one under test; in
 * board mode, all of them. THE SUBJECT DOES NOT NARROW -- the board is still read and still
 * reported -- because a subject that quietly becomes a sample is the defect this repository has
 * already paid for.
 */
export function narrowToUnderTest(findings, under, numberOf = (f) => f.number) {
  if (under.number === null) return findings;
  return findings.filter((f) => numberOf(f) === under.number);
}
