#!/usr/bin/env node
/**
 * "Job X passes on main" — computed over runs that actually reported.
 *
 * #115. A cancelled run reports NO VERDICT. Not a weak pass, not a partial one:
 * the absence of a measurement. Yet a run history renders cancellation as a
 * grey icon that reads closer to "fine" than to "unknown", so a channel where
 * half the runs are cancelled looks indistinguishable from a healthy one.
 *
 * That is how a 15% failure rate on `E2E — Mocked` went unnoticed: 47% of
 * main's runs were cancelled, main completed only 7 runs in the sampled window,
 * and one failure among grey icons reads as noise.
 *
 * THE RULE THIS ENFORCES: cancellations are excluded from the DENOMINATOR, not
 * counted as passes. A pass rate over a denominator that includes them is not a
 * weaker claim than the honest one — it is a different claim, about a quantity
 * nobody wants to know.
 *
 * It also reports the cancellation rate separately, because that number is the
 * one that says how much of the board is uncomputed. A high pass rate over a
 * tiny completed set is not reassuring, and printing only the first hides it.
 *
 * Usage:  node scripts/ci-completion.mjs [--branch main] [--limit 40] [--workflow e2e.yml]
 */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const branch = arg("branch", "main");
const limit = Number(arg("limit", "40"));
const workflow = arg("workflow", null);

// A completed run has a verdict. Everything else is a run that did not report,
// and the two must never be summed.
const REPORTED = new Set(["success", "failure", "timed_out"]);
const SILENT = new Set([
  "cancelled",
  "skipped",
  "startup_failure",
  "action_required",
  "stale",
  "neutral",
]);

let runs;
try {
  const cmd = [
    "run",
    "list",
    "--branch",
    branch,
    "--limit",
    String(limit),
    "--json",
    "databaseId,conclusion,status,workflowName,headSha,createdAt",
  ];
  if (workflow) cmd.push("--workflow", workflow);
  runs = JSON.parse(execFileSync("gh", cmd, { encoding: "utf8" }));
} catch (e) {
  console.error(`FAILED to query run history: ${e.message.split("\n")[0]}`);
  console.error(
    "This reports nothing rather than reporting a rate it could not compute."
  );
  process.exit(2);
}

if (!runs.length) {
  console.error(`REFUSING TO REPORT: 0 runs returned for branch "${branch}".`);
  console.error(
    "An empty sample yields 0/0, and a rate over nothing is not a rate."
  );
  process.exit(2);
}

const byWorkflow = new Map();
for (const r of runs) {
  const key = r.workflowName ?? "(unnamed)";
  if (!byWorkflow.has(key))
    byWorkflow.set(key, {
      reported: 0,
      silent: 0,
      failed: 0,
      running: 0,
      examples: [],
    });
  const g = byWorkflow.get(key);
  if (r.status !== "completed") {
    g.running++;
    continue;
  }
  const c = r.conclusion;
  if (REPORTED.has(c)) {
    g.reported++;
    if (c !== "success") {
      g.failed++;
      g.examples.push(`${r.databaseId} ${c} ${r.headSha.slice(0, 7)}`);
    }
  } else if (SILENT.has(c)) {
    g.silent++;
  } else {
    // An unrecognised conclusion must not be silently bucketed as a pass.
    g.silent++;
  }
}

const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
let worstSilence = 0;

console.log(
  `branch "${branch}", last ${runs.length} runs${
    workflow ? ` of ${workflow}` : ""
  }\n`
);
for (const [name, g] of [...byWorkflow].sort(
  (a, b) => b[1].silent - a[1].silent
)) {
  const total = g.reported + g.silent;
  const silentPct = total === 0 ? 0 : g.silent / total;
  worstSilence = Math.max(worstSilence, silentPct);
  console.log(`  ${name}`);
  console.log(
    `    pass rate      ${pct(g.reported - g.failed, g.reported)} ` +
      `(${g.reported - g.failed}/${g.reported} runs that REPORTED)`
  );
  console.log(
    `    uncomputed     ${pct(g.silent, total)} ` +
      `(${g.silent} of ${total} reported nothing)${
        g.running ? `, ${g.running} still running` : ""
      }`
  );
  for (const ex of g.examples.slice(0, 3))
    console.log(`    failure        ${ex}`);
  console.log();
}

// The point of the issue: a board mostly built from non-measurements should say
// so loudly rather than render as a healthy-looking pass rate.
if (worstSilence >= 0.25) {
  console.error(
    `WARNING: up to ${Math.round(
      worstSilence * 100
    )}% of runs on "${branch}" reported no verdict.\n` +
      `Any "passes on ${branch}" claim covers only the completed remainder.`
  );
  process.exit(1);
}
console.log(
  `Every workflow on "${branch}" reported a verdict in at least 75% of runs.`
);
