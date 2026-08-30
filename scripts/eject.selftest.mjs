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

/**
 * WHY A REFUSAL MUST PRINT ITS REASON.
 *
 * `run()` already captures eject's stdout AND stderr into `out`, and the FAIL branches
 * below printed only `rc`. So "eject refused" and "the pruning did not happen" looked
 * identical in the output — both surface as rc=1 with the artifacts unchanged. Three
 * debugging passes were spent on #183 unable to tell those apart, on a failure whose
 * cause eject had already written to stderr and this harness had already captured.
 */
function indentReason(out) {
  const lines = String(out).trim().split("\n").filter(Boolean);
  if (!lines.length) return "       (eject produced no output)";
  return lines.map((l) => `       | ${l}`).join("\n");
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
    if (rc !== 0) console.error(indentReason(out));
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

// SAY WHEN THE SUBJECT IS NOT WHAT THE READER THINKS.
//
// sandbox() builds every fixture with `git worktree add --detach HEAD`, so the suite scans the
// COMMITTED tree. Edit a file, re-run, and the failure keeps naming the line you just changed —
// which reads as "my fix does not work" rather than "you are testing something else". That cost
// three debugging passes on #183; committing flipped it to 20/20 on the first try.
//
// The check does not fail the run: running against HEAD with a dirty tree is legitimate. It just
// stops the reader inferring that their edits were included.
{
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    const n = dirty.split("\n").length;
    console.log(
      `  NOTE: ${n} uncommitted change(s) in this repo. Fixtures are built from HEAD ` +
        `(git worktree add --detach HEAD), so those edits are NOT under test.\n`
    );
  }
}

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
    if (rc !== 0) console.error(indentReason(out));
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
  const { rc, out } = run(dir, ["langchain"]);
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
    if (rc !== 0) console.error(indentReason(out));
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

/**
 * Plant a data-* declaration into BOTH protocol artifacts, attributed to `rung`.
 *
 * PLANTED, NOT BORROWED. A case that asserts `data-todo` disappears breaks the day someone
 * reclassifies it, and worse, it can go green for the wrong reason — #78's REJECT case
 * borrowed a violation from apps/example and passed the moment #69 fixed it. Planting means
 * this tests the pruner rather than the repo's current attribution table.
 *
 * Throws rather than returning a flag if it cannot plant: a silent no-op hands back a vacuous
 * case, which is the failure mode the plant-don't-borrow rule exists to remove.
 */
function plantDeclaration(dir, part, emittedBy) {
  const schemaRel = "docs/sse-frame-schema.json";
  const mapRel = "packages/react/src/schemas.ts";
  const schemaAbs = join(dir, schemaRel);
  const mapAbs = join(dir, mapRel);

  const doc = JSON.parse(readFileSync(schemaAbs, "utf8"));
  doc.oneOf.push({
    title: part,
    "x-emitted-by": emittedBy,
    properties: { type: { const: part } },
    required: ["type"],
  });
  writeFileSync(schemaAbs, JSON.stringify(doc, null, 2) + "\n");

  const src = readFileSync(mapAbs, "utf8");
  const at = src.indexOf("const SCHEMA_MAP:");
  if (at === -1) throw new Error("selftest: no SCHEMA_MAP to plant into");
  const brace = src.indexOf("{", at);
  const planted =
    src.slice(0, brace + 1) +
    `\n  "${part}": DataErrorSchema,` +
    src.slice(brace + 1);
  writeFileSync(mapAbs, planted);
  if (!readFileSync(mapAbs, "utf8").includes(`"${part}": DataErrorSchema,`)) {
    throw new Error(`selftest: plant did not take for ${part}`);
  }

  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );
  return { schemaRel, mapRel };
}

const declares = (dir, rel, part) =>
  readFileSync(join(dir, rel), "utf8").includes(`"${part}"`);

