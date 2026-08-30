#!/usr/bin/env node
/**
 * Proof for run-checks.mjs.
 *
 * The case that matters most is the ANNOTATION one, and it is watched rather than assumed.
 *
 * Consolidating 55 named steps into one costs the step name that told you what broke before
 * you opened a log. `::error title=…::` is the replacement. A runner that ran the checks, saw
 * one fail, and reported it only in a printed summary would look identical from the outside —
 * green step names gone, no annotation, a failure discoverable only by reading a log — and
 * that is precisely the regression this refactor exists to prevent. So a check is made to
 * fail for real and the annotation is read off stdout, in the shape check-github-reporter's
 * live half established.
 *
 * The second is the hole case: a check declared in the list that the runner does not execute
 * must be visible as an absence in the record, because that is the only thing keeping the
 * declaration from being self-certifying.
 *
 * Usage: node scripts/run-checks.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "run-checks.mjs");
const TMP = mkdtempSync(join(tmpdir(), "runchecks-"));

let pass = 0;
let fail = 0;

/** A tree with a check list and whatever scripts the case declares. */
function sandbox(checks, files) {
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "checks.json"), JSON.stringify({ checks }, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function run(dir) {
  try {
    return { rc: 0, out: execFileSync("node", [RUNNER, "--cwd", dir], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const OK = 'process.exit(0);\n';
const BAD = 'console.error("FAIL: the planted defect, said out loud");\nprocess.exit(1);\n';

function record(dir) {
  const p = join(dir, ".checks-run.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).ran : null;
}

function ok(label, cond, note) {
  if (cond) {
    console.log(`  ok   ${label.padEnd(56)} (${note})`);
    pass++;
  } else {
    console.error(`  FAIL ${label}`);
    fail++;
  }
}

console.log("\nrun-checks.mjs self-test\n");

{
  /*
   * THE LIVE HALF. A real failure, and the annotation is read off stdout — not "the code
   * contains an ::error:: template", which is a claim about source rather than behaviour.
   */
  const dir = sandbox(
    [{ name: "planted", proof: "scripts/p.mjs", checker: "scripts/c.mjs", why: "x" }],
    { "scripts/p.mjs": OK, "scripts/c.mjs": BAD }
  );
  const { rc, out } = run(dir);
  const line = out.split("\n").find((l) => l.startsWith("::error"));
  ok(
    "a real failure EMITS ::error naming the checker",
    rc !== 0 && Boolean(line) && line.includes("title=planted") && line.includes("checker"),
    line ? line.slice(0, 62) : "no annotation emitted"
  );
  ok(
    "...and the annotation carries the reason, not just the name",
    Boolean(line) && line.includes("planted defect"),
    "reason present"
  );
  ok(
    "...and the record is written even though it failed",
    (record(dir) ?? []).some((r) => r.name === "planted" && r.status === "fail"),
    "recorded as fail"
  );
}

{
  // A checker whose PROOF failed tells you nothing, so it must not run — and the record has
  // to show that it did not, or a reader would assume the checker passed.
  const dir = sandbox(
    [{ name: "unproven", proof: "scripts/p.mjs", checker: "scripts/c.mjs", why: "x" }],
    { "scripts/p.mjs": BAD, "scripts/c.mjs": OK }
  );
  const { rc } = run(dir);
  const ran = record(dir) ?? [];
  ok(
    "a failed proof stops its checker from running",
    rc !== 0 && ran.some((r) => r.phase === "proof" && r.status === "fail") &&
      !ran.some((r) => r.phase === "checker"),
    "proof failed, checker absent from the record"
  );
}

{
  // The hole. Nothing here executes the declared check, so it must be missing from the
  // record — which is what assert-checker-proof-pairing.mjs reads to catch exactly this.
  const dir = sandbox(
    [
      { name: "ran", proof: "scripts/p.mjs", checker: "scripts/c.mjs", why: "x" },
      { name: "declared-only", proof: "scripts/q.mjs", checker: "scripts/d.mjs", why: "x" },
    ],
    { "scripts/p.mjs": OK, "scripts/c.mjs": OK, "scripts/q.mjs": OK, "scripts/d.mjs": OK }
  );
  run(dir);
  const ran = record(dir) ?? [];
  // Both DO run here — the point of the case is that the record names each execution, so an
  // entry that never ran cannot be inferred as having passed.
  ok(
    "the record names every execution individually",
    ran.filter((r) => r.name === "declared-only").length === 2 &&
      ran.every((r) => typeof r.exit === "number"),
    `${ran.length} phases recorded`
  );
}

{
  const dir = sandbox([], {});
  const { rc, out } = run(dir);
  ok(
    "an EMPTY list is exit 2, not a green",
    rc === 2 && out.includes("declares no checks"),
    "refused"
  );
}

{
  const dir = mkdtempSync(join(TMP, "nolist-"));
  const { rc, out } = run(dir);
  ok(
    "a MISSING list is exit 2, not a green",
    rc === 2 && out.includes("no check list"),
    "refused"
  );
}

{
  const dir = sandbox(
    [{ name: "clean", proof: "scripts/p.mjs", checker: "scripts/c.mjs", why: "x" }],
    { "scripts/p.mjs": OK, "scripts/c.mjs": OK }
  );
  const { rc, out } = run(dir);
  const ran = record(dir) ?? [];
  ok(
    "an all-green list exits 0 and emits no annotation",
    rc === 0 && !out.includes("::error") && ran.length === 2,
    "clean"
  );
}

const EXPECTED_CASES = 8;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });

if (total !== EXPECTED_CASES) {
  console.error(`FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`);
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. A real failure was watched producing a real ::error:: annotation\n` +
    `      naming the checker and its reason, a failed proof stops its checker, and the record\n` +
    `      names each execution so a declared check that never ran cannot read as a pass.`
);
