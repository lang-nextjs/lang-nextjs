#!/usr/bin/env node
/**
 * verdict-streak.mjs — ON A RED, SAY WHETHER IT IS THE SIXTEENTH OF THE SAME EXTERNAL CAUSE
 * OR THE FIRST OF A NEW ONE (#664).
 *
 * THE GAP THIS CLOSES, stated as the thing that actually happened. Between 2026-09-01 03:22Z
 * and 12:05Z, main went red on SIXTEEN CONSECUTIVE PUSHES. Every one of those reds was
 * correct: `live-transport-with-retry.sh` classified both attempts as provider-attributed and
 * exited 1, because UNVERIFIED is not a pass. Every one of them ALSO carried a machine-readable
 * line saying so:
 *
 *     LIVE_TRANSPORT_VERDICT verdict=UPSTREAM_UNAVAILABLE defects=0 upstream=4 ...
 *
 * Nothing read that line across runs. So the sixteenth externally-caused red and the first
 * genuine regression rendered identically on the board — a red dot — and the only way to tell
 * them apart was to open a job log and know what to look for. e2e.yml's own comment records the
 * same shape happening under #114 (twelve pushes) and #530 (thirty-four runs). Diagnosed twice,
 * written into the workflow as a caution twice, and it recurred. A third caution was not going
 * to work; this is the mechanism instead.
 *
 * WHAT MAKES IT RUN, which is the design question that stalled it. A cross-run reader is
 * MONITORING, not a gate: it needs the network and a token, so as a `checks.json` entry it
 * would fail for reasons unrelated to the property it measures — which is exactly why
 * `measure-push-only-jobs.mjs` is documented as a hand-run instrument and deliberately left out
 * of the gate list. The resolution is not to schedule it. IT RUNS INSIDE THE JOB THAT ALREADY
 * FAILED, under `if: failure()`. The failure is the trigger, which is precisely when the
 * information is wanted, and there is nothing new to remember or maintain.
 *
 * IT CANNOT BLOCK ANYTHING, BY CONSTRUCTION. This never fails the job — see EXIT CODE below.
 * It is the same move the classifier already makes WITHIN a run ("this red names its cause"),
 * widened ACROSS runs. Not a new mechanism; an existing and trusted one, given a longer window.
 *
 * ── THE THREE CATEGORIES, AND WHY THE THIRD IS THE ONE THAT MATTERS ────────────────────────
 *
 *   TRANSPORT_DEFECT       a positive claim about OUR code. Extends the defect streak.
 *   PASS                   the transport was exercised and worked. ENDS the defect streak.
 *   UPSTREAM_UNAVAILABLE   the provider failed; the transport was never exercised. Neither
 *                          extends nor ends it — identical treatment to a cancelled run in
 *                          `streaks()`, and for the identical reason: it reports no verdict
 *                          about the subject. Counting it as a PASS would assert a health the
 *                          run never demonstrated.
 *   UNKNOWN                WE COULD NOT READ A VERDICT. Its own category, never folded into
 *                          any of the three above.
 *
 * UNKNOWN IS THE WHOLE CORRECTNESS PROBLEM. At least four different situations produce a run
 * with no verdict line — the run predates the classifier, the job was skipped, its log has
 * expired, or the job died before classification ever ran (an install failure, a timeout). All
 * four look identical from here: no match. If UNKNOWN were quietly counted as "not a defect",
 * a window in which every log had expired would report a defect streak of ZERO and read as a
 * clean bill of health. That is the false-green direction, which this repo names as the
 * dangerous one, produced by the instrument built to prevent it.
 *
 * So UNKNOWN is counted, printed, and load-bearing: if NOT ONE run in the window yields a known
 * verdict, the defect streak is not reported at all — it is INDETERMINATE. "I could not tell"
 * must never be spelled the same way as "zero".
 *
 * FETCH_FAILED IS DISTINCT FROM AN EMPTY WINDOW, for the same reason one layer up. A reader
 * that hit a rate limit and a reader that examined sixty runs and found no transition both have
 * nothing to report; they must not say it the same way. A zero from this script means "I
 * looked".
 *
 * THE LAST VERDICT IN A LOG WINS, NOT THE FIRST. A run that failed upstream and was retried
 * emits TWO verdict lines (attempt=first, attempt=retry). The run's answer is the retry's — a
 * first-attempt UPSTREAM followed by a retry TRANSPORT_DEFECT is a DEFECT run, and taking the
 * first match would file it as an outage and hide the regression this exists to surface.
 *
 * FIXTURE VERDICTS ARE NOT REAL ONES. `classify-live-failure.mjs` prints
 * LIVE_TRANSPORT_SELFTEST_VERDICT under its selftest, in the same job and the same format
 * (#496). The two tokens are not substrings of one another, so matching the real token cannot
 * pick up a fixture — and the selftest asserts that rather than trusting it, because it is one
 * token away from being wrong.
 *
 * EXIT CODE: ALWAYS 0, AND THIS IS THE ONE PLACE THAT DESERVES ARGUING WITH. This repo deletes
 * checks that exit 0 without establishing anything. The distinction is that this is not a
 * check: it asserts nothing and gates nothing. It runs in a job that is ALREADY RED, so a
 * non-zero exit could only add a second, confusing cause to a failure that already has one, and
 * a reader chasing it would be led away from the real defect. What this repo actually forbids
 * is a SILENT success — so every path here PRINTS, including every way of failing to compute.
 *
 * IT READS CONCLUSIONS, SO IT CANNOT SEE A RETRIED FAILURE — AND THAT BOUNDS WHAT ITS
 * OUTPUT MAY BE USED TO SAY.
 *
 * `playwright.config.ts` sets `retries: 1`. A test that fails and then passes is reported
 * FLAKY and THE JOB STILL SUCCEEDS, so a conclusion-keyed reader — this one, and any red/green
 * streak — is blind by construction to every failure that a retry rescued. Measured on the
 * Mocked job: 7% of concluded runs failed, while 33% contained at least one flaky test.
 * `measure-e2e-flake.mjs` is the instrument for that half, and it exists precisely because a
 * conclusions count was once reported as a flake rate.
 *
 * THE ASYMMETRY IS WHAT MAKES THIS USABLE RATHER THAN BROKEN: a conclusion-keyed count
 * UNDERCOUNTS and never overcounts. So "at least this many reds, at least this many
 * unexplained" is SOUND from this reader, and "the job is healthy" is NOT — the second
 * inference is unavailable here no matter how clean the window looks. Anything naming this
 * detector after CI health generally would be a name broader than its subject.
 *
 * SCOPE, STATED SO IT IS NOT MISTAKEN FOR MORE. This reads ONE job's verdicts. `E2E — Real LLM
 * (push to main only)` emits no verdict line at all — its specs fail on ordinary Playwright
 * assertions — so it is invisible here, and on the measured window it accounted for 9 of 14
 * failures. This does not cover it and does not pretend to. A detector whose subject is
 * narrower than its name is the defect this repo keeps finding; the fix is to say so.
 *
 * Usage: node scripts/verdict-streak.mjs [--job SUBSTRING] [--limit N] [--workflow FILE]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { invokedAsProgram } from "./lib/is-main.mjs";
// REUSED, NOT REIMPLEMENTED. The streak arithmetic — and specifically the rule that a run
// reporting no verdict neither extends nor breaks a run of reds — already exists with a proof
// covering the cancellation case. A second copy here would agree with it until it did not.
import { streaks } from "./measure-push-only-jobs.mjs";

export const REAL_TOKEN = "LIVE_TRANSPORT_VERDICT";
export const FIXTURE_TOKEN = "LIVE_TRANSPORT_SELFTEST_VERDICT";

/**
 * Verdict categories mapped onto the vocabulary `streaks()` already understands.
 *
 * "cancelled" is not a lie here; it is the same semantics under a name that function already
 * has: a value that reports nothing about the subject and therefore neither extends nor breaks
 * a run. UPSTREAM_UNAVAILABLE and UNKNOWN are both exactly that.
 */
