#!/usr/bin/env node
/**
 * Measure how often E2E tests flake, and partition the occurrences.
 *
 * #114 reported "E2E — Mocked fails 15% of completed runs". Job conclusions cannot support
 * that claim in either direction, and the reason is in playwright.config.ts: `retries: 1`. A
 * test that fails and then passes is reported FLAKY and THE JOB STILL SUCCEEDS. So counting
 * job failures counts only DOUBLE failures, and the actual incidence lives inside runs that
 * concluded green.
 *
 * Measured with this, over 47 concluded runs of the Mocked job:
 *
 *     job-level failures      1 of 47   (2%)   <- what a conclusions-only count sees
 *     runs with >=1 flaky    16 of 47  (34%)   <- what is actually happening
 *
 * Those are answers to different questions, and the issue's number was the first while its
 * argument was about the second.
 *
 * ── IT READS ONLY THE FLAKY BLOCK, AND THAT IS NOT A DETAIL ───────────────────────────────
 *
 * The first version of this grepped every `[project] › spec.ts:NNN` in the log. On a log
 * reporting 2 flaky tests it extracted 229 IDENTITIES — because the reporter also names every
 * test that merely ran, plus retries, plus the failure section. A pattern answering a broader
 * question than the one asked, which is the defect this repository keeps finding; here it
 * would have produced a partition in which everything looks equally implicated.
 *
 * So this locates `##[notice] N flaky` and reads until the next summary line, and its selftest
 * pins exactly that case: a log with many tests and two flaky ones must yield two.
 *
 * ── ALWAYS PRINTS ITS DENOMINATOR ─────────────────────────────────────────────────────────
 *
 * Cancelled and in-progress runs are excluded and never counted as passes, and the count of
 * what was excluded is printed beside the rate. A rate over an unstated denominator describes
 * the reporting fraction as much as the thing being measured.
 *
 * NOT WIRED INTO checks.json: it needs the network and a `gh` token, so as a gate it would
 * fail for reasons unrelated to the property. It is a measuring instrument, run by hand.
 *
 * Usage:
 *   node scripts/measure-e2e-flake.mjs [--job "E2E — Mocked"] [--limit 60]
 */
import { execFileSync } from "node:child_process";

import { invokedAsProgram } from "./lib/is-main.mjs";
const argOf = (f, d) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/**
 * The tests named inside a run log's flaky block, and nothing else.
 *
 * Exported so the selftest can drive it over a synthetic log containing many tests — which is
 * the only way to show it counts the flaky ones rather than all of them.
 */
export function parseFlakyBlock(log) {
  const lines = log.split("\n");
  const start = lines.findIndex((l) => /##\[notice\]\s+\d+ flaky/.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/\d+ (skipped|passed|failed)\b/.test(line)) break;
    const m = line.match(/\[([\w-]+)\] › (e2e\/[^\s]+\.spec\.ts:\d+)/);
    if (m) out.push({ project: m[1], test: m[2] });
  }
  return out;
}

/**
 * Occurrences ABSORBED BY THE WAIT, which Playwright no longer reports at all.
 *
 * #675's remedy makes `expectApprovalCard` extend once when the stream is still
 * in flight at the base deadline. That converts an occurrence from a `flaky`
 * into a PASS — and `parseFlakyBlock` above reads the flaky block, so without
 * this the rate the whole issue rests on would silently go to zero and look
 * like a cure.
 *
 * Suppressing the symptom while keeping the measurement is the bargain. This is
 * the second half of it; the marker is emitted on stdout by the helper.
 *
 * DELIBERATELY A SEPARATE PARTITION, never summed into `flaky occurrences`.
 * They answer different questions — "how often did a test have to be retried"
 * and "how often did a wait have to be extended" — and adding them would make a
 * single number that means neither.
 *
 * The identity is emitted in the reporter's own `[project] › file:line` shape so
 * the two partitions are comparable row for row.
 */
export function parseExtensionMarkers(log) {
  const out = [];
  for (const line of log.split("\n")) {
    if (!line.includes("[#675-EXTENSION]")) continue;
    // Only the OPENING marker. The helper logs a second line when the card
    // lands, and counting both would double every occurrence.
    if (line.includes("card appeared during the extension")) continue;
    const m = line.match(/\[([\w-]+)\] › (e2e\/[^\s]+\.spec\.ts:\d+)/);
    if (m) out.push({ project: m[1], test: m[2] });
  }
  return out;
}

