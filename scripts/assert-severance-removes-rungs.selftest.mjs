#!/usr/bin/env node
/**
 * Proof for assert-severance-removes-rungs.mjs.
 *
 * THE CASE THAT MATTERS MOST IS THE IDENTITY ONE, because it is what #481 is about: a fork
 * that retains every rung removes nothing, so "the removed rungs are absent" is vacuously
 * true. Reporting that as a pass is the defect. This asserts the checker says IDENTITY and
 * never prints a severance PASS there — a checker that merely exited 0 would reproduce the
 * bug it was written to close.
 *
 * Usage: node scripts/assert-severance-removes-rungs.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "assert-severance-removes-rungs.mjs");
const TMP = mkdtempSync(join(tmpdir(), "sever-"));
let pass = 0, fail = 0;

/** A fork tree containing exactly `present`, plus a record claiming `recorded`. */
function sandbox(recorded, present) {
  const dir = mkdtempSync(join(TMP, "case-"));
  for (const f of present) {
    const full = join(dir, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "x");
  }
  const rec = join(dir, "..", `rec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(rec, JSON.stringify(recorded));
  return { dir, rec };
}

function run(dir, rec, retained) {
  try {
    return { rc: 0, out: execFileSync("node", [CHECKER, "--cwd", dir, "--verify", rec, "--retained", retained], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, recorded, present, retained, mustSay = [], mustNotSay = []) {
  const { dir, rec } = sandbox(recorded, present);
  const { rc, out } = run(dir, rec, retained);
  const got = rc === 0 ? "accept" : rc === 2 ? "vacuous" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  const quiet = mustNotSay.every((s) => !out.includes(s));
  if (got === want && said && quiet) { console.log(`  ok   ${label.padEnd(60)} (${want})`); pass++; }
  else {
    console.error(`  FAIL ${label} — wanted ${want}, got ${got} (rc=${rc}), named=${said}, quiet=${quiet}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

const FIVE = {
  langchain: ["a/one.ts"],
  "software-developer-agent": ["rungs/5/x.ts", "rungs/5/y.ts", "pkg/sda.ts"],
};

console.log("\nassert-severance-removes-rungs — REJECT\n");

expect(
  "a non-retained rung whose files are still there",
  "reject",
  FIVE,
  ["a/one.ts", "rungs/5/x.ts", "rungs/5/y.ts", "pkg/sda.ts"],
  "langchain",
  ["3 owned -> 3 present", "STILL PRESENT: rungs/5/x.ts", "left files behind"]
);

expect(
  "even ONE surviving file fails — absence is by name, not by count",
  "reject",
  FIVE,
  ["a/one.ts", "pkg/sda.ts"],
  "langchain",
  ["3 owned -> 1 present", "STILL PRESENT: pkg/sda.ts"]
);

console.log("\nassert-severance-removes-rungs — ACCEPT\n");

expect(
  "a non-retained rung fully absent prints the number that went to zero",
  "accept",
  FIVE,
  ["a/one.ts"],
  "langchain",
  ["software-developer-agent", "3 owned -> 0 present", "0 present in the fork"]
);

console.log("\nassert-severance-removes-rungs — THE IDENTITY CASE (#481)\n");

/*
 * THE WHOLE POINT. Retaining everything removes nothing, so every absence assertion is
 * vacuously true. The checker must SAY SO and must NOT print a severance pass — a checker that
 * silently exited 0 here would be the very defect #481 reports, reimplemented one layer out.
 */
expect(
  "retaining every rung reports IDENTITY, never a severance PASS",
  "accept",
  FIVE,
  ["a/one.ts", "rungs/5/x.ts", "rungs/5/y.ts", "pkg/sda.ts"],
  "langchain,software-developer-agent",
  ["IDENTITY", "NOT EVIDENCE OF SEVERANCE", "cells BELOW it"],
  ["PASS:"]
);

console.log("\nassert-severance-removes-rungs — VACUITY\n");

{
  const { dir } = sandbox(FIVE, []);
  const missing = join(dir, "nope.json");
  const { rc, out } = run(dir, missing, "langchain");
  const label = "a missing record is exit 2, not 'everything is absent'";
  if (rc === 2 && out.includes("nothing")) { console.log(`  ok   ${label.padEnd(60)} (vacuous)`); pass++; }
  else { console.error(`  FAIL ${label} — rc=${rc}`); console.error(out); fail++; }
}

{
  // --record on a tree with no manifest cannot compute anything.
  const dir = mkdtempSync(join(TMP, "norungs-"));
  let rc = 0, out = "";
  try { out = execFileSync("node", [CHECKER, "--cwd", dir, "--record", join(dir, "..", "o.json")], { encoding: "utf8" }); }
  catch (e) { rc = e.status ?? 1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const label = "--record with no rungs.json is exit 2";
  if (rc === 2 && out.includes("no rungs.json")) { console.log(`  ok   ${label.padEnd(60)} (vacuous)`); pass++; }
  else { console.error(`  FAIL ${label} — rc=${rc}`); console.error(out); fail++; }
}

const EXPECTED = 6;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) { console.error(`FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`); process.exit(1); }
if (fail !== 0) { console.error(`FAIL: ${fail}/${total} cases wrong.`); process.exit(1); }
console.log(
  `PASS: ${pass}/${total}. A surviving file is caught by name, the absent case prints the count\n` +
    `      that went to zero, the IDENTITY fork is named rather than passed, and neither a\n` +
    `      missing record nor a missing manifest can report success.`
);