// A declaration attributed to a DROPPED rung must go from BOTH artifacts. Half-pruning is not
// a smaller version of this: a fork whose registry and published schema disagree is exactly
// what payload-triangulation now fails on, so leaving one behind would be caught late and
// somewhere else.
{
  const dir = sandbox();
  const part = "data-selftest-rung";
  const { schemaRel, mapRel } = plantDeclaration(dir, part, "deepagents");
  const { rc, out } = run(dir, ["langchain"]);
  const goneFromSchema = !declares(dir, schemaRel, part);
  const goneFromMap = !declares(dir, mapRel, part);
  if (rc === 0 && goneFromSchema && goneFromMap) {
    console.log(
      `  ok   ${"rung-attributed declaration pruned from both".padEnd(
        52
      )} (pruned)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL rung-attributed declaration survived (rc=${rc}, schema=${!goneFromSchema}, map=${!goneFromMap})`
    );
    if (rc !== 0) console.error(indentReason(out));
    fail++;
  }
}

// THE CASE MOST LIKELY TO REGRESS SILENTLY. `x-emitted-by: null` marks a frame nothing in this
// repository emits — deliberately retained (#50), because a consumer's own backend may emit
// that shape and dropping it would silently narrow a contract people already build against.
// The obvious pruning rule, "no producer in the retain set", deletes exactly these. Nothing
// downstream fails when they vanish: the fork still builds and every test still passes.
{
  const dir = sandbox();
  const part = "data-selftest-orphan";
  const { schemaRel, mapRel } = plantDeclaration(dir, part, null);
  const { rc, out } = run(dir, ["langchain"]);
  const inSchema = declares(dir, schemaRel, part);
  const inMap = declares(dir, mapRel, part);
  if (rc === 0 && inSchema && inMap) {
    console.log(
      `  ok   ${"null-emitter orphan survives eject".padEnd(52)} (retained)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL orphan was pruned (rc=${rc}, schema=${inSchema}, map=${inMap}) — #50 says keep it`
    );
    if (rc !== 0) console.error(indentReason(out));
    fail++;
  }
}

// A RETAINED FILE IMPORTING A DELETED SIBLING must refuse (#155).
//
// DIFFERENT SUBJECT FROM THE PRUNED-SYMBOL CASE ABOVE, and neither implies the other. That one
// plants `import { deepagentsAdapter } from "@deepagents-nextjs/server"` — a workspace specifier
// that still RESOLVES after ejection, where only the SYMBOL is gone. This one plants a RELATIVE
// specifier whose TARGET FILE is in the deletion set. Both are phrased as "imports", which is how
// a passing pruned-symbol case can read as though it covers this and does not.
//
// UNREACHABLE ON MAIN, DELIBERATELY PLANTED HERE. apps/open-swe is owned wholly by rung 4 today,
// so ejecting below it deletes the entire app and no retained file can dangle. #156 narrows that
// ownership and makes partial-app ejection real, at which point this class occurs for free. The
// case is written now so the guard is proven before the conditions arrive, not after.
{
  const dir = sandbox();
  // A file that SURVIVES `eject langchain`, importing one that does NOT.
  const survivor = "apps/example/app/concurrent-test/page.tsx";
  const deleted = "packages/server/src/adapters/deepagents.ts";
  const survivorAbs = join(dir, survivor);
  const before = readFileSync(survivorAbs, "utf8");
  // Relative AND in `from` form — the shape apps/open-swe/app/page.tsx actually
  // uses (`import { useRuns } from "../lib/hooks/useRuns"`). A bare side-effect
  // `import "./x"` is a DIFFERENT and also-uncovered shape; see the case below.
  const spec = "../../../../packages/server/src/adapters/deepagents";
  writeFileSync(
    survivorAbs,
    `import { deepagentsAdapter as _p } from "${spec}";\nvoid _p;\n${before}`
  );
  if (!readFileSync(survivorAbs, "utf8").includes(spec)) {
    throw new Error("selftest: dangling-import plant did not take");
  }
  if (!existsSync(join(dir, deleted))) {
    throw new Error(`selftest: ${deleted} absent, so the plant proves nothing`);
  }
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );

  const { rc, out } = run(dir, ["langchain"]);
  const named = out.includes(spec) || out.includes(survivor);
  if (rc !== 0 && named) {
    console.log(
      `  ok   ${"retained file importing a deleted sibling is caught".padEnd(
        52
      )} (refused)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL retained file importing a deleted sibling survived (rc=${rc}, named=${named})`
    );
    if (rc !== 0) console.error(indentReason(out));
    fail++;
  }
}

