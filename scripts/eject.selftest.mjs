#!/usr/bin/env node
/**
 * eject.selftest.mjs — prove eject REFUSES when it should, and PROCEEDS when it should.
 *
 * The severability matrix exercises eject's happy path thoroughly: it runs eight real ejects and
 * holds each fork to build/typecheck/test and a live server. What the matrix cannot exercise is
 * the REFUSAL paths — the guards that stop eject running against a tree it would corrupt. Those
 * only fire on inputs a healthy repo never produces, so nothing else will ever notice if one
 * silently stops working.
 *
 * BOTH DIRECTIONS, per the rule this issue arrived at the hard way:
 *   - what would make this PASS while the property is violated?  -> the refusal cases
 *   - what would make this FAIL while the property holds?        -> the proceed cases
 * A checker that refuses everything is as useless as one that refuses nothing, and it is harder
 * to spot because red reads as diligence. My own rungs.schema.json rejected every document for
 * an hour and looked rigorous the whole time.
 *
 * Every case runs against a THROWAWAY GIT WORKTREE. Nothing here can touch the real tree.
 *
 * Usage: node scripts/eject.selftest.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EJECT = join(ROOT, "scripts", "eject.mjs");
const TMP = mkdtempSync(join(tmpdir(), "eject-selftest-"));

let pass = 0;
let fail = 0;
let n = 0;

/** A fresh detached worktree at HEAD, optionally with a mutated manifest. */
function sandbox(mutate) {
  const dir = join(TMP, `wt-${n++}`);
  execFileSync("git", ["worktree", "add", "--detach", "-f", dir, "HEAD"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  if (mutate) {
    const p = join(dir, "rungs.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    mutate(m);
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  }
  return dir;
}

function run(dir, args) {
  try {
    return { rc: 0, out: execFileSync("node", [EJECT, ...args, "--cwd", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function expectRefuse(name, args, needle, mutate) {
  const dir = sandbox(mutate);
  const { rc, out } = run(dir, args);
  if (rc !== 0 && out.includes(needle)) {
    console.log(`  ok   ${name.padEnd(52)} (refused: ${needle})`);
    pass++;
  } else if (rc !== 0) {
    console.error(`  FAIL ${name.padEnd(52)} refused, but not for "${needle}"`);
    console.error(`       ${out.split("\n").find((l) => l.startsWith("FAIL")) ?? out.slice(0, 160)}`);
    fail++;
  } else {
    console.error(`  FAIL ${name.padEnd(52)} PROCEEDED — the guard did not fire`);
    fail++;
  }
}

function expectProceed(name, args, needle, mutate) {
  const dir = sandbox(mutate);
  const { rc, out } = run(dir, args);
  if (rc === 0 && out.includes(needle)) {
    console.log(`  ok   ${name.padEnd(52)} (proceeded)`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(52)} expected success containing "${needle}", rc=${rc}`);
    console.error(`       ${out.split("\n").filter(Boolean).slice(-3).join("\n       ")}`);
    fail++;
  }
}

console.log("eject.mjs self-test — refuses what it must, proceeds where it should\n");

// --- REFUSALS: guards that only fire on input a healthy repo never produces ------------------

expectRefuse("unknown rung name", ["not-a-rung"], "unknown rung");

expectRefuse("no rung given", [], "usage:");

// A stale census is the dangerous one: ejecting against an incomplete classification is exactly
// how you get an incoherent-but-green fork. eject must exit BEFORE touching the tree.
expectRefuse("stale census — a glob matching nothing", ["langgraph"], "classification is not clean", (m) => {
  m.rungs[0].owns.ts.push("packages/server/src/adapters/ghost.ts");
});

expectRefuse("stale census — a rung file left in shared", ["langgraph"], "classification is not clean", (m) => {
  m.rungs.find((r) => r.id === "open-swe").owns.docs = [];
});

// The deletion count is an EXACT equality against the frozen census. It must reject a manifest
// whose count disagrees with the tree in EITHER direction — an under-count would let eject
// delete more than declared, an over-count less.
expectRefuse("frozen count too low for the tree", ["langgraph"], "classification is not clean", (m) => {
  m.rungs.find((r) => r.id === "deepagents").ownedFileCount -= 1;
});
expectRefuse("frozen count too high for the tree", ["langgraph"], "classification is not clean", (m) => {
  m.rungs.find((r) => r.id === "deepagents").ownedFileCount += 1;
});

// --- PROCEEDS: the other half of the test, and the half that is easy to forget ---------------
//
// Without these, an eject that refused unconditionally would pass every case above.

expectProceed("dry-run on the real manifest", ["deepagents", "--dry-run"], "census agrees");

expectProceed("dry-run reports the correct retain set", ["langgraph", "--dry-run"], "retain : langchain, langgraph");

// Ejecting to the top rung is a legitimate no-op, not an error: a fork that wants everything is
// still a fork. If this failed, `eject <top>` would look broken to the first person who tried it.
expectProceed("eject to the top rung is a no-op", [
  JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8")).rungs.slice(-1)[0].id,
], "nothing to do");

// --- Non-vacuity of this suite ---------------------------------------------------------------
const EXPECTED_CASES = 9;
const total = pass + fail;
console.log();
try {
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
} catch {
  /* best effort */
}
rmSync(TMP, { recursive: true, force: true });
try {
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
} catch {
  /* best effort */
}

if (total !== EXPECTED_CASES) {
  console.error(`FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`);
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong. eject's guards are NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. eject refuses a stale census and a bad rung, and proceeds on a\n` +
    `      healthy one — so its refusals mean something and its successes are not luck.`
);