/**
 * THE FULL VERDICT VOCABULARY, AND HOW I LEARNED IT WAS NOT THREE.
 *
 * This reader was first built against PASS / TRANSPORT_DEFECT / UPSTREAM_UNAVAILABLE, because
 * that is what a grep for those three names returns. Run against the real history it bucketed
 * 4 of the 5 most recent reds into a category that did not exist, and — far worse — printed
 * "very likely external ... needs no bisect" over them. A SEARCH FOR THE THINGS YOU ALREADY
 * KNOW ABOUT IS INDISTINGUISHABLE FROM A THOROUGH SEARCH.
 *
 * FAILED_UNCLASSIFIED is the one that was missed, and it is the opposite of reassuring.
 * classify-live-failure.mjs emits it for a failure whose frames could not be attributed, or one
 * with no error frame at all — a timeout, a crash, a missing backend — and its own comment is
 * explicit that "the blame-ourselves default survives: an ambiguous frame still costs someone a
 * look". A reader told that such a run is external has been actively misled.
 */
export const KNOWN_VERDICTS = [
  "PASS",
  "TRANSPORT_DEFECT",
  "UPSTREAM_UNAVAILABLE",
  "FAILED_UNCLASSIFIED",
];

/**
 * Verdict categories mapped onto the vocabulary `streaks()` already understands.
 *
 * "cancelled" is not a lie here; it is the same semantics under a name that function already
 * has: a value that reports nothing about the subject, and therefore neither extends nor breaks
 * a run. UPSTREAM_UNAVAILABLE, FAILED_UNCLASSIFIED and UNKNOWN are each exactly that — the
 * first because the provider failed, the other two because the reason could not be read. None
 * of them may map to "success", which would silently END a defect streak that is still running.
 */
