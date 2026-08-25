#!/usr/bin/env node
/**
 * matrix.selftest.mjs — prove the matrix generator cannot silently emit the wrong shape.
 *
 * matrix.mjs decides how many severability jobs run. A generator that emitted nothing, or the
 * wrong arity, would produce a GREEN BOARD OVER NO VERIFICATION — the failure this whole issue
 * exists to remove, in the mechanism that removes it. It shipped without a selftest; this is that.
 *
 * Both directions, as always: it must reject manifests it cannot faithfully represent, and it
 * must accept the real one. A generator that refused everything would pass every reject case.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUT = join(ROOT, "scripts", "matrix.mjs");
const REAL = JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8"));
const TMP = mkdtempSync(join(tmpdir(), "matrix-selftest-"));
let pass = 0, fail = 0, n = 0;

function run(manifest) {
  const p = join(TMP, `m${n++}.json`);
  writeFileSync(p, JSON.stringify(manifest, null, 2));
  try {
    return { rc: 0, out: execFileSync("node", [SUT, "--github"], {
      encoding: "utf8", env: { ...process.env, RUNGS_MANIFEST: p }, stdio: ["ignore","pipe","pipe"] }) };
  } catch (e) { return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
const clone = () => JSON.parse(JSON.stringify(REAL));
const check = (name, want, mutate, verify) => {
  const m = clone(); if (mutate) mutate(m);
  const { rc, out } = run(m);
  const okRc = want === "accept" ? rc === 0 : rc !== 0;
  const okExtra = verify ? verify(out) : true;
  if (okRc && okExtra) { console.log(`  ok   ${name.padEnd(52)} (${want}ed)`); pass++; }
  else { console.error(`  FAIL ${name.padEnd(52)} rc=${rc}`); fail++; }
};

console.log("matrix.mjs self-test — the arity is derived, and cannot silently be wrong\n");

// ACCEPT — and the count must actually match the manifest, not merely be non-zero.
check("the real manifest, arity == sum of languages", "accept", null, (out) => {
  const jobs = JSON.parse(out.replace(/^matrix=/, "")).include;
  const expected = REAL.rungs.reduce((a, r) => a + r.languages.length, 0);
  return jobs.length === expected && expected > 0;
});

// A fork emits FEWER jobs — the arity follows the ladder rather than a constant.
check("a 1-rung manifest emits only that rung's jobs", "accept",
  (m) => { m.rungs = m.rungs.slice(0, 1); },
  (out) => {
    const jobs = JSON.parse(out.replace(/^matrix=/, "")).include;
    return jobs.length === REAL.rungs[0].languages.length && jobs.every((j) => j.rung === REAL.rungs[0].id);
  });

// REJECT — a manifest that would produce a green board over nothing.
check("zero rungs is refused, not emitted as an empty matrix", "reject", (m) => { m.rungs = []; });
check("a rung with no languages is refused", "reject", (m) => { m.rungs[0].languages = []; });

// Every job must carry what the workflow needs; a field silently missing would make the job
// eject the wrong rung or verify against the wrong retain set.
check("every job carries rung, lang and a retain set", "accept", null, (out) => {
  const jobs = JSON.parse(out.replace(/^matrix=/, "")).include;
  return jobs.length > 0 && jobs.every((j) => j.rung && j.lang && j.retained &&
    j.retained.split(",").includes(j.rung));
});

const EXPECTED_CASES = 5;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED_CASES) { console.error(`FAIL: ran ${total}, expected ${EXPECTED_CASES} — harness broken.`); process.exit(1); }
if (fail) { console.error(`FAIL: ${fail}/${total} wrong. matrix.mjs is NOT trustworthy.`); process.exit(1); }
console.log(`PASS: ${pass}/${total}. Arity follows the manifest, a fork emits fewer jobs, and a`);
console.log(`      manifest that would yield an empty matrix is refused rather than emitted.`);