// SIDE-EFFECT AND DYNAMIC IMPORTS dangle too (#155).
//
// The case above uses `import { x } from "./y"`. This one uses `import "./y"` — no `from`, so the
// original check-1 pattern did not match it and eject succeeded over a fork that cannot build.
// Not hypothetical: `import "./globals.css"` is in every Next layout here, and there are 15
// `await import("./…")` call sites. Both were exempt.
{
  const dir = sandbox();
  const survivor = "apps/example/app/concurrent-test/page.tsx";
  const survivorAbs = join(dir, survivor);
  const before = readFileSync(survivorAbs, "utf8");
  const spec = "../../../../packages/server/src/adapters/deepagentsEnrich";
  writeFileSync(survivorAbs, `import "${spec}";\n${before}`);
  if (!readFileSync(survivorAbs, "utf8").includes(`import "${spec}"`)) {
    throw new Error("selftest: side-effect import plant did not take");
  }
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );
  const { rc, out } = run(dir, ["langchain"]);
  if (rc !== 0 && (out.includes(spec) || out.includes(survivor))) {
    console.log(
      `  ok   ${"side-effect import of a deleted file is caught".padEnd(
        52
      )} (refused)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL side-effect import of a deleted file survived (rc=${rc})`
    );
    if (rc !== 0) console.error(indentReason(out));
    fail++;
  }
}

// THE EXEMPTION MUST NOT BE EARNABLE BY A LINE THAT NEVER BRANCHES (#180).
//
// eject exempts a reference to a deleted app when a has-rung.mjs guard appears within 25 lines.
// DEV5 established the window was a plain text search, so `echo "... has-rung.mjs open-swe"` —
// code, not a comment, therefore surviving the comment-blanking — exempted everything under it.
//
// These two cases are a PAIR and neither is worth anything alone. The first proves a decorative
// mention is refused; on its own it would also pass if the exemption were deleted outright. The
// second proves a real guard still proceeds. Together they say the exemption discriminates.
// THE PLANT STRINGS ARE ASSEMBLED, NOT WRITTEN OUT, and that is not style.
// eject scans every retained .mjs — including this file — for `apps/<deleted-app>`. Spelled
// literally, these fixtures ARE such a reference, so eject refused three times and named this
// selftest. The checker cannot tell a dependency from a description of one, and exempting the
// file would blind it to a real reference here later. Assembling the path leaves nothing to match.
/*
 * A WORKSPACE APP THAT `eject langchain` REALLY DELETES, CONSTRUCTED ON PURPOSE (#154).
 *
 * The four cases below all exercise guard #2 — "a retained config still names a deleted
 * workspace app" — and every one of them needs a deleted app to point at. They pointed at
 * `apps/open-swe`, which rung 4 owned in its entirety, so `eject langchain` removed the whole
 * directory and the guard had a live subject.
 *
 * #154 ended that. The shell moved to `shared` and rung 4 now owns only the run surface INSIDE a
 * surviving app, so NO workspace app is deleted at any rung of this ladder. eject derives
 * `deletedApps` from the deletion set and requires the directory to be gone, so that set is now
 * empty on every eject and the guard has nothing to fire on.
 *
 * TWO OF THESE CASES WENT RED, WHICH IS THE HONEST HALF. The other two stayed GREEN AND STOPPED
 * MEANING ANYTHING: "a vendored path is NOT flagged" and "a branching guard DOES exempt" both
 * assert that eject PROCEEDS, and eject proceeds trivially when there is no deleted app to flag.
 * Repairing only the red pair would have left two checks that name a property and cannot detect
 * its loss — worse than absent, because green reads as coverage. All four are rebuilt.
 *
 * The fixture is a real directory under apps/, claimed by rung 2, which `eject langchain` drops.
 * eject removes now-empty directories, so the app satisfies the `!existsSync` test that makes it
 * count as deleted.
 */