export const STREAK_TOKEN = {
  TRANSPORT_DEFECT: "failure",
  PASS: "success",
  UPSTREAM_UNAVAILABLE: "cancelled",
  FAILED_UNCLASSIFIED: "cancelled",
  UNKNOWN: "cancelled",
};

/**
 * The LAST real verdict in a log, or null.
 *
 * Deliberately not anchored to the start of a line: the runner prefixes log lines with a
 * timestamp, and `assert-verdict-tokens-disjoint.mjs` records anchoring as the bug that made a
 * grep-based reader report zero of everything while the lines were plainly in the log.
 *
 * THE LAST MATCH WINS, NOT THE FIRST. A run that failed upstream and was retried emits TWO
 * verdict lines (attempt=first, attempt=retry). The run's answer is the retry's — a
 * first-attempt UPSTREAM followed by a retry TRANSPORT_DEFECT is a DEFECT run, and taking the
 * first match would file it as an outage and hide the regression this exists to surface.
 */
export function parseVerdict(logText) {
  const re = new RegExp(
    `${REAL_TOKEN} verdict=([A-Z_]+) defects=(\\d+) upstream=(\\d+)`,
    "g"
  );
  let last = null;
  for (const m of logText.matchAll(re)) {
    last = { verdict: m[1], defects: Number(m[2]), upstream: Number(m[3]) };
  }
  return last;
}

/**
 * Fold a newest-first window into the numbers a person reading a red needs.
 *
 * `rows`: [{ conclusion, verdict }] — verdict "UNKNOWN" when none could be read.
 */
export function tally(rows) {
  const counts = {
    PASS: 0,
    TRANSPORT_DEFECT: 0,
    UPSTREAM_UNAVAILABLE: 0,
    FAILED_UNCLASSIFIED: 0,
    UNKNOWN: 0,
  };
  /*
   * A VERDICT THIS READER HAS NEVER HEARD OF GETS ITS OWN BUCKET AND IS PRINTED.
   *
   * The classifier's vocabulary is free to grow, and the first version of this file proves what
   * happens when it does silently: `counts[v] = (counts[v] ?? 0) + 1` invented a key, the table
   * printed only the columns it knew, and the totals stopped summing to the window with nothing
   * to show for it. An unrecognised verdict is now counted as NEEDING A LOOK, which is the
   * direction that fails safe.
   */
  const unrecognised = new Map();
  for (const r of rows) {
    if (r.verdict in counts) counts[r.verdict]++;
    else unrecognised.set(r.verdict, (unrecognised.get(r.verdict) ?? 0) + 1);
  }
  const unrecognisedTotal = [...unrecognised.values()].reduce(
    (a, b) => a + b,
    0
  );
  const known = rows.length - counts.UNKNOWN - unrecognisedTotal;

  // TOTALITY, AS A TRIPWIRE RATHER THAN A HOPE. Every row lands in exactly one bucket; if that
  // ever stops being true the annotator says so loudly instead of printing a short table.
  const summed =
    Object.values(counts).reduce((a, b) => a + b, 0) + unrecognisedTotal;
  if (summed !== rows.length) {
    throw new Error(
      `verdict-streak: ${summed} counted over ${rows.length} rows — a row fell through`
    );
  }

  return {
    seen: rows.length,
    counts,
    unrecognised,
    unrecognisedTotal,
    known,
    red: streaks(rows.map((r) => r.conclusion)),
    // INDETERMINATE rather than zero when nothing in the window could be read. A defect streak
    // of 0 computed over 25 unreadable logs is not a finding, it is the absence of one.
    defect:
      known === 0
        ? null
        : streaks(rows.map((r) => STREAK_TOKEN[r.verdict] ?? "cancelled")),
    /*
     * THE PREDICATE THAT GATES THE REASSURING SENTENCE, and it is deliberately not the defect
     * streak. A window can hold zero TRANSPORT_DEFECTs and still be full of reds that someone
     * must look at: FAILED_UNCLASSIFIED is red-and-unexplained by construction, and an
     * unrecognised verdict is unexplained by definition. Only UPSTREAM_UNAVAILABLE is evidence
     * of nothing, because only there did the provider demonstrably fail before our code ran.
     */
    needsLook:
      counts.TRANSPORT_DEFECT + counts.FAILED_UNCLASSIFIED + unrecognisedTotal,
  };
}

