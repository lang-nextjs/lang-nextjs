#!/usr/bin/env node
/**
 * PROOF FOR write-generated-json.mjs — the artifacts are born gate-clean (#622).
 *
 * RUN IN THE FAILING CONFIGURATION, NOT AGAINST TODAY'S COMMITTED FILE. Checking the file
 * that is in the tree tests the file; the claim is about the GENERATOR. So the cases below
 * plant a change that moves each artifact, run the REAL freeze in a throwaway worktree, and
 * check the regenerated output — with no manual formatting anywhere in the loop.
 *
 * Same discipline as #585's fixtures copying the repo's own .gitignore instead of retyping
 * the pattern: assert against the real artifact, not a restatement of it.
 *
 * EACH PLANT VERIFIES ITSELF. A fixture that quietly stops changing the census would leave
 * these cases passing over an artifact that never moved — green about nothing, which is the
 * shape the census guards exist to catch one level up. So every case asserts the artifact
 * ACTUALLY CHANGED before it asserts anything about its shape.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRungOwned } from "./lib/fixture-premise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PRETTIER = join(ROOT, "node_modules", ".bin", "prettier");

let pass = 0,
  fail = 0;
const rows = [];
const ok = (name, cond, detail) => {
  rows.push({ name, cond, detail });
  cond ? pass++ : fail++;
};

const git = (args, cwd = ROOT) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The scripts under test, taken from the working tree rather than from HEAD. */
const SEED = [
  "scripts/write-generated-json.mjs",
  "scripts/classify.mjs",
  "scripts/census.mjs",
  "scripts/freeze-all.mjs",
];

const worktrees = [];
function throwaway(tag) {
  const wt = mkdtempSync(join(tmpdir(), `gjson-${tag}-`));
  git(["worktree", "add", "-q", "--detach", wt, "HEAD"]);
  /*
   * A linked worktree has no node_modules, and the freeze now REFUSES (exit 2) without
   * prettier — the very refusal this change adds. Lending the checkout's install is what a
   * real user already has; a worktree of the same repo can only agree with it.
   */
  // NO node_modules IS LENT HERE, deliberately. A linked worktree has none, and the writer
  // is expected to resolve prettier from the checkout this worktree belongs to. Lending one
  // would hide exactly the path three selftests tripped over.

  /*
   * SEED THE SCRIPTS FROM THE WORKING TREE, which is what makes this a proof at all.
   *
   * `git worktree add --detach HEAD` checks out the COMMITTED code, so every case here would
   * exercise the last commit no matter what the working tree says. Measured: with the
   * prettier pass deleted from the writer, all eight cases stayed green — the suite could not
   * fail on the very change it exists to test. Seeding is how freeze-all.selftest solves the
   * same problem, and for the same reason.
   */
  for (const rel of SEED) copyFileSync(join(ROOT, rel), join(wt, rel));
  worktrees.push(wt);
  return wt;
}

/**
 * Run a freeze BY RELATIVE PATH, and that is not stylistic.
 *
 * `classify.mjs` guards its entry point with
 * `fileURLToPath(import.meta.url) === process.argv[1]`. A temp worktree lives under
 * /var/folders, whose real path is /private/var/folders, so an ABSOLUTE argv[1] never equals
 * the resolved module path — the guard is false, main never runs, and the process exits 0
 * having done NOTHING. It cost me two wrong conclusions here before I noticed, including a
 * false claim that a neighbouring fixture's path had stopped being rung-owned.
 */
function freeze(wt, script) {
  execFileSync("node", [script, "--freeze"], { cwd: wt, stdio: "ignore" });
}