const DEL_APP = "zz-eject-fixture";
const DEL_PATH = `apps/${DEL_APP}`;

/**
 * A sandbox whose tree contains DEL_APP, owned by a rung that `eject langchain` drops.
 *
 * Built by hand rather than through `sandbox(mutate)` because the order matters: the file has to
 * exist BEFORE the manifest claims it, or classify fails C4 ("a glob matching zero tracked
 * files") and eject refuses for a reason that has nothing to do with the case under test. It
 * also has to be `git add`ed, not just written, since eject reads the committed tree and refuses
 * on an untracked file.
 */
function sandboxWithDeletedApp() {
  const dir = sandbox();
  mkdirSync(join(dir, "apps", DEL_APP), { recursive: true });
  writeFileSync(
    join(dir, "apps", DEL_APP, "index.ts"),
    "export const fixture = true;\n"
  );
  const p = join(dir, "rungs.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  const rung = m.rungs.find((r) => r.id === "langgraph");
  rung.owns.ts.push(`apps/${DEL_APP}/**`);
  rung.ownedFileCount += 1;
  writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "fixture app",
    ],
    { cwd: dir, stdio: "ignore" }
  );
  return dir;
}
for (const [label, plant, wantRefusal] of [
  [
    "decorative has-rung mention does NOT exempt",
    `echo "see: node scripts/has-rung.mjs ${DEL_APP}"\nls ${DEL_PATH} >/dev/null 2>&1 || true\n`,
    true,
  ],
  [
    "a branching has-rung guard DOES exempt",
    `if ! __probe=$(node "$REPO/scripts/has-rung.mjs" ${DEL_APP}); then __probe=no; fi\n` +
      `[ "$__probe" = "yes" ] && ls ${DEL_PATH} >/dev/null 2>&1\n`,
    false,
  ],
]) {
  const dir = sandboxWithDeletedApp();
  const target = "scripts/dev-demo.sh";
  const abs = join(dir, target);
  const before = readFileSync(abs, "utf8");
  // 30 BLANK LINES FIRST, and they are load-bearing. dev-demo.sh carries its own legitimate
  // guard at :208 and the file is 220 lines, so a plant appended directly would land INSIDE
  // that guard's 25-line window and be exempted by a guard that has nothing to do with it.
  // The refusal case would then fail, and the proceed case would pass for the wrong reason.
  writeFileSync(abs, before + "\n".repeat(30) + plant);
  if (!readFileSync(abs, "utf8").includes(DEL_PATH)) {
    throw new Error("selftest: guard-exemption plant did not take");
  }
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );
  const { rc, out } = run(dir, ["langchain"]);
  const refused = rc !== 0;
  const ok = refused === wantRefusal && (!refused || out.includes(target));
  if (ok) {
    console.log(
      `  ok   ${label.padEnd(52)} (${refused ? "refused" : "proceeded"})`
    );
    pass++;
  } else {
    console.error(
      `  FAIL ${label} (rc=${rc}, wanted ${
        wantRefusal ? "refusal" : "success"
      })`
    );
    console.error(indentReason(out));
    fail++;
  }
}
for (const [label, plant, wantRefusal] of [
  [
    "decorative has-rung mention does NOT exempt",
    `echo "see: node scripts/has-rung.mjs ${DEL_APP}"\nls ${DEL_PATH} >/dev/null 2>&1 || true\n`,
    true,
  ],
  [
    "a branching has-rung guard DOES exempt",
    `if ! __probe=$(node "$REPO/scripts/has-rung.mjs" ${DEL_APP}); then __probe=no; fi\n` +
      `[ "$__probe" = "yes" ] && ls ${DEL_PATH} >/dev/null 2>&1\n`,
    false,
  ],
]) {
  const dir = sandboxWithDeletedApp();
  const target = "scripts/dev-demo.sh";
  const abs = join(dir, target);
  const before = readFileSync(abs, "utf8");
  // 30 BLANK LINES FIRST, and they are load-bearing. dev-demo.sh carries its own legitimate
  // guard at :208 and the file is 220 lines, so a plant appended directly would land INSIDE
  // that guard's 25-line window and be exempted by a guard that has nothing to do with it.
  // The refusal case would then fail, and the proceed case would pass for the wrong reason.
  writeFileSync(abs, before + "\n".repeat(30) + plant);
  if (!readFileSync(abs, "utf8").includes(DEL_PATH)) {
    throw new Error("selftest: guard-exemption plant did not take");
  }
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );
  const { rc, out } = run(dir, ["langchain"]);
  const refused = rc !== 0;
  const ok = refused === wantRefusal && (!refused || out.includes(target));
  if (ok) {
    console.log(
      `  ok   ${label.padEnd(52)} (${refused ? "refused" : "proceeded"})`
    );
    pass++;
  } else {
    console.error(
      `  FAIL ${label} (rc=${rc}, wanted ${
        wantRefusal ? "refusal" : "success"
      })`
    );
    console.error(indentReason(out));
    fail++;
  }
}