/**
 * A STREAK THAT FILLS ITS WINDOW IS A LOWER BOUND, NOT A LENGTH (#742).
 *
 * `--limit 20` fetches twenty runs. A streak of twenty inside twenty is
 * indistinguishable from a streak of fifty-five: the window ran out before the
 * streak did, and the number printed is the window's size rather than the
 * streak's. Measured when this was found — main's defect streak was ~55 and this
 * annotator would have said "20 consecutive defect-attributed reds".
 *
 * THE SAME DEFECT AS #735, IN A SIBLING SCRIPT, AND #751'S ARGUMENT TRANSFERS
 * WORD FOR WORD. A fetch at the page size is not a board; a streak filling the
 * window is not a streak length. And like that one it cannot expire: the
 * relationship between a window size and a streak length is not a fact about any
 * run, so nothing anyone does on `main` can retire it.
 *
 * WHY "AT LEAST N" RATHER THAN A BIGGER WINDOW. Widening trades a bounded read
 * for an unbounded one and still saturates, at some larger number, with the same
 * ambiguity — it moves the boundary rather than removing it. "At least" is true
 * at every window size.
 *
 * ── THE PREDICATE IS everGreen, NOT n === seen (ARCHITECT-lang, review of #759) ──
 *
 * The first draft asked whether the streak equalled the window: `n === seen`.
 * That is wrong, and wrong in the direction that makes a fix look applied while
 * it does nothing. `seen` counts EVERY row; `current` counts only rows whose
 * token is "failure", and a cancelled row NEITHER EXTENDS NOR BREAKS a streak —
 * deliberately, because treating a cancellation as a break "would silently halve
 * the streaks in a repo where 13 of 60 runs do not conclude"
 * (measure-push-only-jobs.mjs). Driven through the real `streaks()`:
 *
 *     19 failures + 1 cancelled     current 19, seen 20   n===seen says "19"
 *     18 fail + 1 cancelled + 1 fail current 19, seen 20   n===seen says "19"
 *
 * Both run the ENTIRE window and are truncated at the oldest edge, and both would
 * have printed as measured lengths.
 *
 * FOR THE DEFECT STREAK THAT IS THE NORMAL CASE, NOT AN EDGE CASE. STREAK_TOKEN
 * maps THREE of five verdicts to "cancelled" — UPSTREAM_UNAVAILABLE,
 * FAILED_UNCLASSIFIED and UNKNOWN — so `n === seen` needs all twenty runs to be
 * TRANSPORT_DEFECT. One outage, one unreadable log, one unrecognised verdict, and
 * the hedge stops firing while the number is still a lower bound.
 *
 * `everGreen` is exact rather than approximate: false means no success anywhere
 * in the window, which IS "the current streak reaches the oldest row". It was
 * already returned by `streaks()` and already unused here.
 *
 * KEEP THE `n > 0` GUARD. `everGreen` is false on an EMPTY window too, so without
 * it a window that read nothing prints "at least 0" — a lower bound invented over
 * a subject that was never measured, which is this file's own defect one more
 * time.
 *
 * RESIDUAL, NAMED RATHER THAN CLOSED. `longest` is correct under this predicate
 * whenever everGreen is false, because then there is exactly one run and
 * longest === current. When everGreen is TRUE the longest run may still be the
 * TRAILING one touching the oldest edge, and therefore truncated — `streaks()`
 * does not expose which run was longest, so this hedge does not cover that case
 * and must not be read as though it does.
 *
 * WHAT MADE THIS HARD TO SEE, and it is worth stating because it will be hard to
 * see again. The header above says this reader "UNDERCOUNTS and never
 * overcounts" — which is TRUE, and about the conclusion-keyed-versus-flaky
 * asymmetry, a different measure entirely. So anyone checking whether the streak
 * number is trustworthy found a paragraph that appeared to cover it. Not a
 * missing caveat: a caveat whose subject is one measure over, which satisfies
 * the person who checks.
 */
