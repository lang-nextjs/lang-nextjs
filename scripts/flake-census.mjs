#!/usr/bin/env node
/**
 * flake-census.mjs — a flake census that NAMES THE SPEC, over runs whose greens hid it (#918).
 *
 * WHY A COUNT IS NOT ENOUGH, measured rather than supposed. On 2026-09-07 the flaky COUNT
 * across four consecutive main runs read 1, 2, 1, 1 — no signal — while the spec identity
 * moved from `open-swe-queue-polling.spec.ts:190` to `:153` exactly at `e4d168f7`, the merge
 * that introduced the regression. A long-known webkit flake and a brand-new ordering defect
 * are both "1". The identity is the whole signal, and it is already in the log.
 *
 * TWO PRODUCERS WRITE IT AND NEITHER IS SUFFICIENT ALONE. This is the load-bearing fact
 * about the instrument and it was established by reading both, not by reasoning:
 *
 *     playwright's list reporter  prints `  N flaky` and the spec titles beneath it,
 *                                and prints NOTHING AT ALL when N is 0
 *     summarise-flaky.mjs (#777)  prints `SUBJECT: N flaky test(s) …` ALWAYS, including 0
 *
 * So the names come from Playwright and the DISTINGUISHABLE ZERO comes from #777. Reading
 * only Playwright makes "no flakes" and "the job never ran" the same empty answer, which is
 * the exact downgrade #777 exists to prevent — its own output says the line exists "so that
 * a run with no flakes is distinguishable from a run where the report could not be read".
 * A census that lost that would be worse than the count it replaces.
 *
 * THE PATTERN IS ANCHORED TO THE PRODUCER, NOT THE SUBSTRING. Both producers write the text
 * "N flaky" into the SAME log, so `\d+ flaky` cannot tell them apart — it matched
 * `SUBJECT: 1 flaky test(s)` and returned no spec names at all. `^\s*\d+ flaky\s*$` selects
 * Playwright's summary line and nothing else. The selftest asserts that negative directly,
 * because an anchor whose purpose is invisible gets simplified away later.
 *
 * THREE STATES, AND THE BOUNDARY IS DECIDED BY `conclusion` RATHER THAN `status`. That is not
 * a detail: A CANCELLED RUN HAS `status: "completed"`. Measured live, 100 runs on main —
 * `cancelled` 20, `failure` 59, `success` 20, all `status: "completed"`; only an in-progress
 * run is not. So a `status !== "completed"` test catches QUEUED and IN_PROGRESS and never a
 * cancellation, and an earlier version of this file tested exactly that while its comment
 * claimed it caught cancellations.
 *
 * WHY IT MATTERS RATHER THAN BEING A TYPO. A cancelled run would have fallen through to the log
 * read, found no SUBJECT line because the step was killed, and landed in `no-reading` labelled
 * "the summariser refused or never ran" — a bucket at roughly a fifth of the population,
 * dominated by something its own label denies. Someone reading a high count there would go
 * looking for a broken summariser, correctly, and find nothing.
 *
 *     counted      a reading, including a SAID zero
 *     expected     no reading and none was possible — cancelled, still running, or no job.
 *                  Carries the REASON, because "cancelled" and "no job" are different facts
 *     unreadable   a COMPLETED, NON-CANCELLED run whose job produced no SUBJECT line. This is
 *                  the alarming one and it is now the only thing in it
 *
 * Both non-counted states are excluded from any denominator. Deciding `expected` by
 * `conclusion` also stops one event splitting across two buckets by timing — a run cancelled
 * before its job existed and one cancelled after it started are the same fact.
 *
 * Exit: 0 it looked · 2 it could not look
 */
import { spawnSync } from "node:child_process";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

/** Playwright's own summary line. NOT `\d+ flaky` — see the anchoring note above. */
const PW_FLAKY = /^\s*(\d+) flaky\s*$/;
/** #777's line, the only producer that reports a zero. */
const SUBJECT_FLAKY = /SUBJECT:\s*(\d+) flaky test\(s\)/;
/** A spec title in Playwright's list output: `[project] › path:line:col › title`. */
const SPEC_TITLE = /›\s*([^\s›]+\.spec\.ts:\d+:\d+)/;
/** Playwright's totals lines, which end the flaky block. */
const BLOCK_END = /^\s*\d+ (skipped|passed|failed|did not run)/;

/** GitHub log lines carry an ISO timestamp and often a job/step prefix; strip to the payload. */
export function stripLogPrefix(line) {
  return line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, "");
}

