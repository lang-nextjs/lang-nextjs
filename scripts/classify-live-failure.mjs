#!/usr/bin/env node
/**
 * PRESENT AN UPSTREAM OUTAGE DIFFERENTLY FROM A TRANSPORT DEFECT (#400 step 1).
 *
 * `E2E — open-swe live transport` runs only on push to main and failed 2 of 6
 * pushes on an UPSTREAM overload. A job whose red is routinely correct-to-ignore
 * is camouflage for one whose red is not — which is how `E2E — Real LLM` stayed
 * red for twelve consecutive pushes with nobody noticing (#114).
 *
 * Every available policy — leave it red, retry it, drop it from required — is
 * indefensible while the two cases look the same, because each gets applied to
 * both. This makes them different. IT DOES NOT DECIDE THE POLICY: the exit code
 * is passed through unchanged, so today's behaviour is byte-for-byte what it
 * was, and the decision is a separate call made with this in front of it.
 *
 * WHAT IT READS. The spec tags each in-band error frame `[UPSTREAM_UNAVAILABLE]`
 * or `[TRANSPORT_DEFECT]`, from the frame's `origin` field — decided in
 * `_common.py::_error_origin` by isinstance against the provider SDKs' base
 * error classes. NOT from the message text: that would be a string comparison
 * against a vendor's product copy, which they may reword without telling anyone.
 *
 * THE DEFAULT IS "OURS". No marker, an unparseable frame, or an absent origin
 * all present as a defect. A classifier that resolves ambiguity toward "someone
 * else's problem" stops defects being investigated, and that is strictly worse
 * than the honest red it replaced.
 *
 * Usage: node scripts/classify-live-failure.mjs <log-file> <exit-code>
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";

const [logPath, rawCode] = process.argv.slice(2);
const exitCode = Number(rawCode);

if (!logPath || !Number.isInteger(exitCode)) {
  console.error("usage: classify-live-failure.mjs <log-file> <exit-code>");
  process.exit(2);
}

/*
 * A MISSING LOG IS NOT A CLEAN RUN. Reading nothing and reporting no markers
 * would turn a step that failed to produce output into a silent pass-through,
 * which is the shape this repo keeps removing.
 */
if (!existsSync(logPath)) {
  console.error(
    `FAIL: ${logPath} does not exist — the run produced no output to classify.`
  );
  process.exit(2);
}

const log = readFileSync(logPath, "utf-8");

/**
 * Classify ONE in-band error frame: whose failure it represents.
 *
 * `origin` is decided at the source by `_common.py::_error_origin`, using
 * isinstance against the provider SDKs' base error classes. NOT the message
 * text — that would be a string comparison against a vendor's product copy,
 * which they may reword at any time without telling anyone.
 *
 * Exported so it can be tested against frames this repo's real error path
 * actually produced, rather than against strings written by whoever also wrote
 * the rule. Anything that is not positively attributable to a provider is ours.
 */
export function classifyFrame(line) {
  let data = {};
  try {
    data = JSON.parse(line.replace(/^.*?data:\s*/, "")).data ?? {};
  } catch {
    // An unparseable error frame is still an error frame, and more likely ours.
  }
  /*
   * THE ASYMMETRY, AT THE SITE THAT ENCODES IT. Anything not positively
   * attributable to a provider is ours — a missing origin, an unparseable
   * frame, a value nobody anticipated.
   *
   * Calling OUR defect an upstream problem stops it being investigated.
   * Calling an UPSTREAM problem ours costs someone a look at a red that was
   * not their fault. Only one of those is recoverable, so the ambiguous case
   * resolves toward the recoverable mistake. A classifier that resolved it the
   * other way would be worse than the honest red it replaces.
   */
  return data.origin === "provider" ? "upstream" : "defect";
}

/*
 * ONE CLASSIFIER, HERE. The spec quotes each frame verbatim after
 * LIVE_TRANSPORT_ERROR_FRAME and does not interpret it — see the note there.
 */
const frames = [
  ...log.matchAll(/LIVE_TRANSPORT_ERROR_FRAME[^\n]*?:: ([^\n]*)/g),
]
  .map((m) => m[1].trim())
  .filter(Boolean);
const upstream = frames.filter((f) => classifyFrame(f) === "upstream");
const defects = frames.filter((f) => classifyFrame(f) === "defect");

let verdict;
if (exitCode === 0) {
  verdict = "PASS";
} else if (defects.length > 0) {
  // A defect anywhere outranks any number of upstream frames: one real break is
  // the thing this job exists to catch, and it must not be filed under an
  // outage that happened in the same run.
  verdict = "TRANSPORT_DEFECT";
} else if (upstream.length > 0) {
  verdict = "UPSTREAM_UNAVAILABLE";
} else {
  // Failed, with no classified error frame — a timeout, a crash, a missing
  // backend. Ours by default, and named distinctly so it is not read as either.
  verdict = "FAILED_UNCLASSIFIED";
}