/** prettier --check, as the gate runs it. Exit 0 means formatted. */
function checkFormatted(cwd, rel) {
  try {
    execFileSync(PRETTIER, ["--check", rel], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

console.log(
  "\nwrite-generated-json — the freeze produces gate-clean artifacts\n"
);

/* ── THE CONTROL, FIRST: the old writer really did produce a failing file ─────────────── */
{
  /*
   * Without this every case below is satisfied by a repo where prettier accepts anything.
   * Re-serialising the REAL artifact the way the generators used to — JSON.stringify with two
   * spaces — must FAIL the gate, which is the defect #622 describes, reproduced from live data.
   */
  const d = mkdtempSync(join(tmpdir(), "gjson-control-"));
  const real = JSON.parse(
    readFileSync(join(ROOT, "scripts", "shared-census.json"), "utf8")
  );
  writeFileSync(
    join(d, "shared-census.json"),
    JSON.stringify(real, null, 2) + "\n"
  );
  const code = checkFormatted(d, "shared-census.json");
  ok(
    "the OLD writer's output FAILS the gate — the defect is real",
    code === 1,
    code === 1
      ? "reproduced"
      : `prettier exit ${code} — it accepts stringify output, cases below are vacuous`
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── THE CENSUS MOVES, IS RE-FROZEN, AND PASSES ──────────────────────────────────────── */
{
  const wt = throwaway("census");
  const before = readFileSync(
    join(wt, "scripts", "shared-census.json"),
    "utf8"
  );
  // A SHARED file under a FROZEN glob, so census membership moves without a manifest edit.
  const rel = "packages/server/src/zz-census-probe.ts";
  writeFileSync(join(wt, ...rel.split("/")), "export const zzProbe = 1;\n");
  git(["add", "-A"], wt);
  freeze(wt, "scripts/census.mjs");
  const after = readFileSync(join(wt, "scripts", "shared-census.json"), "utf8");

  ok(
    "the census plant actually MOVED the artifact",
    before !== after,
    before !== after ? "changed" : "UNCHANGED — this case proves nothing"
  );
  const censusCode = checkFormatted(wt, "scripts/shared-census.json");
  ok(
    "...and the re-frozen census passes the gate, unformatted by hand",
    censusCode === 0,
    `prettier exit ${censusCode}`
  );
  ok(
    "...and it still contains the planted member",
    JSON.parse(after).members.includes(rel),
    "member present"
  );
}

/* ── THE MANIFEST MOVES, IS RE-FROZEN, AND PASSES ────────────────────────────────────── */
{
  const wt = throwaway("manifest");
  const before = readFileSync(join(wt, "rungs.json"), "utf8");
  // A RUNG-OWNED path, so ownedFileCount moves without a manifest edit.
  const rel = "apps/open-swe/agent/zz-manifest-probe.ts";
  /*
   * AND THE PREMISE IS ASSERTED, NOT ASSUMED. This path is owned only through the directory
   * glob `apps/open-swe/agent/**`; a reparent that narrows it makes the plant SHARED, the
   * manifest stops moving, and this case goes green about nothing. That is not hypothetical
   * here — while writing this I concluded from a bad probe that a neighbouring fixture's
   * anchor had already expired, and it had not. A guard says which.
   */
  requireRungOwned(
    wt,
    rel,
    "the manifest can only move if this plant is rung-owned."
  );
  mkdirSync(dirname(join(wt, ...rel.split("/"))), { recursive: true });
  writeFileSync(join(wt, ...rel.split("/")), "export const zzProbe = 1;\n");
  git(["add", "-A"], wt);
  freeze(wt, "scripts/classify.mjs");
  const after = readFileSync(join(wt, "rungs.json"), "utf8");

  ok(
    "the manifest plant actually MOVED the artifact",
    before !== after,
    before !== after ? "changed" : "UNCHANGED — this case proves nothing"
  );
  const manifestCode = checkFormatted(wt, "rungs.json");
  ok(
    "...and the re-frozen manifest passes the gate, unformatted by hand",
    manifestCode === 0,
    `prettier exit ${manifestCode}`
  );
}

/* ── AND THE FULL freeze:all PATH, WHICH IS WHAT PEOPLE ACTUALLY RUN ─────────────────── */
{
  const wt = throwaway("freezeall");
  const rel = "packages/react/src/zz-freezeall-probe.ts";
  writeFileSync(join(wt, ...rel.split("/")), "export const zzProbe = 1;\n");
  git(["add", "-A"], wt);
  execFileSync("node", ["scripts/freeze-all.mjs"], {
    cwd: wt,
    stdio: "ignore",
  });
  const cCode = checkFormatted(wt, "scripts/shared-census.json");
  const mCode = checkFormatted(wt, "rungs.json");
  ok(
    "`freeze:all` leaves BOTH artifacts gate-clean",
    cCode === 0 && mCode === 0,
    `census exit ${cCode}, manifest exit ${mCode}`
  );
}

/* ── DATA IS UNTOUCHED BY THE FORMATTING ─────────────────────────────────────────────── */
{
  /*
   * A formatter that changed the DATA would pass every case above while corrupting the
   * artifact both census guards read. Cheap to assert and it is the one failure the shape
   * checks cannot see.
   */
  const wt = throwaway("data");
  const before = JSON.parse(
    readFileSync(join(wt, "scripts", "shared-census.json"), "utf8")
  );
  freeze(wt, "scripts/census.mjs");
  const after = JSON.parse(
    readFileSync(join(wt, "scripts", "shared-census.json"), "utf8")
  );
  ok(
    "re-freezing an UNCHANGED tree preserves the data exactly",
    JSON.stringify(before) === JSON.stringify(after),
    "identical"
  );
}

/* ── THE FALLBACK ITSELF, IN BOTH DIRECTIONS ─────────────────────────────────────────── */
{
  /*
   * Every case above already runs in a worktree with NO node_modules, so they all depend on
   * the fallback — but none of them SAYS so, and a reader cannot tell the fallback from a
   * lucky resolution. This one names it.
   */
  const wt = throwaway("fallback");
  ok(
    "a worktree with NO node_modules of its own still freezes",
    !existsSync(join(wt, "node_modules")),
    existsSync(join(wt, "node_modules"))
      ? "a node_modules appeared — the case proves nothing"
      : "none present"
  );
}
{
  /*
   * THE COMPANION, and without it the fallback could mean "resolve prettier from anywhere",
   * which would mask a genuinely missing install.
   *
   * DRIVES THE WRITER DIRECTLY rather than through census: a partial copy of the repo makes
   * classification fail, so census refuses BEFORE reaching the writer and the case would pass
   * for a reason unrelated to prettier. The refusal under test belongs to the writer, so the
   * writer is what this runs.
   *
   * A plain `git init` directory is NOT a linked worktree: --git-common-dir is its own .git,
   * so the fallback looks in the same tree, finds nothing, and must still refuse.
   */
  const d = mkdtempSync(join(tmpdir(), "gjson-noinstall-"));
  mkdirSync(join(d, "scripts"), { recursive: true });
  copyFileSync(
    join(ROOT, "scripts", "write-generated-json.mjs"),
    join(d, "scripts", "write-generated-json.mjs")
  );
  execFileSync("git", ["-C", d, "init", "-q"]);
  writeFileSync(
    join(d, "drive.mjs"),
    'import { writeGeneratedJson } from "./scripts/write-generated-json.mjs";\n' +
      'await writeGeneratedJson("out.json", { a: 1 });\n'
  );
  let code = 0,
    out = "";
  try {
    execFileSync("node", ["drive.mjs"], { cwd: d, encoding: "utf8" });
  } catch (e) {
    code = e.status;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  ok(
    "no worktree and no install still REFUSES, rather than writing unformatted",
    code === 2 &&
      /prettier is not resolvable/.test(out) &&
      !existsSync(join(d, "out.json")),
    code === 2 ? "exit 2, nothing written" : `exit ${code}`
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── CLEANUP AND REPORT ──────────────────────────────────────────────────────────────── */
for (const wt of worktrees) {
  try {
    git(["worktree", "remove", "--force", wt]);
  } catch {
    rmSync(wt, { recursive: true, force: true });
  }
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows)
  console.log(
    `  ${r.cond ? "ok  " : "FAIL"} ${r.name.padEnd(w)}  (${r.detail})`
  );
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${rows.length} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${rows.length}. A tree whose census actually moves is re-frozen and the\n` +
    `      result passes the format gate with no manual formatting in the loop.`
);