/**
 * What one job log says about flakes.
 *
 * @returns {{state: string, count: number|null, specs: string[], disagreement: string|null}}
 */
export function readFlakeReport(logText) {
  const lines = String(logText ?? "")
    .split("\n")
    .map(stripLogPrefix);

  const subjectLine = lines.find((l) => SUBJECT_FLAKY.test(l));
  if (!subjectLine) {
    /*
     * NOT ZERO. The summariser always prints its line, so its absence means the job did not
     * reach that step or the step produced nothing — and reporting that as 0 would be the
     * blindness this census exists to remove.
     */
    return { state: "unreadable", count: null, specs: [], disagreement: null };
  }
  const count = Number(SUBJECT_FLAKY.exec(subjectLine)[1]);

  const specs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!PW_FLAKY.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (BLOCK_END.test(lines[j])) break;
      const m = SPEC_TITLE.exec(lines[j]);
      if (m) specs.push(m[1]);
    }
  }

  /*
   * The two producers are independent readings of one run, so they are a free control on each
   * other. Disagreement is REPORTED rather than resolved: picking a winner would hide exactly
   * the case where one of them is broken.
   */
  const unique = [...new Set(specs)];
  const disagreement =
    count !== unique.length
      ? `#777 counted ${count}, Playwright named ${unique.length}`
      : null;

  /*
   * A DISAGREEMENT MAKES THE SPEC SET PARTIAL, AND THE DELTA MUST KNOW. If #777 counted more
   * than Playwright's block named, at least one name is missing from `specs` — and against the
   * previous run a missing name reads as a spec that STOPPED flaking. That is a false MOVE, in
   * the exact field this census exists to report.
   */
  return {
    state: "counted",
    count,
    specs: unique,
    disagreement,
    partial: disagreement !== null,
  };
}

/*
 * THE MOVE IS THE SIGNAL, SO IT IS PRINTED RATHER THAN LEFT TO THE EYE. The argument for this
 * census is that the COUNT could not see #1012's regression — 1, 2, 1, 1 across four runs, no
 * step change — while the identity moved open-swe-queue-polling.spec.ts:190 -> :153 at the
 * merge. Listing names per row CARRIES that; it does not REPORT it, and a reader scanning a
 * column for a substitution is the instrument this exists to replace.
 *
 * A PARTIAL ROW SUPPRESSES THE "departed" DIRECTION ONLY. A name present is present, so an
 * arrival is trustworthy either way; a name ABSENT from a known-incomplete set may simply not
 * have been parsed, and reporting that as a departure would MANUFACTURE the move.
 */
export function specDelta(all) {
  /*
   * THE SPAN MAY SKIP RUNS, AND IT SAYS SO. Only `counted` rows can be compared, so two shas
   * printed `from -> to` are consecutive READINGS and not necessarily consecutive commits —
   * there may be cancelled, in-progress or unreadable runs between them. Skipping the gap is
   * right, because refusing to compare across it would lose the signal entirely; printing two
   * bare shas is not, because it invites attributing the move to the later one when it could
   * have happened at any run in between. So the count of skipped runs travels with the span.
   */
  const chron = [...all].reverse();
  const out = [];
  let prev = null;
  let skipped = 0;
  for (const cur of chron) {
    if (cur.state !== "counted") {
      if (prev) skipped += 1;
      continue;
    }
    if (!prev) {
      prev = cur;
      continue;
    }
    const before = new Set(prev.specs);
    const after = new Set(cur.specs);
    const arrived = [...after].filter((x) => !before.has(x));
    const departed = [...before].filter((x) => !after.has(x));
    const blind = Boolean(prev.partial || cur.partial);
    if (arrived.length || departed.length) {
      out.push({
        from: prev.sha,
        to: cur.sha,
        skipped,
        arrived,
        departed: blind ? [] : departed,
        suppressed: blind && departed.length > 0,
      });
    }
    prev = cur;
    skipped = 0;
  }
  return out;
}

/**
 * WHY NO READING IS POSSIBLE, or null when one should be — decided by `conclusion`, which NAMES
 * the outcome, rather than by `status`, which does not.
 *
 * A CANCELLED RUN HAS `status: "completed"`. Measured live over 100 runs on main: cancelled 20,
 * failure 59, success 20 — all `completed`; only an in-progress run is not. An earlier version
 * of this file tested `status !== "completed"` while its comment claimed that caught
 * cancellations. It caught QUEUED and IN_PROGRESS and none of them, so every cancelled run fell
 * through to the log read, found no SUBJECT line because the step had been killed, and landed in
 * `unreadable` — a bucket labelled "the summariser refused or never ran", at roughly a fifth of
 * the population, dominated by something its own label denies. A reader investigating a high
 * count there would look for a broken summariser and find nothing.
 *
 * Deciding here also stops ONE EVENT SPLITTING ACROSS TWO BUCKETS BY TIMING: a run cancelled
 * before its job existed and one cancelled after it started are the same fact, and only the
 * `conclusion` test sees them as one.
 */
