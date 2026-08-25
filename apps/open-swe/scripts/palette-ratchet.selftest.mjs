#!/usr/bin/env node
/**
 * The ratchet must measure the same tree however it is invoked.
 *
 * WHY THIS EXISTS. The ratchet shipped with a defect that its five original
 * tests could not see, because all five invoked it the same way: by path, from
 * the repo root. Run through the entry point its own package.json advertises
 * (`pnpm --filter open-swe palette:ratchet`), pnpm set cwd to the package,
 * check-palette resolved "apps/open-swe" against it, found nothing, exited 0,
 * and printed "Down 237 — lower findings to 0". A wrong number is a bad day; a
 * wrong number with a confident instruction to zero the baseline is worse.
 *
 * So the subject of this test is THE INVOCATION PATH, not the script.
 *
 * The non-zero assertion is not padding. Three paths agreeing proves nothing if
 * they agree on zero — that is precisely the broken state. Agreement plus
 * non-zero is the property; agreement alone is satisfied by the bug.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SCRIPT = resolve(HERE, "palette-ratchet.mjs");

const run = (label, cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/(\d+) findings in (\d+) files/);
  return {
    label,
    status: r.status,
    findings: m ? Number(m[1]) : null,
    files: m ? Number(m[2]) : null,
    out,
  };
};

const results = [
  run("node by path, cwd=repo root", process.execPath, [SCRIPT], REPO),
  run(
    "node by path, cwd=apps/open-swe",
    process.execPath,
    [SCRIPT],
    resolve(REPO, "apps/open-swe")
  ),
  run(
    "pnpm --filter (the advertised entry point)",
    "pnpm",
    ["--filter", "open-swe", "palette:ratchet"],
    REPO
  ),
];

let failed = 0;
const fail = (msg) => {
  console.error(`  x ${msg}`);
  failed++;
};

console.log("palette-ratchet selftest — invocation-path invariance\n");
for (const r of results) {
  console.log(
    `  ${r.label}: ${r.findings} findings / ${r.files} files (exit ${r.status})`
  );
}
console.log();

// 1. every path produced a parseable measurement
for (const r of results) {
  if (r.findings === null) fail(`${r.label}: no measurement in output`);
}

// 2. every path agreed
const uniq = new Set(
  results
    .filter((r) => r.findings !== null)
    .map((r) => `${r.findings}/${r.files}`)
);
if (uniq.size > 1) {
  fail(`invocation paths disagree: ${[...uniq].join(" vs ")}`);
  fail("this is the shipped defect — one path is not measuring the repo");
}

// 3. they agreed on something REAL. Without this, the bug passes: 0/0 everywhere
//    is perfect agreement and a completely uncomputed verdict.
for (const r of results) {
  if (r.findings === 0 || r.files === 0) {
    fail(
      `${r.label}: scanned nothing (0 findings / 0 files) — agreement on zero is the bug, not a pass`
    );
  }
}

if (failed) {
  console.error(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log("✔ all invocation paths measure the same non-empty tree.");