// A VENDORED TREE THAT CONTAINS A DIRECTORY OF THE SAME NAME IS NOT A REFERENCE (#199).
//
// eject matched `apps/<deleted-app>` as a bare substring, so any line containing those
// characters was a dangling reference. Rung 5 vendors an upstream checkout that has its OWN
// `apps/open-swe/…` — a different directory from our rung-4 app — and eject refused over it.
// A checker that cannot tell its subject from something sharing its name is reporting on the
// wrong object.
//
// A PAIR again, and the control is the half that matters: a fix that simply stopped flagging
// path-shaped matches would pass the vendored case and silently stop catching real references.
for (const [label, plant, wantRefusal] of [
  [
    "a vendored path sharing the app name is NOT flagged",
    `VENDORED="vendor/rung5/${DEL_PATH}/webhook.ts"\necho "$VENDORED" >/dev/null\n`,
    false,
  ],
  [
    "a repo-root-relative path to the deleted app IS flagged",
    `OURS="$REPO/${DEL_PATH}/agent/server.mjs"\necho "$OURS" >/dev/null\n`,
    true,
  ],
]) {
  const dir = sandboxWithDeletedApp();
  const target = "scripts/dev-demo.sh";
  const abs = join(dir, target);
  // 30 blank lines: dev-demo.sh carries its own guard at :208 and the exemption window is 25
  // lines, so a plant appended directly is exempted by a guard unrelated to it.
  writeFileSync(abs, readFileSync(abs, "utf8") + "\n".repeat(30) + plant);
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "plant"],
    { cwd: dir, stdio: "ignore" }
  );
  const { rc, out } = run(dir, ["langchain"]);
  const refused = rc !== 0;
  const ok = refused === wantRefusal && (!refused || out.includes(target));
  if (ok) {
    console.log(
      `  ok   ${label.padEnd(52)} (${refused ? "refused" : "proceeded"})`
    );
    pass++;
  } else {
    console.error(
      `  FAIL ${label} (rc=${rc}, wanted ${
        wantRefusal ? "refusal" : "success"
      })`
    );
    console.error(indentReason(out));
    fail++;
  }
}

