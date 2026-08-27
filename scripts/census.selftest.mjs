#!/usr/bin/env node
/**
 * census.selftest.mjs — proves census.mjs can FAIL, by planting each defect it claims to catch.
 *
 * A freeze that cannot fail is a rubber stamp with extra steps, and this check exists because
 * the alternative — trusting a green run — is the thing the whole census is arguing against.
 *
 * PLANT, DO NOT BORROW. Every case creates its own condition in a throwaway worktree. A case
 * that borrows a violation from the tree's current state passes the day someone fixes it:
 * eject.selftest.mjs's REJECT case borrowed one from `apps/example` and went green the moment
 * #69 fixed it (#78). So nothing here reads the repo's current state of repair.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS = join(ROOT, "scripts", "census.mjs");
const TMP = mkdtempSync(join(tmpdir(), "census-selftest-"));

/*
 * CLEAN UP EVEN WHEN THIS RUN DOES NOT FINISH.
 *
 * The teardown at the bottom of this file is correct and was never reached by
 * a run that threw or was interrupted — and each abandoned run leaves a full
 * set of worktrees in the OS temp directory. Measured on one machine today:
 *
 *     211M  /…/T/eject-selftest-5pC5Rk   (25 worktrees)
 *     101M  /…/T/eject-selftest-luoRbw   ( 8 worktrees)
 *
 * 312 MB from two interrupted runs, plus 33 stale worktree registrations in
 * the real repo that `git worktree prune` could not clear, because the
 * directories were still there. Nothing reports this; it is only ever found by
 * running out of disk or by counting worktrees for some other reason.
 *
 * A timeout is the ordinary way it happens — this suite spawns a lot of git
 * and is slow enough to be killed by one. SIGKILL still leaks, and nothing in
 * process can change that.
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

function sandbox() {
  const dir = join(TMP, `wt-${n++}`);
  execFileSync("git", ["worktree", "add", "--detach", "-f", dir, "HEAD"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  // Seed the sandbox from the WORKING TREE, not from HEAD.
  //
  // A worktree at HEAD is the tree as last committed, and the subject here may not be
  // committed yet — the first run of this suite died on a missing shared-census.json for
  // exactly that reason. A selftest that can only run after its subject lands is a selftest
  // that never runs when it would have helped.
  for (const rel of ["scripts/shared-census.json", "rungs.json"]) {
    copyFileSync(join(ROOT, rel), join(dir, rel));
    execFileSync("git", ["add", "--", rel], { cwd: dir, stdio: "ignore" });
  }
  // The census reads the working tree via `git ls-files`, so a planted file must be TRACKED.
  return dir;
}

function run(dir, args = []) {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [CENSUS, ...args, "--cwd", dir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function track(dir, rel, body) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
  execFileSync("git", ["add", "--", rel], { cwd: dir, stdio: "ignore" });
}

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name.padEnd(56)} ${detail}`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(56)} ${detail}`);
    fail++;
  }
}

console.log("census.mjs self-test — plants each defect it claims to catch\n");

// --- PRECONDITION: this tree must be census-clean BEFORE any case runs (#185) ----------------
//
// Two cases below assume it. "an unmodified tree passes" is FALSE BY CONSTRUCTION on a tree
// that adds a file under a frozen shared glob without re-freezing: the sandbox is a worktree at
// HEAD, so it contains that file, while `scripts/shared-census.json` is copied from the working
// tree and does not list it. The case then fails for a reason unrelated to the property it
// names, and the summary said:
//
//     FAIL: 2/7 cases wrong. The census is NOT trustworthy.
//
// A true sentence doing work it cannot do. The reader's next move is to distrust the checker
// and go reading scripts/ — when the thing to fix is the TREE. `pnpm census` gets it right in
// the same tree, naming the file and the remedy; the selftest reported a count.
//
// So the premise is checked first, and a stale tree is reported AS a stale tree, reusing
// census.mjs's own message so the remedy is identical rather than paraphrased.
{
  const pre = run(ROOT);
  if (pre.rc !== 0) {
    console.error(
      "PRECONDITION FAILED — this tree is not census-clean, so the cases below\n" +
        "cannot run honestly. Two of them assume a clean tree and would fail for a\n" +
        "reason unrelated to the property they name.\n"
    );
    console.error(pre.out.trimEnd());
    console.error(
      "\nFix the TREE, not the harness: re-freeze as the line above says, then\n" +
        "re-run. census.mjs and this harness are NOT implicated by this message."
    );
    rmSync(TMP, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: ROOT,
        stdio: "ignore",
      });
    } catch {
      /* best effort */
    }
    process.exit(1);
  }
}

