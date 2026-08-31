#!/usr/bin/env node
/**
 * Property measured, not asserted: HOW LONG DOES A RED SURVIVE ON A JOB NOBODY WATCHES.
 *
 * Three jobs in this repo run only on push to main and are deliberately outside the 32
 * required contexts, so they never appear on a pull request and never block a merge:
 *
 *     E2E — open-swe live transport (push to main only)
 *     E2E — Real LLM (push to main only)
 *     Config — a model API key is configured
 *
 * `assert-required-contexts-match-jobs.mjs` already names that set from the other direction —
 * "3 job(s) deliberately not required, each still push-only" — so the list here is
 * cross-checked rather than hand-maintained.
 *
 * #400's thesis is that a job failing INTERMITTENTLY on upstream capacity is camouflage for
 * one that is failing PERMANENTLY for a real reason, because on a dashboard they look
 * identical. #530 is that thesis realised: `live transport` was red for 34 CONSECUTIVE RUNS
 * before anyone looked. The two need opposite responses, and the number that separates them is
 * not the failure rate — it is the STREAK.
 *
 * ── THREE NUMBERS, AND EACH ANSWERS A DIFFERENT QUESTION ──────────────────────────────────
 *
 *   reporting fraction   how many runs concluded at all. Cancelled and in-progress runs are
 *                        excluded and NEVER counted as passes: a rate over a set that includes
 *                        them describes the reporting fraction as much as the failure.
 *   failure rate         of the runs that concluded. Says how often, says nothing about how
 *                        long.
 *   longest streak       consecutive failures with no green between them. THIS is what
 *                        distinguishes a flaky job from a broken one, and it is the number
 *                        nobody had.
 *
 * A 33%-flaky job and a permanently-red job can share a failure rate over a short window and
 * need opposite responses — notify-on-transition for the first, and for the second, either
 * make it block or delete it. #400's argument only holds for the first.
 *
 * NOT WIRED INTO checks.json: it needs the network and a `gh` token, so as a gate it would
 * fail for reasons unrelated to the property. It is a measuring instrument, run by hand.
 *
 * Usage: node scripts/measure-push-only-jobs.mjs [--limit 80]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Longest and current runs of `failure`, over conclusions in NEWEST-FIRST order.
 *
 * Cancelled and in-progress runs BREAK NOTHING: a streak of reds interrupted by a cancelled
 * run is still an unbroken red as far as anyone watching is concerned, because a cancelled run
 * reports no verdict either way. Only a `success` ends a streak. Treating a cancellation as a
 * break would silently halve the streaks in a repo where 13 of 60 runs do not conclude.
 */
export function streaks(conclusions) {
  let longest = 0, current = 0, run = 0, seenGreen = false, ended = false;
  for (const c of conclusions) {
    if (c === "failure") {
      run++;
      if (!ended) current = run;
    } else if (c === "success") {
      longest = Math.max(longest, run);
      run = 0;
      ended = true;
      seenGreen = true;
    }
    // anything else (cancelled, skipped, null) neither extends nor breaks
  }
  longest = Math.max(longest, run);
  return { longest, current, everGreen: seenGreen };
}

export function summarise(rows) {
  const concluded = rows.filter((r) => r.conclusion === "success" || r.conclusion === "failure");
  const failures = concluded.filter((r) => r.conclusion === "failure").length;
  const s = streaks(rows.map((r) => r.conclusion));
  return {
    seen: rows.length,
    concluded: concluded.length,
    failures,
    rate: concluded.length ? failures / concluded.length : null,
    ...s,
    currentSpanHours:
      s.current > 0 && rows.length
        ? (Date.parse(rows[0].at) - Date.parse(rows[Math.min(s.current, rows.length) - 1].at)) / 3.6e6
        : 0,
  };
}

const gh = (a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function main() {
  const i = process.argv.indexOf("--limit");
  const limit = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "80";
  const runs = JSON.parse(
    gh(["run", "list", "--workflow=e2e.yml", "--branch", "main", "--limit", limit,
        "--json", "databaseId,status,createdAt,headSha"])
  ).filter((r) => r.status === "completed");

  const byJob = new Map();
  for (const r of runs) {
    let jobs;
    try { jobs = JSON.parse(gh(["run", "view", String(r.databaseId), "--json", "jobs"])).jobs; }
    catch { continue; }
    for (const j of jobs) {
      if (!/push to main only|model API key is configured/.test(j.name)) continue;
      if (!byJob.has(j.name)) byJob.set(j.name, []);
      byJob.get(j.name).push({ conclusion: j.conclusion, at: r.createdAt, sha: r.headSha.slice(0, 8) });
    }
  }

  if (byJob.size === 0) {
    console.error(
      `FAIL: found no push-only job in the last ${limit} main runs of e2e.yml.\n` +
        `      This measures those jobs, so an empty set means it COULD NOT COMPUTE the\n` +
        `      property — not that nothing is red.`
    );
    process.exit(2);
  }

  console.log(`push-only jobs on main, over the last ${runs.length} completed e2e runs:\n`);
  for (const [name, rows] of byJob) {
    const s = summarise(rows);
    const rate = s.rate === null ? "n/a" : `${(100 * s.rate).toFixed(0)}%`;
    console.log(`  ${name}`);
    console.log(
      `    seen ${s.seen}, concluded ${s.concluded} (the rest cancelled or unrecorded — excluded, never counted as passes)`
    );
    console.log(`    failure rate      ${String(s.failures).padStart(3)}/${s.concluded}  ${rate}   — how OFTEN`);
    console.log(
      `    longest red streak ${String(s.longest).padStart(2)} consecutive        — how LONG, and the number that separates` +
        `\n                          flaky from broken`
    );
    console.log(
      `    current streak     ${String(s.current).padStart(2)}${s.current ? ` (about ${s.currentSpanHours.toFixed(1)}h unnoticed)` : ""}` +
        `${s.everGreen ? "" : "   — NEVER GREEN in this window"}`
    );
    console.log();
  }
  console.log(
    `Both numbers are real and they answer different questions. A job failing a third of the\n` +
      `time and one solidly red for two days look identical on a dashboard; the streak is what\n` +
      `tells them apart, and #400's argument only holds for the first.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
