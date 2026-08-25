#!/usr/bin/env node
/**
 * Proof that mutation-proof.mjs itself behaves — a harness for proofs is only
 * worth having if it has been observed making each of its own verdicts.
 *
 * Uses a SYNTHETIC fixture and a synthetic checker rather than any real one, so
 * these cases stay valid when every real checker changes.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProofRunner, fingerprint, artifactContains } from "./mutation-proof.mjs";

// A fixture with one file. The synthetic checker REJECTS when it says "bad".
function makeFixture() {
  const d = mkdtempSync(join(tmpdir(), "mp-"));
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "sub", "f.txt"), "good\n");
  return d;
}
const verdict = (dir) => readFileSync(join(dir, "sub", "f.txt"), "utf8").includes("bad");

let pass = 0, total = 0;
const check = (label, actual, expected) => {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${ok ? "" : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

const quiet = (fn) => { const w = console.log; console.log = () => {}; try { return fn(); } finally { console.log = w; } };

// 1. a real mutation that flips the verdict
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("reject", "flips", (d) => writeFileSync(join(d, "sub", "f.txt"), "bad\n")));
  check("a mutation that flips the verdict passes", [r.results.ok, r.results.void, r.results.failed], [2, 0, 0]);
}

// 2. THE ROT: a mutation that changes nothing
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("reject", "inert", () => {}));
  check("an INERT mutation is VOID, not FAIL", [r.results.void, r.results.failed], [1, 0]);
}

// 3. declared non-mutating, and does not mutate
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("accept", "clean", () => {}, { mutates: false }));
  check("{ mutates: false } that does not mutate passes", [r.results.ok, r.results.void], [2, 0]);
}

// 4. declared non-mutating but DOES mutate — the declaration is a claim too
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("accept", "liar", (d) => writeFileSync(join(d, "sub", "f.txt"), "good2\n"), { mutates: false }));
  check("{ mutates: false } that DOES mutate is VOID", [r.results.void], [1]);
}

// 5. DEV2's open region: mutates, expected not to flip
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("accept", "no flip", (d) => writeFileSync(join(d, "sub", "g.txt"), "x\n")));
  check("an accept-case that mutates is counted UNPROVEN", [r.results.unproven, r.results.failed], [1, 0]);
  check("...and still exits 0 (documented gap, not a guard)", quiet(() => r.report()), 0);
}

// 6. a baseline that already fails voids the run
{
  const badBaseline = () => { const d = makeFixture(); writeFileSync(join(d, "sub", "f.txt"), "bad\n"); return d; };
  const r = createProofRunner({ makeFixture: badBaseline, verdict });
  quiet(() => r.expect("reject", "would pass for the wrong reason", (d) => writeFileSync(join(d, "sub", "f.txt"), "bad bad\n")));
  check("a REJECTED baseline fails the run", [r.results.failed > 0], [true]);
  check("...and report() exits non-zero", quiet(() => r.report()), 1);
}

// 7. verdict mismatch is a plain FAIL
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("reject", "does not flip", (d) => writeFileSync(join(d, "sub", "f.txt"), "still good\n")));
  check("a mutation that moves bytes but not the verdict FAILs", [r.results.failed], [1]);
}

// 8. VOID must fail the run — a missing proof is not a pass
{
  const r = createProofRunner({ makeFixture, verdict });
  quiet(() => r.expect("reject", "inert", () => {}));
  check("report() exits non-zero when anything is VOID", quiet(() => r.report()), 1);
}

// 9. guardrails
{
  const r = createProofRunner({ makeFixture, verdict });
  let threw = false;
  try { r.expect("maybe", "bad want", () => {}); } catch { threw = true; }
  check("an invalid expected-verdict throws", threw, true);
  let threw2 = false;
  try { createProofRunner({ makeFixture }); } catch { threw2 = true; }
  check("constructing without a verdict fn throws", threw2, true);
}

// 10. fingerprint covers deletions, not just edits
{
  const d = makeFixture();
  const before = fingerprint(d);
  rmSync(join(d, "sub", "f.txt"));
  check("fingerprint moves on a DELETION", before !== fingerprint(d), true);
  rmSync(d, { recursive: true, force: true });
}

// ── the MUTATION-TO-EXECUTION gap (i15-97's shape, via DEV2) ──────────────────
// A "compiled" fixture: src/a.txt is the source, dist/a.txt is what runs. The
// checker reads DIST, never SRC — so a stale build makes it read the old world.
function makeCompiled() {
  const d = mkdtempSync(join(tmpdir(), "mpc-"));
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(join(d, "dist"), { recursive: true });
  writeFileSync(join(d, "src", "a.txt"), "good\n");
  writeFileSync(join(d, "dist", "a.txt"), "good\n");
  return d;
}
const buildThenRead = (dir) => {                       // an HONEST build
  writeFileSync(join(dir, "dist", "a.txt"), readFileSync(join(dir, "src", "a.txt"), "utf8"));
  return readFileSync(join(dir, "dist", "a.txt"), "utf8").includes("bad");
};
const cachedBuild = (dir) =>                            // a CACHED/skipped build
  readFileSync(join(dir, "dist", "a.txt"), "utf8").includes("bad");

const mutateSrc = (d) => writeFileSync(join(d, "src", "a.txt"), "bad\n");
const witnessDist = (d) => artifactContains(d, "dist/a.txt", "bad");

// 11. honest build: source mutated, artifact rebuilt, witness holds
{
  const r = createProofRunner({ makeFixture: makeCompiled, verdict: buildThenRead });
  quiet(() => r.expect("reject", "compiled", mutateSrc, { witness: witnessDist }));
  check("witness satisfied by an honest build passes", [r.results.ok, r.results.void], [2, 0]);
}

// 12. THE GAP: cached build. Source moved, checker ran, artifact never changed.
{
  const r = createProofRunner({ makeFixture: makeCompiled, verdict: cachedBuild });
  quiet(() => r.expect("reject", "compiled", mutateSrc, { witness: witnessDist }));
  check("a CACHED build is VOID, not FAIL", [r.results.void, r.results.failed], [1, 0]);
}

// 13. WITHOUT a witness the same cached build reports FAIL — the old behaviour,
//     which blames the checker for a build that never happened.
{
  const r = createProofRunner({ makeFixture: makeCompiled, verdict: cachedBuild });
  quiet(() => r.expect("reject", "compiled, no witness", mutateSrc));
  check("...and without a witness it is indistinguishable from a FAIL", [r.results.failed], [1]);
}

// 14. a witness already true cannot discriminate
{
  const r = createProofRunner({ makeFixture: makeCompiled, verdict: buildThenRead });
  quiet(() => r.expect("reject", "pre-true witness", mutateSrc, { witness: () => true }));
  check("a witness TRUE before the mutation is VOID", [r.results.void], [1]);
}

// 15. artifactContains tolerates a missing artifact
{
  const d = makeCompiled();
  rmSync(join(d, "dist", "a.txt"));
  check("artifactContains(missing file) is false, not a throw", artifactContains(d, "dist/a.txt", "bad"), false);
  rmSync(d, { recursive: true, force: true });
}


console.log();
if (pass === total) {
  console.log(`PASS: ${pass}/${total}. mutation-proof.mjs has been observed emitting every verdict it`);
  console.log(`      can emit — ok, FAIL, VOID (inert, mis-declared, pre-true witness, stale`);
  console.log(`      artifact), unproven, and a rejected baseline.`);
  process.exit(0);
}
console.log(`FAIL: ${pass}/${total}`);
process.exit(1);
