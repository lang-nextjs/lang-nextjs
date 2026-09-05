#!/usr/bin/env node
/**
 * Proves scripts/assert-census-fresh.mjs can FAIL — do not remove.
 *
 * The whole justification for this checker is ONE case: two branches that write
 * the SAME ownedFileCount merge cleanly, and the result is stale. If the
 * selftest cannot construct that case, the checker has no demonstrated reason
 * to exist and its green means only that nothing crashed.
 *
 * WHY THE UNTOUCHED CASE WAS MISSING, which generalises past this file: the
 * first two fixtures were both DERIVED FROM THE FAILURE MODE BEING FIXED, so
 * both changed rungs.json — and neither could see a branch that does not. That
 * is not a missing test; a missing test is visibly absent. These were present,
 * numerous, and systematically correlated, because they came from one source of
 * examples.
 *
 * The question worth asking of any new gate: WHAT DO ALL MY FIXTURES SHARE THAT
 * THE REAL INPUT DOES NOT? When selftest fixtures come from a bug list, the
 * untested case is whatever the bugs had in common.
 *
 * THE IDENTITY CASE EARNED ITS ASSERTION THE HARD WAY. It used to check only
 * `exit === 0`, which a self-merge satisfies trivially — and I then merged a PR
 * on the strength of exactly that green, because `git fetch origin main other`
 * leaves FETCH_HEAD holding the FIRST ref and `--head FETCH_HEAD` silently meant
 * `main`. The tool was right; the invocation asked a different question. It now
 * prints the resolved pair and announces the identity, and this case asserts
 * that it does.
 *
 * So case SILENT below builds it for real — two throwaway branches off one
 * base, each adding one rung-owned file, each frozen with the REAL freeze:all —
 * and asserts BOTH that git merges them without conflict AND that the checker
 * catches what git missed. Either half alone proves nothing: a conflict would
 * mean git already handles it, and a catch without the clean merge would not
 * show the check was needed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSetupChanged } from "./lib/fixture-premise.mjs";
import { probeWorktrees } from "./lib/probe-worktrees.mjs";

const ROOT = process.cwd();
const CHECKER = join(ROOT, "scripts", "assert-census-fresh.mjs");
const git = (a, cwd = ROOT) =>
  execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 << 20 }).trim();

function run(base, head) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--base", base, "--head", head], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/**
 * A throwaway branch off `base` that adds one RUNG-OWNED file and freezes.
 *
 * THE PATH IS LOAD-BEARING AND IT MOVED (#154). This planted
 * `apps/open-swe/lib/zz-probe-<tag>.ts`, rung-owned only because rung 4 owned
 * `apps/open-swe/**` wholesale. The reparent narrowed that to the run surface, so the same
 * path became SHARED — the freeze changed no count, both branches froze identically, there
 * was no collision to detect, and the SILENT case reported the checker passing on a scenario
 * it could no longer construct. `lib/sandbox/` is claimed by rung 4 as a DIRECTORY glob, so a
 * new file in it is owned without a manifest edit, which is what this fixture needs.
 *
 * AND THE PLANT VERIFIES ITSELF, because a fixture that quietly stops being what it says is
 * the defect this file exists to catch, one level up.
 */
function branchAddingOneFile(base, tag) {
  const wt = mkdtempSync(join(tmpdir(), `cfst-${tag}-`));
  git(["worktree", "add", "-q", "--detach", wt, base]);
  // ONE definition of the path, used to plant AND to report, so a diagnostic cannot name a
  // file it did not write.
  const rel = `apps/open-swe/lib/sandbox/zz-probe-${tag}.ts`;
  const before = readFileSync(join(wt, "rungs.json"), "utf8");
  writeFileSync(join(wt, ...rel.split("/")), "export const x = 1;\n");
  git(["add", "-A"], wt);
  execFileSync("node", [join(wt, "scripts", "freeze-all.mjs")], {
    cwd: wt,
    stdio: "ignore",
  });
  // Through the shared helper since #375, so this repo has ONE implementation of "the setup
  // achieved its precondition" rather than a good one here and none anywhere else.
  requireSetupChanged(
    before,
    readFileSync(join(wt, "rungs.json"), "utf8"),
    `planting ${rel} changed no ownedFileCount, so it is not rung-owned in this tree. The ` +
      `SILENT case cannot construct a collision without it. Move the plant to a path some ` +
      `rung owns by DIRECTORY glob`
  );
  git(["add", "-A"], wt);
  git(
    [
      "-c",
      "user.email=selftest@local",
      "-c",
      "user.name=selftest",
      "commit",
      "-q",
      "-m",
      `probe-${tag}`,
    ],
    wt
  );
  const sha = git(["rev-parse", "HEAD"], wt);
  return { wt, sha };
}