// --- PRECONDITION 2: the SANDBOX must be census-clean too ------------------------------------
//
// The check above runs census against ROOT. The cases run against a WORKTREE AT HEAD seeded
// with the working tree's shared-census.json. Those two trees disagree in exactly one common
// situation, and it is the workflow this repo prescribes:
//
//     git add -A  →  pnpm census:freeze  →  git add  →  commit
//
// Between the freeze and the commit, ROOT is clean (the file is there, the census lists it)
// while the sandbox is NOT (HEAD lacks the file, the copied census still lists it). Every case
// then runs on a broken baseline, and the summary said:
//
//     FAIL: 5/10 cases wrong. The census is NOT trustworthy.
//     (The tree WAS census-clean at start-up — the precondition passed — so this
//      is the harness or census.mjs, not a stale freeze.)
//
// THAT PARENTHETICAL IS A VERDICT THE HARNESS NEVER COMPUTED. It concluded "not a stale
// freeze" from a premise about ROOT, having never looked at the tree the cases use — and it
// sent the reader into scripts/ when the fix was `git commit`. Measured: it cost a full
// detour, including a worktree at main to prove the harness was fine.
//
// Checking the premise where it is actually used removes the class rather than the message.
{
  const dir = sandbox();
  const pre = run(dir);
  if (pre.rc !== 0) {
    console.error(
      "PRECONDITION FAILED — the census freeze is not COMMITTED, so the sandbox\n" +
        "the cases run in disagrees with your working tree.\n\n" +
        "Your working tree is census-clean. The cases run against a worktree at\n" +
        "HEAD, which does not have your uncommitted file, while the census copied\n" +
        "from your working tree still lists it.\n"
    );
    console.error(pre.out.trimEnd());
    console.error(
      "\nFix: COMMIT the freeze and the files it covers, then re-run. Neither\n" +
        "census.mjs nor this harness is implicated by this message."
    );
    rmSync(TMP, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
    } catch {
      /* best effort */
    }
    process.exit(1);
  }
}

// --- ACCEPT: an unmodified tree passes -------------------------------------------------------
// Without this, a check that refuses everything would score full marks below.
{
  const dir = sandbox();
  const { rc, out } = run(dir);
  check(
    "an unmodified tree passes",
    rc === 0 && out.includes("unchanged"),
    "(passed)"
  );
}

// --- REJECT: a new SHARED file under a frozen glob -------------------------------------------
// The headline case: `attribution.pipeline.test.ts` in miniature. A plausible-looking test
// lands beside its subject, nobody classifies it, and nothing else in the repo objects.
{
  const dir = sandbox();
  const planted = "packages/server/src/__census_selftest_new__.ts";
  track(dir, planted, "export const planted = true;\n");
  const { rc, out } = run(dir);
  check(
    "a new shared file under a frozen glob is caught",
    rc !== 0 && out.includes(planted),
    "(refused, named the file)"
  );
}

// --- REJECT: a census member that disappears -------------------------------------------------
// Deletion matters as much as addition: a file leaving `shared` means a rung claimed it, or it
// is gone. Either way the frozen list is now a claim about a tree that no longer exists.
{
  const dir = sandbox();
  const victim = JSON.parse(
    readFileSync(join(dir, "scripts", "shared-census.json"), "utf8")
  ).members[0];
  execFileSync("git", ["rm", "-q", "--", victim], { cwd: dir });
  const { rc, out } = run(dir);
  check(
    "a census member that disappears is caught",
    rc !== 0 && out.includes(victim),
    "(refused, named the file)"
  );
}

// --- ACCEPT: a RUNG-OWNED file under a frozen glob is not a member ----------------------------
// Rung ownership wins. If this fired, the census would object to every ordinary rung file added
// under packages/server/** — friction with no signal, which is exactly what makes a check get
// rubber-stamped. The planted path is claimed by a rung in the same commit.
{
  const dir = sandbox();
  const planted = "packages/server/src/adapters/__census_selftest_rung__.ts";
  track(dir, planted, "export const planted = true;\n");
  const mPath = join(dir, "rungs.json");
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  m.rungs.find((r) => r.id === "open-swe").owns.ts.push(planted);
  writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
  execFileSync("git", ["add", "--", "rungs.json"], {
    cwd: dir,
    stdio: "ignore",
  });
  const { rc } = run(dir);
  check(
    "a rung-owned file under a frozen glob is ignored",
    rc === 0,
    "(passed — rung ownership wins)"
  );
}