/** How many flaky tests the log SAYS there are, so the parse can be checked against it. */
export function declaredFlakyCount(log) {
  const m = log.match(/##\[notice\]\s+(\d+) flaky/);
  return m ? Number(m[1]) : 0;
}

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

function main() {
  const jobPrefix = argOf("--job", "E2E — Mocked");
  const limit = argOf("--limit", "60");

  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow=e2e.yml",
      "--limit",
      limit,
      "--json",
      "databaseId,status,conclusion,headBranch,event",
    ])
  );
  const completed = runs.filter((r) => r.status === "completed");

  const rows = [];
  /** Occurrences the wait absorbed — see parseExtensionMarkers. */
  const absorbed = [];
  let concluded = 0,
    jobFailures = 0,
    mismatches = 0;
  for (const r of completed) {
    let jobs;
    try {
      jobs = JSON.parse(
        gh(["run", "view", String(r.databaseId), "--json", "jobs"])
      ).jobs;
    } catch {
      continue;
    }
    const job = jobs.find((j) => j.name.startsWith(jobPrefix));
    if (!job || !["success", "failure"].includes(job.conclusion)) continue;
    concluded++;
    if (job.conclusion === "failure") jobFailures++;
    let log = "";
    try {
      log = gh(["run", "view", `--job=${job.databaseId}`, "--log"]);
    } catch {
      continue;
    }
    const found = parseFlakyBlock(log);
    const declared = declaredFlakyCount(log);
    for (const e of parseExtensionMarkers(log))
      absorbed.push({ run: r.databaseId, branch: r.headBranch, ...e });
    // THE PARSE IS CHECKED AGAINST THE LOG'S OWN COUNT. If they disagree the reporter's format
    // changed and every partition below is over a subject this no longer reads correctly.
    if (found.length !== declared) mismatches++;
    for (const f of found)
      rows.push({ run: r.databaseId, branch: r.headBranch, ...f });
  }

  if (concluded === 0) {
    console.error(
      `FAIL: no run of "${jobPrefix}" reached success/failure in the last ${limit}.\n` +
        `      Nothing to measure — which is not the same as nothing flaking.`
    );
    process.exit(2);
  }
  if (mismatches > 0) {
    console.error(
      `FAIL: on ${mismatches} run(s) the flaky block did not parse to the count the log declares.\n` +
        `      The reporter's format has changed; the partition below would be over a subject\n` +
        `      this no longer reads correctly.`
    );
    process.exit(2);
  }

  const withFlake = new Set(rows.map((r) => r.run)).size;
  console.log(
    `job "${jobPrefix}" over the last ${limit} workflow runs:\n` +
      `  ${completed.length} completed, ${concluded} reached success/failure for this job ` +
      `(the rest cancelled or unrecorded, excluded, never counted as passes)\n` +
      `  job-level failures : ${jobFailures}/${concluded}  ${(
        (100 * jobFailures) /
        concluded
      ).toFixed(0)}%  ` +
      `— counts only tests that failed BOTH attempts\n` +
      `  runs with >=1 flaky: ${withFlake}/${concluded}  ${(
        (100 * withFlake) /
        concluded
      ).toFixed(0)}%  ` +
      `— what retries hide from the conclusion\n` +
      `  flaky occurrences  : ${rows.length}\n` +
      `  absorbed by a wait : ${absorbed.length} in ` +
      `${new Set(absorbed.map((r) => r.run)).size}/${concluded} run(s)  ` +
      `— #675 extensions; these are PASSES and appear in no flaky block`
  );

  if (absorbed.length) {
    console.log(`\n  absorbed occurrences (#675-EXTENSION), by test:`);
    const c = new Map();
    for (const r of absorbed) {
      const k = `${r.project} ${r.test}`;
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...c].sort((a, b) => b[1] - a[1]))
      console.log(`    ${String(k).padEnd(52)} ${n}`);
  }

  const by = (key) => {
    const c = new Map();
    for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]);
  };
  for (const [label, key] of [
    ["by project", (r) => r.project],
    ["by file", (r) => r.test.split(":")[0]],
    ["by test", (r) => `${r.project} ${r.test}`],
  ]) {
    console.log(`\n  ${label}:`);
    for (const [k, n] of by(key))
      console.log(`    ${String(k).padEnd(52)} ${n}`);
  }
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