// --- Non-vacuity of this suite ---------------------------------------------------------------
/*
 * WHICH TREE EJECT DELETES, WHEN THE OPERATOR DID NOT SAY (#338).
 *
 * `--cwd` omitted used to mean "the script's own repository", so invoking eject BY PATH from
 * another worktree deleted files somewhere the command line never named. That is not a
 * hypothetical: it removed 417 files from a worktree while the one named on the command line
 * sat untouched.
 *
 * THESE THREE ARE A SET AND NONE IS WORTH ANYTHING ALONE. The refusal case alone would also
 * pass if eject refused every bare invocation, which would break `pnpm eject`. The subdirectory
 * case is the control that says the ordinary path still works. The `--cwd` case says the escape
 * hatch the refusal advertises actually functions — a refusal that names a flag which does not
 * work is worse than no refusal.
 *
 * They run eject WITHOUT `--cwd`, which every other case in this file passes, so they need
 * their own runner: the whole subject here is what happens when that flag is absent.
 */
function runFrom(cwd, args) {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [EJECT, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

{
  // 1. AMBIGUOUS: the script is in ROOT's tree, the operator is standing in a sandbox.
  const dir = sandbox();
  const { rc, out } = runFrom(dir, ["langchain"]);
  // Both candidate trees must be NAMED. "ambiguous" on its own leaves the operator to work out
  // which two things were ambiguous, which is the position the original defect left them in.
  const namesBoth = out.includes(dir) && out.includes(ROOT.replace(/\/$/, ""));
  const ok = rc !== 0 && namesBoth && /ambiguous target/.test(out);
  const label = "no --cwd, foreign cwd: REFUSED, naming both trees";
  if (ok) {
    console.log(`  ok   ${label.padEnd(52)} (refused)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} (rc=${rc}, namesBoth=${namesBoth})`);
    console.error(indentReason(out));
    fail++;
  }
  // AND IT MUST HAVE CHANGED NOTHING. A guard that refuses after deleting is not a guard, and
  // the refusal text alone cannot tell you which happened.
  const clean =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
    }).trim() === "";
  const label2 = "...and the refusal touched neither tree";
  if (clean) {
    console.log(`  ok   ${label2.padEnd(52)} (tree clean)`);
    pass++;
  } else {
    console.error(`  FAIL ${label2} — the sandbox is dirty after a refusal`);
    fail++;
  }
}

{
  // 2. CONTROL — the ordinary path must still work. A subdirectory of the SAME tree is not
  //    ambiguous: `git rev-parse --show-toplevel` resolves it to that tree, which is how
  //    `pnpm eject` behaves when run from anywhere inside the repo. Without this case, a fix
  //    that refused every bare invocation would satisfy case 1 and break `pnpm eject`.
  //
  //    IT TESTS ROOT's LIVE SCRIPT, like every other case in this file, and runs from a
  //    subdirectory of ROOT — which means the tree it resolves IS this repository. `--dry-run`
  //    is therefore load-bearing rather than tidy: it is what makes "target the real repo"
  //    safe to assert.
  //
  //    A sandbox's own copy of the script was tried first and is wrong here: sandboxes are
  //    worktrees of HEAD, so they carry the COMMITTED eject.mjs and a working-tree change to
  //    the resolution logic is invisible to them. The case passed for the old code and failed
  //    for the new. Same committed-tree trap as test:eject and freeze:all.
  const sub = join(ROOT, "scripts");
  const { rc, out } = runFrom(sub, ["langchain", "--dry-run"]);
  const label = "no --cwd, subdirectory of the SAME tree: PROCEEDS";
  // Proceeding is not enough — it must have targeted THAT tree. The printed target is the only
  // place that is observable, which is half of why eject prints it.
  const expected = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: sub,
    encoding: "utf8",
  }).trim();
  const ok = rc === 0 && out.includes(`tree   : ${expected}`);
  if (ok) {
    console.log(`  ok   ${label.padEnd(52)} (proceeded, targeting it)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} (rc=${rc})`);
    console.error(indentReason(out));
    fail++;
  }
}

