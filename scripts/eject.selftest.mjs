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
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
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
    // COMMIT the mutation. Since the clean-tree gate landed, an uncommitted edit makes eject
    // refuse for being dirty — correct, but it would mask every census case below behind the
    // wrong reason. Committing isolates each case to the guard it is actually testing, which is
    // why those cases assert WHICH guard fired rather than just a non-zero exit.
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "mutate"],
      {
        cwd: dir,
        stdio: "ignore",
      }
    );
  }
  return dir;
}

function run(dir, args) {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [EJECT, ...args, "--cwd", dir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
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
    console.error(
      `       ${
        out.split("\n").find((l) => l.startsWith("FAIL")) ?? out.slice(0, 160)
      }`
    );
    fail++;
  } else {
    console.error(
      `  FAIL ${name.padEnd(52)} PROCEEDED — the guard did not fire`
    );
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
    console.error(
      `  FAIL ${name.padEnd(
        52
      )} expected success containing "${needle}", rc=${rc}`
    );
    console.error(
      `       ${out.split("\n").filter(Boolean).slice(-3).join("\n       ")}`
    );
    fail++;
  }
}

/**
 * Plant an import of a symbol that `eject langchain` will prune, into a file that survives it.
 *
 * Appended to an existing SHARED, tracked file rather than a new one: a new file would be
 * unclassified, and eject would refuse for a stale census before reaching the check under test —
 * a refusal for the wrong reason looks identical to the right one at the exit code.
 *
 * Throws rather than returning a flag if it cannot plant. A plant that silently no-ops would
 * hand back a vacuous case, which is the failure mode this whole rewrite exists to remove.
 */
function plantPrunedSymbolImport(dir) {
  const pkg = "@deepagents-nextjs/server";
  const symbol = "deepagentsAdapter"; // rung-3-owned, so `eject langchain` prunes it
  const candidates = execFileSync("git", ["ls-files", "apps/example"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
  const file = candidates[0];
  if (!file)
    throw new Error(
      "selftest: no shared TS file in apps/example to plant into"
    );

  const abs = join(dir, file);
  const line = `\nimport { ${symbol} as __plantedForSelftest } from "${pkg}";\n`;
  writeFileSync(abs, readFileSync(abs, "utf8") + line);
  if (
    !readFileSync(abs, "utf8").includes(`{ ${symbol} as __plantedForSelftest }`)
  ) {
    throw new Error(`selftest: plant did not take in ${file}`);
  }
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    {
      cwd: dir,
      stdio: "ignore",
    }
  );
  return { pkg, symbol, file };
}

console.log(
  "eject.mjs self-test — refuses what it must, proceeds where it should\n"
);

// --- REFUSALS: guards that only fire on input a healthy repo never produces ------------------

expectRefuse("unknown rung name", ["not-a-rung"], "unknown rung");

expectRefuse("no rung given", [], "usage:");

// A stale census is the dangerous one: ejecting against an incomplete classification is exactly
// how you get an incoherent-but-green fork. eject must exit BEFORE touching the tree.
expectRefuse(
  "stale census — a glob matching nothing",
  ["langgraph"],
  "classification is not clean",
  (m) => {
    m.rungs[0].owns.ts.push("packages/server/src/adapters/ghost.ts");
  }
);

expectRefuse(
  "stale census — a rung file left in shared",
  ["langgraph"],
  "classification is not clean",
  (m) => {
    m.rungs.find((r) => r.id === "open-swe").owns.docs = [];
  }
);

// The deletion count is an EXACT equality against the frozen census. It must reject a manifest
// whose count disagrees with the tree in EITHER direction — an under-count would let eject
// delete more than declared, an over-count less.
expectRefuse(
  "frozen count too low for the tree",
  ["langgraph"],
  "classification is not clean",
  (m) => {
    m.rungs.find((r) => r.id === "deepagents").ownedFileCount -= 1;
  }
);
expectRefuse(
  "frozen count too high for the tree",
  ["langgraph"],
  "classification is not clean",
  (m) => {
    m.rungs.find((r) => r.id === "deepagents").ownedFileCount += 1;
  }
);

// --- PROCEEDS: the other half of the test, and the half that is easy to forget ---------------
//
// Without these, an eject that refused unconditionally would pass every case above.

expectProceed(
  "dry-run on the real manifest",
  ["deepagents", "--dry-run"],
  "census agrees"
);

expectProceed(
  "dry-run reports the correct retain set",
  ["langgraph", "--dry-run"],
  "retain : langchain, langgraph"
);

// Ejecting to the top rung is a legitimate no-op, not an error: a fork that wants everything is
// still a fork. If this failed, `eject <top>` would look broken to the first person who tried it.
expectProceed(
  "eject to the top rung is a no-op",
  [
    JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8")).rungs.slice(
      -1
    )[0].id,
  ],
  "nothing to do"
);