const cleanup = [];
let pass = 0;
const cases = [];

const BASE = git(["rev-parse", "HEAD"]);

// ---- the case the checker exists for -------------------------------------
{
  const a = branchAddingOneFile(BASE, "a");
  const b = branchAddingOneFile(BASE, "b");
  cleanup.push(a.wt, b.wt);

  const mt = (() => {
    try {
      return execFileSync("git", ["merge-tree", "--write-tree", a.sha, b.sha], {
        cwd: ROOT,
        encoding: "utf8",
      });
    } catch (e) {
      return (e.stdout ?? "") + (e.stderr ?? "");
    }
  })();
  const mergesCleanly = !/CONFLICT/i.test(mt);

  const r = run(a.sha, b.sha);
  cases.push({
    name: "SILENT   two +1 branches merge CLEANLY and the checker still catches it",
    ok: mergesCleanly && r.code === 1 && /but the merged tree owns/.test(r.out),
    detail: `mergesCleanly=${mergesCleanly} exit=${r.code}`,
    out: r.out,
  });

  // ---- and the control: a branch that IS fresh must pass -----------------
  const fresh = run(BASE, a.sha);
  cases.push({
    name: "FRESH    a branch frozen against the current base passes",
    ok: fresh.code === 0 && /PASS/.test(fresh.out),
    detail: `exit=${fresh.code}`,
    out: fresh.out,
  });

  /*
   * ---- THE CLEANUP RUNS, ON EVERY PATH (#763) ---------------------------
   *
   * assert-census-fresh.mjs creates a worktree at :215 and removes it in a
   * `finally`. Every one of its thirteen deliberate endings is a `process.exit`
   * INSIDE the try, and process.exit terminates synchronously without running a
   * pending finally — measured, not recalled:
   *
   *     process.exit path   finally ran: false
   *     throw path          finally ran: true
   *
   * So the cleanup is CORRECT CODE reachable only from an uncaught throw. It is
   * not dead code; it is unreachable from every path anyone designed for, which
   * is a different defect with a much smaller repair.
   *
   * The five exits after :215 leak the directory AND git's admin entry, which is
   * why `git worktree prune` reports 0 prunable while `git worktree list` still
   * carries the leftovers — the directories exist, so there is nothing to prune.
   *
   * THREE ARMS, AND THE ENUMERATION IS STATED RATHER THAN IMPLIED. Five endings
   * occur after the worktree is created — three refusals (code 2), one pass, one
   * fail. This drives the pass, the fail, and ONE of the three refusals: the
   * merged-tree-has-no-rungs.json one. The other two refusals — "declares no
   * ownedFileCount" and "the probe tree did not walk" — are NOT driven, because
   * constructing a merged tree that walks to zero rungs costs more than it buys
   * today.
   *
   * That gap is named because of where the next ending will arrive. A new ending
   * is most likely a new precondition check, which is a code-2 refusal, which is
   * the class two of whose three members this case cannot see. A regression there
   * passes. If you add a refusal after the worktree is created, add an arm.
   *
   * A test exercising only the failing path would pass a repair that fixed exit 1
   * and left exit 0 — and exit 0 runs on every green branch, so it is the largest
   * half of the leak by volume.
   *
   * COUNTS EVERY census-fresh- WORKTREE IN THE REPO, not only this run's. Before
   * versus after makes that immune to the ones already present. It is NOT immune
   * to a concurrent run of this checker in another session, which this team does
   * have — that shows as a spurious RED, never a false green, so it is a flake
   * source rather than a correctness problem. If this case fails and the numbers
   * look like someone else's worktree appeared mid-run, that is what happened.
   */
  /*
   * BY PATH, NOT BY GREPPING THE LISTING (#815). This read `git worktree list` and
   * filtered whole LINES for "census-fresh-" — and that listing prints the BRANCH in
   * brackets beside the path, so `wt-763 [fix/763-census-fresh-cleanup]` was counted as
   * a probe. Measured: 9 by the old method, 8 by the path column. Latent rather than
   * live, because a constant offset cancels in the before/after delta below — and live
   * the moment anyone creates or deletes such a branch mid-run.
   */
  const censusFreshWorktrees = () =>
    probeWorktrees(git(["worktree", "list", "--porcelain"]), "census-fresh-")
      .length;

  // A branch whose merged tree has NO rungs.json, which is the refusal at the
  // first code-2 ending after the worktree is created.
  const noManifest = (() => {
    const wt = mkdtempSync(join(tmpdir(), "cfst-nomanifest-"));
    git(["worktree", "add", "-q", "--detach", wt, BASE]);
    git(["rm", "-q", "rungs.json"], wt);
    git(
      [
        "-c",
        "user.email=selftest@local",
        "-c",
        "user.name=selftest",
        "commit",
        "-q",
        "-m",
        "probe-nomanifest",
      ],
      wt
    );
    return { wt, sha: git(["rev-parse", "HEAD"], wt) };
  })();
  cleanup.push(noManifest.wt);

  const wtBefore = censusFreshWorktrees();
  run(a.sha, b.sha); // the failing path — exit 1, reached after the worktree exists
  const wtAfterFailing = censusFreshWorktrees();
  run(BASE, a.sha); // the passing path — exit 0, likewise
  const wtAfterPassing = censusFreshWorktrees();
  const refusal = run(BASE, noManifest.sha); // a code-2 refusal, likewise
  const wtAfterRefusal = censusFreshWorktrees();

  cases.push({
    name: "CLEANUP  no worktree left behind: failing path, passing path, OR a refusal",
    ok:
      wtAfterFailing === wtBefore &&
      wtAfterPassing === wtBefore &&
      wtAfterRefusal === wtBefore &&
      refusal.code === 2 &&
      // THE CLASS IS NOT THE ENDING. Three code-2 endings sit after the worktree
      // is created; `code === 2` answers "did it refuse" and cannot tell which
      // one refused. If the precondition order changes, or removing rungs.json
      // later trips the ownedFileCount check first, this arm would silently move
      // subject and still pass — the failure it exists to prevent, one level
      // finer. Anchored on the FRAGMENT rather than the sentence, so rewording
      // the message around it does not break the test.
      /has no rungs\.json/.test(refusal.out),
    detail: `before=${wtBefore} fail=${wtAfterFailing} pass=${wtAfterPassing} refuse=${wtAfterRefusal} (refusal exit=${refusal.code}, must be 2 or it drove a different ending)`,
    out:
      // Widened from `refusal.code === 2 ? "" : ...`, which discarded the output
      // exactly when the message anchor above failed — the evidence thrown away
      // at the moment it is the thing you need.
      wtAfterFailing === wtBefore &&
      wtAfterPassing === wtBefore &&
      wtAfterRefusal === wtBefore &&
      refusal.code === 2 &&
      /has no rungs\.json/.test(refusal.out)
        ? ""
        : refusal.out,
  });
}

