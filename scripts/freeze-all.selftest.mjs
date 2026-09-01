#!/usr/bin/env node
/**
 * freeze-all.mjs self-test — plants the deadlock, and the defect it must refuse.
 *
 * `pnpm freeze:all` is the sanctioned exit from #275, and it is a WRITER: when
 * it is wrong it does not go red, it silently records numbers nobody measured
 * — which is the whole of #145, the thing both freezes exist to prevent. So
 * the two properties worth proving are opposite, and neither is worth much
 * alone:
 *
 *   1. it resolves a genuine deadlock  (without this it is a no-op that passes)
 *   2. it refuses a defect no freeze fixes, AND WRITES NOTHING when it does
 *
 * Case 2's second half is the one that would rot quietly. A refusal that has
 * already written one artifact leaves a half-consistent tree while printing a
 * message that says it declined — worse than either freeze alone, because the
 * message reads as safety.
 *
 * Each case runs in a worktree at HEAD seeded with the WORKING TREE's scripts,
 * so this suite tests the code being changed rather than the code last
 * committed. Every path in those scripts is derived from `import.meta.url`, so
 * a copy inside the sandbox resolves entirely inside the sandbox — this can
 * never write the real rungs.json.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { requireRungOwned } from "./lib/fixture-premise.mjs";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/*
 * realpathSync IS LOAD-BEARING, NOT TIDINESS.
 *
 * On macOS `tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`.
 * classify.mjs decides whether it is the entry point with
 *
 *     invokedAsProgram(import.meta.url)
 *
 * and those two disagree across that symlink: argv[1] keeps the `/var` spelling
 * it was invoked with, while `import.meta.url` is already resolved. `isMain` is
 * then FALSE, so the script loads, defines its functions, does nothing, and
 * EXITS 0.
 *
 * Measured before this line: `classify.mjs --freeze` returned rc=0 with empty
 * output on a tree whose counts were stale, and the deadlock case read that as
 * "the freeze succeeded". A silent no-op scoring as a pass is the exact shape
 * these suites exist to catch.
 */
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "freeze-all-selftest-")));

/*
 * Same interrupt exposure as the other three suites: the teardown at the bottom
 * of this file is on the happy path, and an interrupted run leaves its
 * worktrees behind. See the comment in eject.selftest.mjs for the 312 MB this
 * cost before anyone noticed.
 */
function tearDownSandboxes() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    /* best effort */
  }
}
process.on("exit", tearDownSandboxes);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    tearDownSandboxes();
    process.exit(130);
  });
}
let pass = 0;
let fail = 0;
let n = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name.padEnd(56)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL ${name.padEnd(56)} ${detail}`);
  }
}

const SEED = [
  "scripts/classify.mjs",
  "scripts/census.mjs",
  "scripts/freeze-all.mjs",
  // The shared JSON writer both freezes now go through (#622). Absent from the seed, the
  // worktree would run the COMMITTED writer while this suite claims to test the current one.
  "scripts/write-generated-json.mjs",
  "scripts/shared-census.json",
  "rungs.json",
  "package.json",
];

function sandbox() {
  const dir = join(TMP, `wt-${n++}`);
  execFileSync("git", ["worktree", "add", "--detach", "-f", dir, "HEAD"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  // Seed from the WORKING TREE: this suite must test the scripts as they are
  // now, not as they were last committed.
  for (const rel of SEED) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
    execFileSync("git", ["add", "--", rel], { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

function run(dir, script, args = []) {
  try {
    return {
      rc: 0,
      out: execFileSync(
        process.execPath,
        [join(dir, "scripts", script), ...args],
        {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      ),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Add a file and TRACK it — the census reads `git ls-files`. */
function track(dir, rel, body) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
  execFileSync("git", ["add", "--", rel], { cwd: dir, stdio: "ignore" });
}

/*
 * THE DEADLOCK NEEDS ONE RUNG-OWNED FILE AND ONE SHARED ONE (#375).
 *
 * `e2e/rungs/open-swe/selftest-owned.spec.ts` is owned only because rung 4 claims
 * `e2e/rungs/open-swe/**` as a DIRECTORY glob — no manifest entry names this file, which is
 * exactly what lets the plant work and exactly what a reparent removes without touching this
 * fixture. Narrow that glob and the plant becomes shared, both freezes agree, there is no
 * deadlock left to construct, and the ACCEPT case below passes over nothing.
 *
 * assert-census-fresh lost its SILENT case to this precise mechanism.
 */