export function streakCount(n, { everGreen }) {
  return n > 0 && !everGreen ? `at least ${n}` : String(n);
}

/** The lines a reader sees. Pure, so the selftest drives it without a network. */
export function render(t, { job }) {
  const c = t.counts;
  const out = [
    `### Verdict history — ${job}`,
    "",
    `Over the **${t.seen} completed runs before this one**, on \`main\`:`,
    "",
    `| red streak | defect streak | upstream | defect | unclassified | pass | unreadable |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    `| ${streakCount(t.red.current, t.red)} current, ${streakCount(
      t.red.longest,
      t.red
    )} longest | ${
      t.defect
        ? `${streakCount(t.defect.current, t.defect)} current, ${streakCount(
            t.defect.longest,
            t.defect
          )} longest`
        : "INDETERMINATE"
    } | ${c.UPSTREAM_UNAVAILABLE} | ${c.TRANSPORT_DEFECT} | ${
      c.FAILED_UNCLASSIFIED
    } | ${c.PASS} | ${c.UNKNOWN} |`,
    "",
  ];

  if (t.unrecognisedTotal > 0) {
    out.push(
      `**${t.unrecognisedTotal} run(s) carried a verdict this reader does not know:** ` +
        [...t.unrecognised].map(([v, n]) => `\`${v}\` x${n}`).join(", "),
      "Counted as needing a look, never as external. Teach this script the new verdict.",
      ""
    );
  }

  if (t.defect === null) {
    out.push(
      `**INDETERMINATE — no verdict could be read from ANY of the ${t.seen} runs.**`,
      `Not "no defects": nothing was legible. Logs expire, and a job that dies before`,
      `classification leaves none. This window supports no conclusion either way.`
    );
  } else if (t.defect.current > 0) {
    out.push(
      `**${streakCount(
        t.defect.current,
        t.defect
      )} consecutive defect-attributed reds.** These are positive claims`,
      `about this repository's code, not provider outages. This is not waiting-it-out territory.`,
      ...(t.defect.current > 0 && !t.defect.everGreen
        ? [
            "",
            `**"At least" is literal: the streak fills this ${t.seen}-run window, so it began`,
            `before the window starts and its true length is not knowable from here.** Widen`,
            `\`--limit\` to bound it, or read the job history by sha.`,
          ]
        : [])
    );
  } else if (t.needsLook > 0) {
    /*
     * THE BRANCH THAT EXISTS BECAUSE THIS SCRIPT GOT IT WRONG ON REAL DATA. Four of the five
     * most recent reds were FAILED_UNCLASSIFIED and the first version called the window
     * "very likely external". Zero defect-attributed reds is NOT the same as nothing to look at.
     */
    out.push(
      `**${t.needsLook} of ${t.seen} reds are unexplained, not external.** No verdict blamed`,
      `this repository's code outright, but that is not the same as an outage: an unclassified`,
      `red is one whose reason could not be read — an unattributable frame, a timeout, a crash,`,
      `a backend that never came up. **Do not wait this one out on the strength of a defect`,
      `streak of zero.**`
    );
  } else if (c.UPSTREAM_UNAVAILABLE > 0) {
    out.push(
      `**This red is very likely external.** All ${c.UPSTREAM_UNAVAILABLE} classified reds in`,
      `this window were provider-attributed (\`defects=0\`) with nothing unexplained beside`,
      `them — the transport was never exercised, so none is evidence about this repository. If`,
      `THIS run is also \`UPSTREAM_UNAVAILABLE\`, it is more of the same and needs no bisect.`,
      "",
      `**But if this run reports \`TRANSPORT_DEFECT\`, it is the FIRST defect-attributed red`,
      `in ${t.known} classified runs — that is a transition, and it is the signal.**`
    );
  } else {
    out.push(
      `No defect-attributed red in this window. If this run is defect-attributed it is the`,
      `first in ${t.known} classified runs.`
    );
  }

  if (c.UNKNOWN > 0 && t.defect !== null) {
    out.push(
      "",
      `_${c.UNKNOWN} of ${t.seen} runs yielded no readable verdict and are counted in neither`,
      `streak. They are not passes._`
    );
  }
  return out;
}