// --- D2/D3: two defects that could not fail, and the proofs that they now can ---------------

// D3 — the leak check was blind to workspace-BARREL symbol imports. `import { PlanCard } from
// "@deepagents-nextjs/react"` after PlanCard is pruned: the specifier resolves, the package
// exists, only the symbol is gone. That was 100% of apps/example's breakage, and it is why
// "eject succeeded, zero dangling references" and "example#build fails" were both true at once.
//
// THE VIOLATION IS PLANTED, NOT BORROWED — and this case had to learn that the hard way.
//
// It used to run `eject langchain` against the real tree and expect apps/example's broken
// imports to be there. They were, so it passed. Then #69 FIXED apps/example, eject came back
// clean, and the case failed with rc=0 — the check's subject was a bug, so fixing the bug broke
// the check. A guard that depends on the defect it guards against continuing to exist is worth
// exactly nothing the day someone fixes it, which is the day you most want it working.
//
// So it plants its own violation into a tree that is otherwise correct. Same principle as
// pinning a branch rather than the manifest: the case now tests eject, not the repo's current
// state of repair.
{
  const dir = sandbox();
  const planted = plantPrunedSymbolImport(dir);
  const { rc, out } = run(dir, ["langchain"]);
  const caught = out.includes(`{ ${planted.symbol} } from "${planted.pkg}"`);
  if (rc !== 0 && caught) {
    console.log(
      `  ok   ${"planted pruned-symbol import is caught".padEnd(
        52
      )} (refused: ${planted.symbol})`
    );
    pass++;
  } else {
    console.error(
      `  FAIL planted pruned-symbol import NOT caught (rc=${rc}, planted ${planted.symbol} in ${planted.file})`
    );
    fail++;
  }
}

// The accept half, and the one that matters most here: packages/ui's barrel is 20 `export *`
// re-exports, and a parser that stopped at the top level called 39 untouched primitives
// "no longer exported". A check that cries wolf gets disabled — worse than the blindness it
// replaced. A coherent fork must come back clean.
{
  const dir = sandbox();
  const { rc, out } = run(dir, ["open-swe"]);
  if (rc === 0 && !out.includes("no longer exports it")) {
    console.log(
      `  ok   ${"coherent fork reports no barrel leaks".padEnd(52)} (proceeded)`
    );
    pass++;
  } else {
    console.error(`  FAIL coherent fork reported barrel leaks (rc=${rc})`);
    fail++;
  }
}