const OWNED_PLANT = "e2e/rungs/open-swe/selftest-owned.spec.ts";
const SHARED_PLANT = "packages/react/src/selftest-shared.test.ts";

/** Plant both halves of the deadlock, having first checked they are still both halves. */
function plantDeadlock(dir) {
  requireRungOwned(
    dir,
    OWNED_PLANT,
    "the deadlock needs a rung-owned file to collide with the shared one."
  );
  track(dir, OWNED_PLANT, "export {};\n");
  track(dir, SHARED_PLANT, "export {};\n");
}

const ownedCounts = (dir) =>
  JSON.stringify(
    JSON.parse(readFileSync(join(dir, "rungs.json"), "utf8")).rungs.map(
      (r) => r.ownedFileCount
    )
  );

console.log(
  "freeze-all.mjs self-test — plants the deadlock, and the defect it must refuse\n"
);

// --- The deadlock is REAL ---------------------------------------------------------------
// If this stops reproducing, freeze:all is solving a problem that no longer exists and the
// case below would pass for the wrong reason.
{
  const dir = sandbox();
  plantDeadlock(dir);
  const r = run(dir, "classify.mjs", ["--freeze"]);
  const c = run(dir, "census.mjs", ["--freeze"]);
  check(
    "the deadlock reproduces — each freeze refuses",
    r.rc !== 0 && c.rc !== 0,
    r.rc !== 0 && c.rc !== 0
      ? "(both refused)"
      : `(rungs rc=${r.rc} census rc=${c.rc})`
  );
}

// --- ACCEPT: freeze:all resolves it -------------------------------------------------------
{
  const dir = sandbox();
  plantDeadlock(dir);
  const f = run(dir, "freeze-all.mjs");
  const okCensus = run(dir, "census.mjs").rc === 0;
  const okRungs = run(dir, "classify.mjs").rc === 0;
  check(
    "freeze:all resolves the deadlock and both checks pass",
    f.rc === 0 && okCensus && okRungs,
    f.rc === 0 && okCensus && okRungs
      ? "(both green)"
      : `(freeze rc=${f.rc} census=${okCensus} rungs=${okRungs})`
  );
}

// --- REJECT: a defect no freeze fixes ----------------------------------------------------
{
  const dir = sandbox();
  const manifestPath = join(dir, "rungs.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.rungs[0].owns.ts.push("apps/this-path-does-not-exist/**");
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  const before = ownedCounts(dir);
  const censusBefore = readFileSync(
    join(dir, "scripts", "shared-census.json"),
    "utf8"
  );

  const f = run(dir, "freeze-all.mjs");
  check(
    "a C4 dead glob is refused, not frozen over",
    f.rc !== 0 && /no freeze fixes/.test(f.out),
    f.rc !== 0 ? "(refused, named the reason)" : "(WROTE ANYWAY)"
  );

  // THE HALF THAT ROTS QUIETLY. A refusal that already wrote one artifact is
  // worse than no exit at all, because the message reads as safety.
  const censusAfter = readFileSync(
    join(dir, "scripts", "shared-census.json"),
    "utf8"
  );
  check(
    "a refusal writes NEITHER artifact",
    ownedCounts(dir) === before && censusAfter === censusBefore,
    ownedCounts(dir) === before && censusAfter === censusBefore
      ? "(both untouched)"
      : "(an artifact was modified)"
  );
}

// --- ACCEPT: a clean tree is a successful no-op ------------------------------------------
// Without this, "refuse everything" scores full marks on the case above.
{
  const dir = sandbox();
  const before = ownedCounts(dir);
  const f = run(dir, "freeze-all.mjs");
  check(
    "a clean tree succeeds and changes no counts",
    f.rc === 0 && ownedCounts(dir) === before,
    f.rc === 0 ? "(no-op)" : `(rc=${f.rc})`
  );
}

rmSync(TMP, { recursive: true, force: true });
try {
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
} catch {
  /* best effort */
}

const total = pass + fail;
if (fail) {
  console.error(
    `\nFAIL: ${fail}/${total} cases wrong. freeze:all is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The deadlock reproduces, freeze:all resolves it, a defect\n` +
    `      no freeze fixes is still refused, and a refusal leaves both artifacts alone.`
);
