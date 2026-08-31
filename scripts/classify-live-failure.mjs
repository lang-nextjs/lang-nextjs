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
import { createHash } from "node:crypto";

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
    `FAIL: ${logPath} does not exist — the run produced no output to classify.`,
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
  /*
   * ATTRIBUTE FROM THE FIELD, NOT FROM A SUCCESSFUL PARSE (#426).
   *
   * This returned "defect" for any frame JSON.parse could not read, and
   * PLAYWRIGHT RENDERS THE SAME ASSERTION MESSAGE SEVERAL TIMES, NOT ALL OF
   * THEM COMPLETE. A truncated rendering of a provider frame still contains
   *
   *     "origin": "provider"
   *
   * verbatim, but does not parse — so it fell into the catch and was counted as
   * a transport defect. Measured on main @ 79158470: four renderings, two
   * complete and two truncated, giving defects=2 upstream=2 on a failure whose
   * every frame was provider-attributed. The retry never engaged, and main went
   * red for a reason the evidence did not support.
   *
   * THIS IS THE MIRROR OF THE FAILURE THE PROOF WAS BUILT FOR. The selftest
   * watches this say DEFECT on a real backend defect, because a classifier only
   * ever seen agreeing with "upstream" cannot be told from one that says
   * "upstream" unconditionally. The blame-ourselves default makes the OPPOSITE
   * direction the more likely one in practice: every read failure resolved to
   * "ours". That default is still right for genuine ambiguity — but
   * "WE COULD NOT READ THIS" is not "THIS IS OUR FAULT", and only one of them
   * is a claim about the transport.
   *
   * So: parse when it works, because a parsed frame is authoritative. Fall back
   * to reading the field out of the raw text, because `origin` is OUR field in
   * OUR frame and a flat string match on it is exact — this is not the
   * vendor-prose hazard, which was about matching a provider's message text.
   * Only when neither works is the frame UNATTRIBUTED, which is its own answer.
   */
  let data = null;
  try {
    data = JSON.parse(line.replace(/^.*?data:\s*/, "")).data ?? null;
  } catch {
    // A rendering we cannot parse is not a verdict. Fall through.
  }
  if (data && typeof data.origin === "string") {
    return data.origin === "provider" ? "upstream" : "defect";
  }

  const field = line.match(/"origin"\s*:\s*"([a-z]+)"/);
  if (field) return field[1] === "provider" ? "upstream" : "defect";

  /*
   * NO ORIGIN AT ALL — a proxy-emitted frame (packages/server emits data-error
   * and does not set origin), an older backend, or a rendering truncated before
   * the field. Distinct from "defect" ON PURPOSE: calling an unreadable frame a
   * transport defect is what produced #426, and calling it upstream would be
   * the failure the proof exists to prevent. It is neither, and the verdict
   * below still refuses to treat it as a pass.
   */
  return "unattributed";
}

/*
 * ONE ENTRY PER FRAME, NOT PER RENDERING (#426).
 *
 * Playwright prints each assertion message in several places, so the same
 * failure appeared up to three times and was counted three times. `defects` and
 * `upstream` were therefore counts of RENDERINGS, which is not a count of
 * anything a person or a rate wants — and it silently inflated both numbers in
 * the same breath as mis-bucketing them.
 *
 * Deduped on the frame text after normalising whitespace, so a wrapped or
 * re-indented rendering of the same frame collapses onto it. Truncated
 * renderings do NOT collapse onto their complete form — they are shorter
 * strings — which is why the fix above matters independently: dedupe alone
 * would still have left a truncated copy miscounted.
 */