export function noReadingExpected(run, jobs, jobPattern) {
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.status !== "completed") return `still ${run.status}`;
  /*
   * TAKES THE LIST, NOT A JOB, SO "no match" CANNOT BE CONFUSED WITH "never read" (#1042).
   *
   * The first version took a `job` and returned "no matching job" when it was undefined —
   * which is what a caller passes both when the listing was read and contained no match AND
   * when the listing could not be fetched at all. A failed jobs call therefore printed a row
   * asserting the job DOES NOT EXIST, and put it in the bucket excluded from the denominator
   * as legitimately having nothing to read. An outage would have shrunk the readable
   * population invisibly — the retry blindness this census exists to remove, reappearing
   * inside it, on the one call that runs once PER RUN rather than once per window.
   *
   * Taking the array makes the ambiguity unrepresentable: a caller with no list cannot reach
   * this function, and has to say what went wrong instead.
   */
  if (!Array.isArray(jobs))
    throw new TypeError(
      "noReadingExpected needs the job LIST — an unread listing is not an absent job"
    );
  if (!jobs.some((j) => j.name.includes(jobPattern))) return "no matching job";
  return null;
}

/**
 * `gh` as data, or null when the call failed — a failure is not an empty set.
 *
 * TWO THINGS HERE WERE WRONG ON THE FIRST LIVE RUN AND COULD NOT HAVE BEEN WRONG BEFORE IT.
 *
 * `maxBuffer` — spawnSync defaults to 1 MiB and ONE PAGE OF WORKFLOW RUNS IS 1,052,104 BYTES.
 * So the very first API call this makes overflows by 3 KB, spawnSync sets `status` to null
 * rather than a number, and the census refused before reading anything. Every proof it had
 * passed — fixtures and four captured job logs — used input somebody already had on disk. The
 * population query is the one thing no local proof could exercise, and it is the one that
 * failed. A job log is larger still, so this is not a margin, it is a floor.
 *
 * AND ENOBUFS DOES NOT RELIABLY TRUNCATE, WHICH IS WHY REFUSING ON `r.error` IS THE
 * CONSERVATIVE READING RATHER THAN THE OBVIOUS ONE. Driven, this Node:
 *
 *     maxBuffer=1024 against 5000 bytes  ->  error=ENOBUFS  status=null  stdout.length=5000
 *
 * The output came back COMPLETE with the error set. So reading `r.stdout` when `r.error` is
 * present would SOMETIMES work — which is the worst property a shortcut can have, because it
 * rewards the shortcut most of the time and fails silently the rest. The next person will see
 * complete-looking output beside an error and be tempted; this comment exists for them. We
 * cannot tell a complete overflow from a truncated one, so we refuse and say why.
 *
 * `reason` — the old version returned null and the caller printed "could not list runs" with no
 * cause. That refusal was honest and undiagnostic: it took a separate probe to learn the word
 * ENOBUFS. An instrument that reports failure without saying what failed makes its own next
 * repair a research task, which is the defect this whole census exists to argue against.
 */
function gh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, reason: String(r.error.message ?? r.error) };
  if (r.status !== 0)
    return {
      ok: false,
      reason: `gh exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}`,
    };
  return { ok: true, stdout: r.stdout };
}