// D2 — `--cwd` regenerated the SOURCE repo's generated.ts and never the fork's, so a one-rung
// fork shipped a typed manifest declaring all five. Unfalsifiable in the worst way: the subject
// it checked was the source repo, which is correct by construction. A manifest-driven UI
// validated through --cwd would render five rungs in a one-rung fork and look right.
{
  const dir = sandbox();
  const { rc } = run(dir, ["langchain"]);
  const manifestIds = JSON.parse(
    readFileSync(join(dir, "rungs.json"), "utf8")
  ).rungs.map((r) => r.id);
  const gen = readFileSync(
    join(dir, "packages", "rungs", "src", "generated.ts"),
    "utf8"
  );
  const declared = (gen.match(/RUNG_IDS = \[([^\]]*)\]/)?.[1] ?? "")
    .split(",")
    .map((x) => x.trim().replace(/"/g, ""))
    .filter(Boolean);
  const agree =
    manifestIds.length === declared.length &&
    manifestIds.every((x, i) => x === declared[i]);
  if (rc !== 0 || agree) {
    console.log(
      `  ok   ${"--cwd regenerates the FORK's typed manifest".padEnd(
        52
      )} (${manifestIds.join(",")})`
    );
    pass++;
  } else {
    console.error(
      `  FAIL --cwd left the fork's generated.ts stale: manifest=[${manifestIds}] generated=[${declared}]`
    );
    fail++;
  }
}

// --- ATOMICITY: eject must never leave a tree that is neither the original nor a fork --------
//
// A run once died on ENOENT having ALREADY DELETED 134 tracked files, and the next run refused
// with "stale census" naming files the first run had destroyed — the guard correctly reporting
// damage the tool itself had caused a minute earlier. "Just git checkout" is no answer for the
// audience: a forker clones the reference implementation, runs the one command it is built
// around, and may have committed nothing.
//
// EVERY CASE HERE ASSERTS THE TREE IS UNCHANGED, not merely that eject exited non-zero.
// "It failed" and "it failed without damage" are different claims and only the second is the fix.

/** git status --porcelain line count, and tracked-file count. Both must survive a failed run. */
function treeState(dir) {
  const porcelain = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n").length;
  return {
    dirty: porcelain ? porcelain.split("\n").length : 0,
    tracked,
    porcelain,
  };
}

function expectUndamaged(name, dir, run_) {
  const before = treeState(dir);
  const { rc } = run_();
  const after = treeState(dir);
  if (rc === 0) {
    console.error(
      `  FAIL ${name.padEnd(52)} expected failure, eject succeeded`
    );
    fail++;
    return;
  }
  if (after.dirty === before.dirty && after.tracked === before.tracked) {
    console.log(
      `  ok   ${name.padEnd(52)} (failed; ${
        after.tracked
      } files intact, tree clean)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL ${name.padEnd(52)} TREE DAMAGED: ` +
        `tracked ${before.tracked}->${after.tracked}, dirty ${before.dirty}->${after.dirty}`
    );
    console.error(
      `       ${after.porcelain.split("\n").slice(0, 3).join("\n       ")}`
    );
    fail++;
  }
}

// A failure AFTER deletion has begun — the case that actually happened. rungs.json is rewritten
// post-delete, so making it read-only fails once ~130 files are already gone. Rollback must put
// every one of them back.
{
  const dir = sandbox();
  const manifest = join(dir, "rungs.json");
  chmodSync(manifest, 0o444);
  expectUndamaged("mid-run failure AFTER deletion rolls back", dir, () =>
    run(dir, ["langgraph"])
  );
  chmodSync(manifest, 0o644);
}

// A tracked path eject cannot remove. Pre-flight should catch this BEFORE unlinking anything, so
// this is the cheaper outcome: a failure that never started rather than one that rolled back.
{
  const dir = sandbox();
  const locked = join(dir, "apps", "open-swe", "lib", "sandbox");
  if (existsSync(locked)) {
    chmodSync(locked, 0o500);
    expectUndamaged("unremovable path caught by pre-flight", dir, () =>
      run(dir, ["langgraph"])
    );
    chmodSync(locked, 0o755);
  } else {
    console.error(
      "  FAIL pre-flight fixture path missing — update the selftest"
    );
    fail++;
  }
}

// The clean-tree gate. An UNTRACKED file is the confusing one: a git-based classifier cannot see
// it, so it is unclassified and would be swept. The gate makes that impossible to hit by
// accident — and the file must still be there afterwards.
{
  const dir = sandbox();
  const scratch = join(dir, "my-scratch-notes.txt");
  writeFileSync(scratch, "notes a forker copied in");
  const { rc, out } = run(dir, ["langgraph"]);
  const survived = existsSync(scratch);
  if (rc !== 0 && out.includes("working tree is not clean") && survived) {
    console.log(
      `  ok   ${"untracked file blocks eject and survives".padEnd(
        52
      )} (refused)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL untracked-file gate (rc=${rc}, survived=${survived})`
    );
    fail++;
  }
}

// And the accept half: --dry-run changes nothing, so a dirty tree must NOT block it. Without
// this the gate would be indistinguishable from one that refuses everything.
{
  const dir = sandbox();
  writeFileSync(join(dir, "dirty.txt"), "x");
  const { rc, out } = run(dir, ["langgraph", "--dry-run"]);
  if (rc === 0 && out.includes("census agrees")) {
    console.log(
      `  ok   ${"--dry-run works on a dirty tree".padEnd(52)} (proceeded)`
    );
    pass++;
  } else {
    console.error(`  FAIL --dry-run blocked by the clean-tree gate (rc=${rc})`);
    fail++;
  }
}

// --- Non-vacuity of this suite ---------------------------------------------------------------
const EXPECTED_CASES = 16;
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
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(
    `FAIL: ${fail}/${total} cases wrong. eject's guards are NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. eject refuses a stale census and a bad rung, and proceeds on a\n` +
    `      healthy one — so its refusals mean something and its successes are not luck.`
);