const summary = [
  `### Live transport: ${verdict}`,
  "",
  `- exit code: \`${exitCode}\``,
  `- transport defects: **${defects.length}**`,
  `- upstream-attributed frames: **${upstream.length}**`,
  "",
  verdict === "UPSTREAM_UNAVAILABLE"
    ? "Every failing assertion was an error frame the model provider's SDK raised " +
      "(`origin=provider`). The transport delivered what it was given. This red is " +
      "**not actionable in this repository**."
    : verdict === "TRANSPORT_DEFECT"
    ? "At least one failure was **not** attributable to the provider. This is the " +
      "case the job exists to catch."
    : verdict === "FAILED_UNCLASSIFIED"
    ? "The job failed without producing a classified error frame — treated as ours."
    : "No failures.",
  "",
  ...defects.map((d) => `- \`${d.slice(0, 200)}\``),
  ...upstream.map((u) => `- \`${u.slice(0, 200)}\``),
].join("\n");

/*
 * AN OUTCOME WE CANNOT COUNT IS AN OUTCOME WE CANNOT NOTICE GETTING WORSE.
 *
 * A verdict that only appears as prose in a step summary is invisible in
 * aggregate — and then "a red nobody investigates" has been replaced by "a
 * neutral nobody investigates", which is the same failure in a calmer colour.
 *
 * TWO EMISSIONS, DELIBERATELY, because they answer different questions:
 *
 *   RECORD     one line, fixed key=value order, emitted on EVERY verdict
 *              including PASS. A format emitted only on failure cannot produce
 *              a rate, because the denominator is missing.
 *   ANNOTATION a GitHub workflow command. Annotations attach to the run and are
 *              readable through the checks API WITHOUT downloading logs, which
 *              is the actual requirement — this whole issue is about a job
 *              whose signal nobody can see without opening it.
 *
 * The level varies by verdict rather than being fixed: an upstream outage is a
 * `notice` because it is not actionable here, a defect is an `error` because it
 * is. One level for both would re-merge the two cases in the first place a
 * reader looks.
 */
const RECORD =
  `LIVE_TRANSPORT_VERDICT verdict=${verdict} defects=${defects.length} ` +
  `upstream=${upstream.length} exit=${exitCode} ` +
  // WHICH ATTEMPT, or the samples cannot be paired. A retry-recovery rate is a
  // statement about PAIRS — first attempt upstream, second attempt what? — and
  // a record that does not say which attempt it describes reduces to a count
  // of failures, which is the number we already had.
  `attempt=${process.env.LIVE_TRANSPORT_IS_RETRY ? "retry" : "first"}`;

const ANNOTATION_LEVEL = {
  PASS: "notice",
  UPSTREAM_UNAVAILABLE: "notice",
  TRANSPORT_DEFECT: "error",
  FAILED_UNCLASSIFIED: "warning",
}[verdict];

/*
 * SHOULD THE SUITE BE RETRIED? (#400 step 2.)
 *
 * Only for an upstream-only failure, and the reason is that the two cases are
 * finally distinguishable: a retry can no longer mask a defect, because a
 * defect in EITHER attempt reports TRANSPORT_DEFECT and stays red. Before the
 * classification existed, a retry here would have been the "hides a real
 * transport defect behind the retry" option this issue rejected.
 *
 * THE EVIDENCE, STATED AS WHAT IT IS. This is justified by ONE observed
 * recovery: push b2ecbb11 failed on two topologies with provider-attributed
 * frames, and its re-run succeeded. n=1. That is not a recovery RATE, and
 * nothing here should be read as claiming we measured one — three more
 * first-attempt failures with their retries recorded would make it a number.
 * The LIVE_TRANSPORT_VERDICT line exists so those accumulate without anyone
 * noticing them one at a time; a rate can be computed from the log record
 * rather than reconstructed by hand.
 *
 * IF THE RETRY ALSO COMES BACK UPSTREAM the job finishes NEUTRAL, not green.
 * "We could not test this" is not "this works", and a green there would be the
 * vacuous pass this repo keeps deleting.
 */
const RETRY_ADVICE =
  verdict === "UPSTREAM_UNAVAILABLE" && !process.env.LIVE_TRANSPORT_IS_RETRY
    ? "retry"
    : "no-retry";

console.log(summary);
console.log(RECORD);
console.log(`LIVE_TRANSPORT_ADVICE ${RETRY_ADVICE}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `verdict=${verdict}\nadvice=${RETRY_ADVICE}\n`
  );
}
console.log(`::${ANNOTATION_LEVEL} title=live-transport::${RECORD}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `${summary}\n\n<!-- ${RECORD} -->\n`
  );
}

/*
 * THE EXIT CODE REPORTS THE VERDICT; IT DOES NOT APPLY THE POLICY.
 *
 *   0  the suite passed
 *   1  a real failure — a transport defect, or a failure with no classified
 *      frame. Red, unchanged, and the caller has nothing to decide.
 *   3  UPSTREAM-ONLY. Distinct precisely so the caller can act on it without
 *      re-parsing prose, and so that "upstream" can never be mistaken for
 *      "passed" by something reading only the exit status.
 *
 * The retry lives in the WORKFLOW rather than here, deliberately. A script that
 * silently re-ran a suite would hide how many attempts happened from anyone
 * reading the job, and the whole subject of #400 is a signal nobody can see
 * without opening a log.
 */
process.exit(verdict === "UPSTREAM_UNAVAILABLE" ? 3 : exitCode === 0 ? 0 : 1);