function refuse(what, reason) {
  console.error(`REFUSE: ${what}`);
  if (reason) console.error(`        ${reason}`);
  console.error(
    "        Nothing was read, which is not the same as nothing being there."
  );
  process.exit(2);
}

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function main() {
  const workflow = argValue("--workflow", "e2e.yml");
  const branch = argValue("--branch", "main");
  const since = argValue("--since", "");
  const jobPattern = argValue("--job", "Mocked");

  /*
   * THE POPULATION COMES FROM THE API, NOT FROM A LISTING. A `head` or a `--limit` downstream
   * of the fetch is invisible to any bound-check at the fetch layer — that is how an earlier
   * reading of this census reported seven runs as the population when there were fifteen.
   */
  const raw = gh([
    "api",
    `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?branch=${branch}&per_page=100`,
  ]);
  if (!raw.ok)
    refuse(`could not list runs for ${workflow} on ${branch}.`, raw.reason);

  let payload;
  try {
    payload = JSON.parse(raw.stdout);
  } catch {
    refuse("the runs listing was not JSON.");
  }
  const runs = payload.workflow_runs ?? [];
  if (!runs.length) refuse("the runs listing was empty.");

  /*
   * A WINDOWED QUERY NEEDS A DIFFERENT COMPLETENESS TEST THAN A WHOLE-SET ONE.
   * `total_count === returned` is the wrong assertion here — it reads 509 against 100 and says
   * nothing about the window. What matters is that the page reaches PAST the window's far
   * edge, so nothing inside it was left on a page this did not fetch.
   */
  const oldest = runs[runs.length - 1].created_at;
  if (since && oldest > since) {
    refuse(
      `the fetched page reaches back only to ${oldest}, which is inside the requested ` +
        `window starting ${since}. Runs before that are on a page this did not fetch.`
    );
  }

  const inWindow = since
    ? runs.filter((r) => r.created_at > since)
    : runs.slice(0, 20);

  const rows = [];
  for (const run of inWindow) {
    const jobsRaw = gh([
      "api",
      `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
    ]);
    if (!jobsRaw.ok) {
      rows.push({
        sha: run.head_sha.slice(0, 8),
        state: "unreadable",
        reason: `the jobs listing could not be fetched — ${jobsRaw.reason}`,
        specs: [],
      });
      continue;
    }
    let jobs;
    try {
      jobs = JSON.parse(jobsRaw.stdout).jobs ?? [];
    } catch (e) {
      rows.push({
        sha: run.head_sha.slice(0, 8),
        state: "unreadable",
        reason: `the jobs listing was not JSON — ${e.message}`,
        specs: [],
      });
      continue;
    }
    const job = jobs.find((j) => j.name.includes(jobPattern));
    const expected = noReadingExpected(run, jobs, jobPattern);
    if (expected) {
      rows.push({
        sha: run.head_sha.slice(0, 8),
        state: "expected",
        reason: expected,
        specs: [],
      });
      continue;
    }
    const log = gh(["run", "view", "--job", String(job.id), "--log"]);
    if (!log.ok) {
      rows.push({
        sha: run.head_sha.slice(0, 8),
        state: "unreadable",
        reason: `the job log could not be fetched — ${log.reason}`,
        specs: [],
      });
      continue;
    }
    rows.push({
      sha: run.head_sha.slice(0, 8),
      ...readFlakeReport(log.stdout),
    });
  }

  const counted = rows.filter((r) => r.state === "counted");
  const unknown = rows.filter((r) => r.state === "unreadable");
  const expectedRows = rows.filter((r) => r.state === "expected");

  console.log(`\nFLAKE CENSUS — ${workflow} on ${branch}\n`);
  for (const r of rows) {
    const head =
      r.state === "counted"
        ? `${r.count} flaky${r.partial ? " (spec set PARTIAL)" : ""}`
        : r.state === "unreadable"
        ? `UNKNOWN — ${r.reason ?? "no SUBJECT line"}, which is not a zero`
        : `no reading expected — ${r.reason}`;
    console.log(`  ${r.sha}  ${head}`);
    for (const s of r.specs ?? []) console.log(`      ${s}`);
    if (r.disagreement) console.log(`      DISAGREEMENT: ${r.disagreement}`);
  }
  const moves = specDelta(rows);
  console.log(`\n  SPEC CHANGES between consecutive readings\n`);
  if (!moves.length)
    console.log("    none — the same specs throughout the window");
  for (const m of moves) {
    console.log(
      `    ${m.from} -> ${m.to}` +
        (m.skipped
          ? `   (${m.skipped} run(s) between them had no reading — the move may have ` +
            `happened at any of them)`
          : "")
    );
    for (const a of m.arrived) console.log(`      + ${a}`);
    for (const d of m.departed) console.log(`      - ${d}`);
    if (m.suppressed)
      console.log(
        "      (departures suppressed: a spec set on one side is PARTIAL, so an absent " +
          "name may be unparsed rather than gone)"
      );
  }

  console.log(
    `\n  ${counted.length} counted · ${unknown.length} unknown · ` +
      `${expectedRows.length} no reading expected` +
      ` — the last two are NOT zeros and belong in no denominator.\n`
  );

  reportSubject(
    counted.length,
    `run(s) with a readable flake reading, out of ${rows.length} in the window`
  );
  process.exit(0);
}

if (invokedAsProgram(import.meta.url)) main();