// --- REJECT: a frozen glob removed from shared.paths ------------------------------------------
// The census would otherwise keep passing while silently covering a subset nobody chose.
{
  const dir = sandbox();
  const mPath = join(dir, "rungs.json");
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  m.shared.paths = m.shared.paths.filter((p) => p !== "packages/react/**");
  writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
  execFileSync("git", ["add", "--", "rungs.json"], {
    cwd: dir,
    stdio: "ignore",
  });
  const { rc, out } = run(dir);
  check(
    "a frozen glob dropped from shared.paths is caught",
    rc !== 0 && out.includes("no longer listed"),
    "(refused)"
  );
}

// --- REJECT: an unparseable frozen census -----------------------------------------------------
// Must fail loudly rather than treat "no members" as "nothing changed" — the vacuity case.
{
  const dir = sandbox();
  writeFileSync(join(dir, "scripts", "shared-census.json"), "{ not json");
  const { rc, out } = run(dir);
  check(
    "an unparseable census fails rather than passing empty",
    rc !== 0 && out.includes("unparseable"),
    "(refused)"
  );
}

// --- REJECT: the frozen file covers different globs than the run ------------------------------
{
  const dir = sandbox();
  const p = join(dir, "scripts", "shared-census.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  c.globs = ["packages/server/**"];
  writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`);
  const { rc, out } = run(dir);
  check(
    "a census frozen over different globs is caught",
    rc !== 0 && out.includes("re-freeze deliberately"),
    "(refused)"
  );
}

// --- REJECT: an untracked file under a frozen glob must not yield a green PASS (#209) -------
// The check enumerates via `git ls-files`, which lists TRACKED files — so the one arrival it
// most needs to notice is the one it cannot see. Harmless in CI (clean checkout); a false
// green locally at exactly the moment the check is most useful.
{
  const dir = sandbox();
  const planted = "packages/react/src/__census_selftest_untracked__.ts";
  mkdirSync(join(dir, dirname(planted)), { recursive: true });
  writeFileSync(join(dir, planted), "export const planted = true;\n");
  // Deliberately NOT `git add`ed — being invisible to the index is the whole condition.
  const { rc, out } = run(dir);
  check(
    "an untracked file under a frozen glob is not a green PASS",
    rc === 2 && out.includes(planted) && out.includes("INCONCLUSIVE"),
    `(exit ${rc}, named the file)`
  );
}

// --- ACCEPT: an untracked file a rung already OWNS is not flagged ----------------------------
// Rung ownership wins here too. Flagging it would be noise with no decision behind it, and
// noise is how a check earns the reflex to ignore it.
{
  const dir = sandbox();
  const planted = "packages/react/src/__census_selftest_owned__.tsx";
  mkdirSync(join(dir, dirname(planted)), { recursive: true });
  writeFileSync(join(dir, planted), "export const planted = true;\n");
  const mPath = join(dir, "rungs.json");
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  m.rungs.find((r) => r.id === "open-swe").owns.ts.push(planted);
  writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
  execFileSync("git", ["add", "--", "rungs.json"], {
    cwd: dir,
    stdio: "ignore",
  });
  const { rc } = run(dir);
  check(
    "an untracked file a rung owns is not flagged",
    rc === 0,
    "(passed — rung ownership wins)"
  );
}

// --- ACCEPT: a gitignored file is not flagged ------------------------------------------------
// `--exclude-standard` is load-bearing: without it every dist/ artifact and node_modules entry
// under a frozen glob would be reported, which is the same noise failure one step louder.
{
  const dir = sandbox();
  mkdirSync(join(dir, "packages/react/dist"), { recursive: true });
  writeFileSync(join(dir, "packages/react/dist/__ignored__.js"), "// built\n");
  const { rc } = run(dir);
  check(
    "a gitignored build artifact is not flagged",
    rc === 0,
    "(passed — ignored)"
  );
}

// --- Non-vacuity of this suite ----------------------------------------------------------------
const EXPECTED_CASES = 10;
const total = pass + fail;
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

console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(
    `FAIL: ${fail}/${total} cases wrong. The census is NOT trustworthy.\n` +
      `      (Both preconditions passed: ROOT is census-clean AND the sandbox at HEAD\n` +
      `      agrees with it, so a stale or uncommitted freeze is ruled out. What is\n` +
      `      left is the harness or census.mjs.)`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The census catches a new shared file, a vanished one, a\n` +
    `      dropped glob, and an unparseable freeze — and ignores rung-owned files, so its\n` +
    `      refusals mean something and its successes are not luck.`
);