const seen = new Set();
const frames = [
  ...log.matchAll(/LIVE_TRANSPORT_ERROR_FRAME ([^\n]*?) :: ([^\n]*)/g),
]
  .map((m) => ({ cell: m[1].trim(), frame: m[2].trim() }))
  .filter((f) => f.frame)
  .filter((f) => {
    /*
     * KEYED ON CELL AND FRAME, NOT FRAME ALONE.
     *
     * The first version of this dedupe keyed on the frame text only, and every
     * cell in a live-transport failure carries the SAME provider frame — the
     * message is the provider's, not the cell's. So two genuinely different
     * test failures collapsed onto one and the count under-reported by exactly
     * the thing it was added to measure. Verified against the real #426 log:
     * frame-only keying gave upstream=1 for two failing cells.
     *
     * Over-collapsing is the more dangerous direction here, because a count
     * that is too LOW makes a run look less affected than it was.
     *
     * WHAT THIS COUNTS, EXACTLY: distinct (cell, frame) evidence items — NOT
     * failing tests. It collapses a frame re-rendered verbatim, and it does NOT
     * collapse a corrupted rendering against its clean twin, because their text
     * differs. Run 33368235350 emitted four frames from two failing cells, two
     * of them corrupted, and this scores it 4. That is deliberate: the fields
     * are evidence counts, and the VERDICT — which is what #426 was filed about
     * — is correct either way, since every one of those four is attributed to
     * the provider. Do not read `upstream=4` as four failing tests.
     */
    const key = `${f.cell}::${f.frame.replace(/\s+/g, " ")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .map((f) => f.frame);

const upstream = frames.filter((f) => classifyFrame(f) === "upstream");
const defects = frames.filter((f) => classifyFrame(f) === "defect");
const unattributed = frames.filter((f) => classifyFrame(f) === "unattributed");

let verdict;
if (exitCode === 0) {
  verdict = "PASS";
} else if (defects.length > 0) {
  // A defect anywhere outranks any number of upstream frames: one real break is
  // the thing this job exists to catch, and it must not be filed under an
  // outage that happened in the same run.
  verdict = "TRANSPORT_DEFECT";
} else if (unattributed.length > 0) {
  /*
   * FRAMES WE COULD NOT ATTRIBUTE OUTRANK ATTRIBUTED UPSTREAM ONES (#426).
   *
   * Not TRANSPORT_DEFECT — that is a positive claim about our code and these
   * frames do not support one. Not UPSTREAM_UNAVAILABLE either, because that
   * would let an unreadable frame buy a retry and eventually a pass, which is
   * the direction the proof exists to prevent.
   *
   * FAILED_UNCLASSIFIED is the honest name: red, not retried, and saying that
   * the reason could not be read. The blame-ourselves default survives — an
   * ambiguous frame still costs someone a look — without asserting a defect
   * nothing measured.
   */
  verdict = "FAILED_UNCLASSIFIED";
} else if (upstream.length > 0) {
  verdict = "UPSTREAM_UNAVAILABLE";
} else {
  // Failed, with no error frame at all — a timeout, a crash, a missing backend.
  verdict = "FAILED_UNCLASSIFIED";
}

/*
 * EVERY FRAME IS PRINTED UNDER A HEADING THAT IS TRUE OF IT (#426).
 *
 * The listing used to print the defect bullets and the upstream bullets one
 * after another beneath a single sentence chosen by the verdict — so a
 * TRANSPORT_DEFECT run printed provider-attributed frames under "at least one
 * failure was NOT attributable to the provider". That sentence is what a reader
 * acts on, and it contradicted the frames directly beneath it.
 *
 * Each group now carries its own label, and a group with nothing in it prints
 * nothing rather than an empty heading.
 */
/*
 * THE EVIDENCE MUST CONTAIN WHAT THE VERDICT WAS COMPUTED FROM (#437).
 *
 * This was `f.slice(0, 200)`. The production frames are 219 characters, so the summary
 * clipped 19 bytes off the end of every one of them — and `origin`, the ONLY field the
 * verdict turns on, is not guaranteed to sit inside the first 200. Run 33368235350 printed
 * four bullets that are byte-identical at 200 characters and counted them 2 defect /
 * 2 upstream. Both facts were true simultaneously, and nobody reading the summary could see
 * why, because the bytes the classifier reacted to were the ones the display had removed.
 *
 * A BIGGER CONSTANT IS THE SAME DEFECT AT A BIGGER SIZE. The rule is not "show more"; it is
 * "show the deciding field", plus SAY SO when anything was dropped. Uniform truncation also
 * invents relationships that are not in the data — every frame appearing to be exactly 218
 * characters was the clipping, not the frames.
 *
 * WHY THIS LOCATES THE KEY AND NOT THE VALUE. classifyFrame decides what an origin VALUE
 * means; this only needs to know WHERE the field is, so it searches for the literal key
 * `"origin"` and never interprets what follows. #523 repartitions the value set — that
 * changes the verdict, not where the evidence lives, so these two do not have to agree about
 * anything and cannot drift apart. The selftest pins the contract from the outside: if a
 * frame contains an origin field, the rendered bullet contains it too.
 */
const EVIDENCE_BUDGET = 200;
const ORIGIN_KEY = '"origin"';

export function evidence(line) {
  if (line.length <= EVIDENCE_BUDGET) return `\`${line}\``;

  const head = line.slice(0, EVIDENCE_BUDGET);
  const dropped = line.length - EVIDENCE_BUDGET;
  const key = line.indexOf(ORIGIN_KEY);

  /*
   * Searched the WHOLE line, so this is a measurement rather than an inference: the field is
   * absent, which is itself the reason such a frame classifies as unattributed. Saying "not
   * shown" here would suggest it might be further along, which is the ambiguity #426 was
   * about.
   */
  if (key === -1)
    return `\`${head}\` _(+${dropped} chars not shown; no \`origin\` field anywhere in this frame)_`;

  // The window that must survive: the key plus enough of what follows to read its value.
  const fieldEnd = Math.min(line.length, key + ORIGIN_KEY.length + 24);
  if (fieldEnd <= EVIDENCE_BUDGET)
    return `\`${head}\` _(+${dropped} chars not shown)_`;

  /*
   * The deciding field is past the cutoff, which is the case that shipped a wrong-looking
   * summary. Keep the head so bullets stay comparable, keep a window around the field, and
   * name the gap between them so the elision is visible rather than silent.
   */
  const from = Math.max(EVIDENCE_BUDGET, key - 16);
  const elided = from - EVIDENCE_BUDGET;
  const tail = line.slice(from, fieldEnd);
  const after = line.length - fieldEnd;
  return (
    `\`${head}\`` +
    (elided > 0 ? ` _(… ${elided} chars elided …)_ ` : " ") +
    `\`${tail}\`` +
    (after > 0 ? ` _(+${after} more)_` : "")
  );
}

const group = (label, items) =>
  items.length === 0
    ? []
    : ["", `**${label}**`, ...items.map((f) => `- ${evidence(f)}`)];

const summary = [
  `### Live transport: ${verdict}`,
  "",
  `- exit code: \`${exitCode}\``,
  `- transport defects: **${defects.length}**`,
  `- upstream-attributed frames: **${upstream.length}**`,
  `- frames whose origin could not be read: **${unattributed.length}**`,
  "",
  verdict === "UPSTREAM_UNAVAILABLE"
    ? "Every failing assertion was an error frame the model provider's SDK raised " +
      "(`origin=provider`). The transport delivered what it was given. This red is " +
      "**not actionable in this repository**."
    : verdict === "TRANSPORT_DEFECT"
      ? "At least one frame was attributed to THIS repository (`origin` is not " +
        "`provider`). That is the case the job exists to catch. Any provider frames " +
        "listed below are shown separately and are not the reason for this verdict."
      : verdict === "FAILED_UNCLASSIFIED"
        ? unattributed.length > 0
          ? "The failure could NOT be attributed. One or more frames carried no readable " +
            "`origin` — a proxy-emitted frame, an older backend, or a truncated " +
            "rendering. Treated as ours because an unreadable reason must not buy a " +
            "retry, but this is **not** a claim that the transport is broken."
          : "The job failed without producing any error frame — a timeout, a crash, or " +
            "a backend that never started. Treated as ours."
        : "No failures.",
  ...group("Attributed to this repository", defects),
  ...group("Attributed to the model provider", upstream),
  ...group("Origin could not be read", unattributed),
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
/*
 * WHOSE VERDICT IS THIS? (#496)
 *
 * The fixtures printed verdicts in the SAME FORMAT, on the SAME STREAM, inside the SAME JOB as
 * the real classification, carrying `attempt=first` exactly like a real run. Grepping
 * LIVE_TRANSPORT_VERDICT over a failing run returned `TRANSPORT_DEFECT defects=2 upstream=2`
 * and it read as a real defect on main. It was fixture output, and it was nearly reported as
 * a real one while measuring #400.
 *
 * Three filters were tried before one worked, and the two that failed are instructive: the step
 * name silently dropped half the runs, because older logs render the column as UNKNOWN STEP —
 * a NARROWER pattern than the question, returning a confident subset — and `attempt=` did
 * nothing, because fixtures carry it too. Only adjacency to #440's fingerprint worked, and that
 * works by ACCIDENT of that fingerprint existing rather than by design.
 *
 * The mirror case is why this is fixed rather than documented: a fixture printing PASS in a job
 * whose real classification never ran would read as a clean transport.
 *
 * A DISTINCT TOKEN, so no filter for the real one can ever match a fixture — exact by
 * construction rather than by proximity. The selftest sets the flag; that it is DECLARED by the
 * caller is the weakness, and it is closed by assert-verdict-tokens-disjoint.mjs asserting that
 * a real selftest run emits ZERO real tokens. A fixture that forgot to declare itself would
 * fail there.
 */
const IS_FIXTURE = process.env.LIVE_TRANSPORT_SELFTEST === "1";
const TOKEN = IS_FIXTURE ? "LIVE_TRANSPORT_SELFTEST_VERDICT" : "LIVE_TRANSPORT_VERDICT";

/*
 * AND THE VERDICT CARRIES ITS OWN SUBJECT. Adjacency to the fingerprint line is not a property
 * of the verdict — it is a property of two lines being printed in order, which log truncation,
 * interleaving from parallel steps, or any filter that reorders will break. The sha of the file
 * this classification actually read travels ON the line, so a verdict can be traced to its
 * input even when it arrives alone.
 */
const LOG_SHA = createHash("sha256").update(log).digest("hex").slice(0, 16);

const RECORD =
  `${TOKEN} verdict=${verdict} defects=${defects.length} ` +
  `upstream=${upstream.length} ` +
  // THE THIRD BUCKET IS COUNTED TOO (#426). A field emitted only for the two
  // buckets that existed before would make "how often could we not read a
  // frame" unanswerable — which is the same gap that let the mis-attribution
  // run unnoticed, since the counts looked complete.
  `unattributed=${unattributed.length} ` +
  `exit=${exitCode} ` +
  // WHICH ATTEMPT, or the samples cannot be paired. A retry-recovery rate is a
  // statement about PAIRS — first attempt upstream, second attempt what? — and
  // a record that does not say which attempt it describes reduces to a count
  // of failures, which is the number we already had.
  `attempt=${process.env.LIVE_TRANSPORT_IS_RETRY ? "retry" : "first"} ` +
  `log=${LOG_SHA}`;

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
    `verdict=${verdict}\nadvice=${RETRY_ADVICE}\n`,
  );
}
console.log(`::${ANNOTATION_LEVEL} title=live-transport::${RECORD}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `${summary}\n\n<!-- ${RECORD} -->\n`,
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