// ---- the case that was MISSING, and that false-positived in the wild -----
{
  /*
   * A BRANCH THAT NEVER TOUCHES rungs.json MUST READ AS FRESH.
   *
   * This is the ordinary PR — most changes do not add a rung-owned file — and
   * it is the case the first version of this checker got WRONG. It read the
   * declared count from the BRANCH, so a branch carrying its base's older copy
   * was compared against a stale declaration of its own and reported stale.
   * It false-positived on the first real PR it was pointed at.
   *
   * Both other cases here change rungs.json, so neither could see it. The fix
   * was to read the declaration from the MERGED TREE — which is the file that
   * actually lands — and this case is what holds that fix in place.
   */
  const wt = mkdtempSync(join(tmpdir(), "cfst-untouched-"));
  cleanup.push(wt);
  git(["worktree", "add", "-q", "--detach", wt, BASE]);
  // A file no rung owns and the shared census does not count: changes nothing.
  writeFileSync(join(wt, "README-selftest-probe.md"), "probe\n");
  git(["add", "-A"], wt);
  git(
    [
      "-c",
      "user.email=selftest@local",
      "-c",
      "user.name=selftest",
      "commit",
      "-q",
      "-m",
      "untouched-census",
    ],
    wt
  );
  const sha = git(["rev-parse", "HEAD"], wt);

  // Now advance the base so the branch's own rungs.json copy is genuinely
  // older than main's — the exact shape that produced the false positive.
  const mover = branchAddingOneFile(BASE, "mover");
  cleanup.push(mover.wt);

  const r = run(mover.sha, sha);
  cases.push({
    name: "UNTOUCHED a branch that never edits rungs.json is FRESH against a moved base",
    ok: r.code === 0 && /PASS/.test(r.out),
    detail: `exit=${r.code}`,
    out: r.out,
  });
}