{
  // 3. The escape hatch the refusal advertises. Same foreign cwd as case 1, plus the flag it
  //    tells you to pass: it must proceed AND target the directory named, not the script's.
  const dir = sandbox();
  const { rc, out } = runFrom(dir, ["langchain", "--dry-run", "--cwd", dir]);
  const label = "--cwd overrides a foreign cwd, and targets it";
  const ok = rc === 0 && out.includes(`tree   : ${dir}`);
  if (ok) {
    console.log(`  ok   ${label.padEnd(52)} (proceeded, targeting it)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} (rc=${rc})`);
    console.error(indentReason(out));
    fail++;
  }
}

// AN EMPTIED PROJECT IS REMOVED, NOT LEFT WITH `testMatch: []` (#385).
//
// Nothing is planted here, because nothing needs to be: playwright.config.ts really does
// declare `open-swe` with a MULTI-LINE testMatch, and ejecting to langchain really does
// delete every spec it names. That combination is the bug. The first pruning pass reads
// only the first line of the array — `block.match(/testMatch:\s*(.+)/)` sees `[` and no
// spec name — so the project survives the pass that was supposed to drop it, and the
// entry filter then strips it down to `testMatch: []`.
//
// THE ASSERTION IS THAT THE PROJECT IS ABSENT, and that is the whole point of the case.
// Asserting `testMatch: []` was the tempting form and it is the bug restated as a
// requirement: an empty array is precisely what the broken eject produced, so a test
// demanding one would have passed on the defect and failed on the fix.
//
// playwright.config.ts states the rule itself, on chromium-matrix: "a project that then
// matches zero files must be REMOVED from this config, not left silently empty." It was
// written down here and enforced over there — an ejected fork failed its own
// `check:e2e-registration`, which exists to catch a project that passes by running
// nothing — and broken in between.
{
  const dir = sandbox();
  const { rc, out } = run(dir, ["langchain"]);
  if (rc !== 0) {
    throw new Error(
      `selftest: eject langchain refused, so this case proves nothing:\n${out}`
    );
  }
  const cfgPath = join(dir, "playwright.config.ts");
  if (!existsSync(cfgPath)) {
    throw new Error("selftest: no playwright.config.ts after eject");
  }
  const cfg = readFileSync(cfgPath, "utf8");
  // The plant-free precondition: this case is only meaningful while `open-swe` is a
  // project whose specs langchain deletes. If someone reparents it, say so rather than
  // passing vacuously.
  const beforeCfg = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
  if (!/name:\s*"open-swe"/.test(beforeCfg)) {
    throw new Error(
      "selftest: no open-swe project in the source config — this case is vacuous"
    );
  }

  const label = "emptied project is REMOVED, not left empty";
  if (!/name:\s*"open-swe"/.test(cfg)) {
    console.log(`  ok   ${label.padEnd(52)} (project absent)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — the open-swe project survived eject`);
    fail++;
  }

  // The general form. The case above names one project; this one is the rule, and is
  // what catches the next multi-line testMatch someone adds.
  const label2 = "...and no project is left matching zero files";
  if (!/testMatch:\s*\[\s*\]/.test(cfg)) {
    console.log(`  ok   ${label2.padEnd(52)} (none empty)`);
    pass++;
  } else {
    console.error(`  FAIL ${label2} — an empty testMatch remains in the fork`);
    fail++;
  }
}

/*
 * 32, not 30: the #385 pair (an emptied project is removed, and no project is left
 * matching zero files) adds two.
 *
 * 30, not 28: the guard-2 fixture (#154) adds a case that the refusal LEFT THE TREE CLEAN, and
 * runs the pair against a constructed app rather than against apps/open-swe — which the
 * reparent stops deleting. See the block above for why all four had to be rebuilt and not
 * only the two that went red.
 */
const EXPECTED_CASES = 32;
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
