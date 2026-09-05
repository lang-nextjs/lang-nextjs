#!/usr/bin/env node
/**
 * Proves scripts/ci-completion.mjs can FAIL, and refuses to compute — do not remove.
 *
 * The script exists because a cancellation was being read as a pass. A selftest
 * that only fed it healthy data would repeat that mistake one level up: it would
 * confirm the happy path and never establish that the tool notices the thing it
 * was built to notice.
 *
 * Each case installs a stub `gh` on PATH that returns one run history, so the
 * cases are exact rather than dependent on whatever CI happens to look like.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts", "ci-completion.mjs");

function run(runs, { ghFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-completion-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    ghFails
      ? `#!/bin/sh\necho "gh: could not resolve host" >&2\nexit 1\n`
      : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(runs)}\nJSON\n`
  );
  chmodSync(gh, 0o755);
  try {
    const out = execFileSync("node", [SCRIPT, "--branch", "main"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    rmSync(dir, { recursive: true, force: true });
    return { code: 0, out };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const mk = (conclusion, i) => ({
  databaseId: 1000 + i,
  conclusion,
  status: "completed",
  workflowName: "E2E",
  headSha: "abcdef1234",
  createdAt: "2026-08-29T00:00:00Z",
});

const cases = [
  {
    name: "ALL-CANCELLED   4 cancelled runs must not read as a healthy board",
    run: () =>
      run(["cancelled", "cancelled", "cancelled", "cancelled"].map(mk)),
    expect: (r) =>
      r.code === 1 &&
      /100% of runs.*reported no verdict|uncomputed\s+100%/.test(r.out),
  },
  {
    name: "NOT-A-PASS      1 success + 3 cancelled is 1/1 reported, not 4/4",
    run: () =>
      run([
        mk("success", 0),
        ...["cancelled", "cancelled", "cancelled"].map(mk),
      ]),
    expect: (r) =>
      r.code === 1 &&
      /\(1\/1 runs that REPORTED\)/.test(r.out) &&
      /uncomputed\s+75%/.test(r.out),
  },
  {
    name: "FAILURE-NAMED   a real failure is surfaced with its run id",
    run: () =>
      run([
        mk("success", 0),
        mk("failure", 1),
        mk("success", 2),
        mk("success", 3),
      ]),
    expect: (r) => /failure\s+1001 failure/.test(r.out),
  },
  {
    name: "UNKNOWN-CONCL   an unrecognised conclusion is NOT bucketed as a pass",
    run: () =>
      run(
        [
          "success",
          "some_new_github_state",
          "some_new_github_state",
          "some_new_github_state",
        ].map(mk)
      ),
    expect: (r) => r.code === 1 && /\(1\/1 runs that REPORTED\)/.test(r.out),
  },
  {
    name: "VACUOUS-EMPTY   zero runs must REFUSE, not report 0%",
    run: () => run([]),
    expect: (r) => r.code === 2 && /REFUSING TO REPORT: 0 runs/.test(r.out),
  },
  {
    name: "VACUOUS-GHFAIL  an unreachable gh must REFUSE, not report",
    run: () => run([], { ghFails: true }),
    expect: (r) => r.code === 2 && /FAILED to query run history/.test(r.out),
  },
  {
    name: "HEALTHY         all reported and green exits clean",
    run: () => run([0, 1, 2, 3].map((i) => mk("success", i))),
    expect: (r) => r.code === 0 && /at least 75% of runs/.test(r.out),
  },
];

let pass = 0;
for (const c of cases) {
  const r = c.run();
  const ok = c.expect(r);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${c.name}`);
  if (!ok)
    console.log(
      `        exit=${r.code}\n        ${r.out
        .trim()
        .split("\n")
        .join("\n        ")}`
    );
  if (ok) pass++;
}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${
    cases.length
  }. The tool refuses an\n` +
    `      all-cancelled board, never counts a cancellation toward a pass rate,\n` +
    `      names the failures it found, treats an unknown conclusion as silence\n` +
    `      rather than success, and declines to compute over nothing.`
);
process.exit(pass === cases.length ? 0 : 1);