// ---- a conflicting merge is NOT this check's business --------------------
{
  const c = run("HEAD", "HEAD");
  cases.push({
    name: "IDENTITY self-merge REFUSES (exit 2) — a pass about nothing is not a pass",
    ok:
      c.code === 2 &&
      /REFUSING TO REPORT/.test(c.out) &&
      /head .* -> /.test(c.out),
    detail: `exit=${c.code}`,
    out: c.out,
  });
}

/** A throwaway branch off `base` writing `body` to ONE shared path, so two of
 *  them conflict on the same line. */
function branchTouchingSharedFile(base, tag, body) {
  const wt = mkdtempSync(join(tmpdir(), `cfst-${tag}-`));
  git(["worktree", "add", "-q", "--detach", wt, base]);
  writeFileSync(
    join(wt, "apps", "open-swe", "lib", "zz-conflict-probe.ts"),
    body
  );
  git(["add", "-A"], wt);
  git(
    [
      "-c",
      "user.email=selftest@local",
      "-c",
      "user.name=selftest",
      "commit",
      "-q",
      "-m",
      `conflict-${tag}`,
    ],
    wt
  );
  return { wt, sha: git(["rev-parse", "HEAD"], wt) };
}

// ---- a merge that CANNOT be computed is not a pass ------------------------
// This path used to exit 0 with "git already blocks this". True, and beside the
// point: `conflicts` and `verified fresh` are the two states this gate exists
// to distinguish, so returning the same exit code for both is a green over no
// verification. Found by ARCHITECT on a real conflicting branch.
{
  const x = branchTouchingSharedFile(BASE, "x", "export const v = 1;\n");
  const y = branchTouchingSharedFile(BASE, "y", "export const v = 2;\n");
  cleanup.push(x.wt, y.wt);

  const mt = (() => {
    try {
      return execFileSync("git", ["merge-tree", "--write-tree", x.sha, y.sha], {
        cwd: ROOT,
        encoding: "utf8",
      });
    } catch (e) {
      return (e.stdout ?? "") + (e.stderr ?? "");
    }
  })();
  const reallyConflicts = /CONFLICT/i.test(mt);

  const r = run(x.sha, y.sha);
  cases.push({
    // Both halves are load-bearing: without `reallyConflicts` this case would
    // pass on any refusal at all, including one caused by a broken fixture.
    name: "CONFLICT a merge that cannot be built REFUSES (exit 2), not passes",
    ok: reallyConflicts && r.code === 2 && /REFUSING TO REPORT/.test(r.out),
    detail: `reallyConflicts=${reallyConflicts} exit=${r.code}`,
    out: r.out,
  });
}

// ---- vacuity ------------------------------------------------------------
{
  const r = run("HEAD", "refs/nonexistent-selftest");
  cases.push({
    name: "VACUOUS  an unresolvable head REFUSES rather than reporting fresh",
    ok: r.code === 2,
    detail: `exit=${r.code}`,
    out: r.out,
  });
}

for (const c of cases) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}   [${c.detail}]`);
  if (!c.ok)
    console.log("        " + c.out.trim().split("\n").join("\n        "));
  if (c.ok) pass++;
}

for (const w of cleanup) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", w], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    rmSync(w, { recursive: true, force: true });
  }
}
try {
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
} catch {}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${
    cases.length
  }. The checker was watched\n` +
    `      catching a collision that git merges WITHOUT CONFLICT — which is the only\n` +
    `      case it exists for — and watched passing a branch that is genuinely fresh.`
);
process.exit(pass === cases.length ? 0 : 1);