/**
 * THE ANNOTATOR REPORTS ITS OWN OUTCOME IN A GREPPABLE FORM.
 *
 * This whole mechanism exists because a verdict that only a human could extract went unread for
 * twenty-four runs. It would be a poor joke to have the reader itself be legible only in prose.
 * Exactly one of these is printed per invocation, on its own line:
 *
 *   REPORTED        a window was read and a history printed
 *   NO_SUCH_JOB     the history was read and contained no instance of this job
 *   FETCH_FAILED    the history could not be read at all — nothing was looked at
 *   INTERNAL_ERROR  the annotator itself broke
 *
 * The tokens appear ONLY as the status value, never inside another outcome's prose. The first
 * version explained the empty case as "different from FETCH_FAILED above", which made a grep
 * for that token match a run where the fetch had worked perfectly — the #496 shape, in the
 * script written to stop verdicts being unreadable.
 */
export const STATUS_TOKEN = "VERDICT_STREAK_STATUS";

/** Emit to the job summary when there is one, and always to stdout. */
export function emit(lines, status) {
  const text = [...lines, "", `\`${STATUS_TOKEN}=${status}\``].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  }
}

const gh = (a) =>
  execFileSync("gh", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const job = arg("--job", "live transport");
  const limit = arg("--limit", "20");
  const workflow = arg("--workflow", "e2e.yml");

  let runs;
  try {
    runs = JSON.parse(
      gh([
        "run",
        "list",
        `--workflow=${workflow}`,
        "--branch",
        "main",
        "--limit",
        limit,
        "--json",
        "databaseId,status,createdAt",
      ])
    ).filter((r) => r.status === "completed");
  } catch (e) {
    // FETCH_FAILED, said differently from an empty window on purpose.
    emit(
      [
        `### Verdict history — ${job}`,
        "",
        "**The run history could not be read, so no streak was computed.**",
        "This is NOT a report that nothing was found; nothing was looked at.",
        "",
        `\`\`\`\n${String(e.message ?? e).slice(0, 400)}\n\`\`\``,
      ],
      "FETCH_FAILED"
    );
    return;
  }

  const rows = [];
  for (const r of runs) {
    let jobs;
    try {
      jobs = JSON.parse(
        gh(["run", "view", String(r.databaseId), "--json", "jobs"])
      ).jobs;
    } catch {
      continue; // this run contributes nothing; it is not an UNKNOWN row because we never
      // established the job even ran in it.
    }
    const j = jobs.find((x) => x.name.includes(job));
    if (!j || (j.conclusion !== "failure" && j.conclusion !== "success"))
      continue;

    let verdict = "UNKNOWN";
    try {
      const log = gh([
        "run",
        "view",
        String(r.databaseId),
        "--job",
        String(j.databaseId),
        "--log",
      ]);
      const parsed = parseVerdict(log);
      if (parsed) verdict = parsed.verdict;
    } catch {
      // Log unavailable — expired, too large, or never written. Stays UNKNOWN, which is
      // counted and printed rather than assumed benign.
    }
    rows.push({ conclusion: j.conclusion, verdict });
  }

  if (rows.length === 0) {
    emit(
      [
        `### Verdict history — ${job}`,
        "",
        `**No completed run of \`${job}\` found in the last ${limit} \`main\` runs of ${workflow}.**`,
        "The history WAS read and contained no instance of this job — which is a different",
        "outcome from a history that could not be fetched, and different again from finding",
        "runs whose logs were unreadable. The status token below says which.",
      ],
      "NO_SUCH_JOB"
    );
    return;
  }

  emit(render(tally(rows), { job }), "REPORTED");
}

if (invokedAsProgram(import.meta.url)) {
  try {
    main();
  } catch (e) {
    // "CANNOT BLOCK ANYTHING" IS A PROPERTY OF THIS SCRIPT, NOT OF ITS CALLER.
    //
    // Left to the workflow, the guarantee would be a `continue-on-error:` that anyone could
    // drop in a later edit, and the failure mode would be a bug in the ANNOTATOR appearing as
    // a second, unrelated red on a job that already had a real one — sending whoever
    // investigates it away from the actual defect. So an internal error is caught here and
    // reported as text. It is loud and it is not fatal, which is the correct combination for
    // something that only ever runs on an existing failure.
    emit(
      [
        "### Verdict history",
        "",
        "**The annotator itself failed. This says nothing about the job's own failure, which",
        "stands on its own above.**",
        "",
        "```\n" + String(e && e.stack ? e.stack : e).slice(0, 600) + "\n```",
      ],
      "INTERNAL_ERROR"
    );
  }
}
