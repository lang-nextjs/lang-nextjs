#!/usr/bin/env node
/**
 * Can assert-census-fresh-on-merge FAIL? Planted, not argued.
 *
 * The checker asks the freshness question at the merge, which is where #145's silent half
 * first exists. A proof of it therefore has to BUILD a merge: two branches off one base, each
 * adding one rung-owned file, each frozen, merged into a genuine two-parent commit. Nothing
 * smaller reproduces it — the whole point of the defect is that each branch is internally
 * correct and git sees no conflict, so any fixture that inspects one side sees nothing wrong.
 *
 * NO NUMBER IS WRITTEN HERE. The counts come from freeze-all on each branch and from the
 * checker's own recount. Asserting a number this file predicted would be the bug under test,
 * one level up.
 *
 * THE PRECONDITION IS THE LOAD-BEARING PART, and it is worth more than the rejection case.
 * The plant is only rung-owned because rung 4 claims `apps/open-swe/lib/sandbox/` as a
 * DIRECTORY glob. That has moved once already (#154 narrowed `apps/open-swe/**`, and the same
 * path silently became SHARED — the freeze changed no count, both branches froze identically,
 * there was no collision left to detect, and the case reported the checker passing on a
 * scenario it could no longer construct). So this REFUSES when the plant changes no count,
 * rather than reporting a green over a fixture that has quietly stopped being one.
 *
 * AND THE POSITIVE CONTROL IS NOT DECORATION. A suite of rejections is satisfied by a checker
 * that rejects every merge. So a merge where only ONE side adds a file must PASS.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = "scripts/assert-census-fresh-on-merge.mjs";
/*
 * IDENTITY SUPPLIED ON EVERY INVOCATION, NOT JUST THE COMMITS.
 *
 * `commit-tree` stamps an author AND a committer, and a CI runner has neither configured. This
 * passed locally only because my own global git config supplied one, and failed on the first
 * runner that saw it — reproduced here with
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true` and an empty
 * HOME, which makes git refuse to guess instead of inventing user@host.
 *
 * assert-census-fresh.mjs — the checker this proves — already carries the identical note at its
 * own commit-tree call, in almost these words. I reproduced the defect one layer out while
 * writing the proof for it, which is the argument for putting it on the HELPER rather than on
 * the call: the next git command added to this file inherits it instead of rediscovering it.
 *
 * The commits are thrown away with their worktrees, so the identity is arbitrary. What matters
 * is that it does not come from the environment.
 */
const IDENT = [
  "-c",
  "user.name=census-merge-selftest",
  "-c",
  "user.email=census-merge-selftest@local",
];
const git = (a, cwd = ROOT) =>
  execFileSync("git", [...IDENT, ...a], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }).trim();

let pass = 0;
let fail = 0;
const ok = (n, d = "") => {
  console.log(`  ok   ${n}${d ? `   ${d}` : ""}`);
  pass++;
};
const bad = (n, d = "") => {
  console.error(`  FAIL ${n}${d ? `   ${d}` : ""}`);
  fail++;
};

const made = [];
function worktree(at, tag) {
  const wt = mkdtempSync(join(tmpdir(), `cfm-${tag}-`));
  made.push(wt);
  git(["worktree", "add", "-q", "--detach", wt, at]);
  return wt;
}

/** A branch off `base` that adds ONE rung-owned file and freezes. Refuses if it is not owned. */
function branchAddingOneFile(base, tag) {
  const wt = worktree(base, tag);
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
  if (before === readFileSync(join(wt, "rungs.json"), "utf8"))
    return {
      refuse:
        `planting ${rel} changed no ownedFileCount, so it is not rung-owned in this tree. ` +
        `The collision cannot be constructed without it — move the plant to a path some rung ` +
        `owns by DIRECTORY glob.`,
    };
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", tag], wt);
  return { sha: git(["rev-parse", "HEAD"], wt) };
}

/** Run the checker AT a commit, from a worktree of that commit. */
function runAt(sha, tag) {
  const wt = worktree(sha, tag);
  try {
    const out = execFileSync(process.execPath, [join(wt, CHECKER)], {
      cwd: wt,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const BASE = git(["rev-parse", "HEAD"]);
const mergeOf = (p1, p2, msg) =>
  git([
    "commit-tree",
    git(["merge-tree", "--write-tree", p1, p2]).split("\n")[0].trim(),
    "-p",
    p1,
    "-p",
    p2,
    "-m",
    msg,
  ]);

try {
  const a = branchAddingOneFile(BASE, "a");
  const b = branchAddingOneFile(BASE, "b");
  if (a.refuse || b.refuse) {
    bad("PRECONDITION: the plant is rung-owned", a.refuse ?? b.refuse);
  } else {
    ok("PRECONDITION: planting one file moved a frozen count");

    // ---- the case the checker exists for ---------------------------------
    const silent = runAt(mergeOf(a.sha, b.sha, "batch: a + b"), "silent");
    if (silent.code === 0)
      bad(
        "SILENT two +1 branches merge cleanly and the checker catches it",
        "exited 0"
      );
    else if (!/declares \d+, but the merged tree owns \d+/.test(silent.out))
      bad(
        "SILENT the failure NAMES the divergence",
        "red, but not for this reason: " +
          silent.out.split("\n")[0].slice(0, 80)
      );
    else
      ok(
        "SILENT two +1 branches merge cleanly and the checker still catches it",
        (silent.out.match(
          /rung "[^"]+": declares \d+, but the merged tree owns \d+/
        ) ?? [""])[0]
      );

    // ---- the positive control --------------------------------------------
    const oneSided = runAt(
      mergeOf(BASE, a.sha, "merge: only a adds"),
      "onesided"
    );
    if (oneSided.code === 0)
      ok("CONTROL a merge where only ONE side adds a file PASSES", "exit=0");
    else
      bad(
        "CONTROL a merge where only ONE side adds a file PASSES",
        `exit=${oneSided.code} — a checker that rejects every merge would satisfy the case above`
      );
  }

  /*
   * ---- a non-merge commit is not a pass ---------------------------------------------------
   *
   * THE SUBJECT IS CONSTRUCTED, NOT INHERITED. This ran the checker at HEAD and asserted it
   * reported "needs merge-commit" — which held locally and FAILED IN CI, because on a
   * `pull_request` event the checkout IS the merge commit, `refs/pull/N/merge`, a synthetic
   * two-parent commit Actions builds for the run. HEAD is never single-parent there, so the
   * case could not see its own subject and failed honestly while the checker was correct.
   *
   * That is the nastiest of the three: the message reads as though the non-merge path is
   * broken, and someone debugging it would go looking at parent-counting logic that is right.
   *
   * The repo already knew this. run-checks.mjs:154, assert-merge-keeps-registrations.mjs:33
   * and assert-workflow-event-matrix.mjs:59 all record it — the second one relies on it, since
   * a PR's two parents are exactly the trees it wants to compare. I rediscovered it anyway,
   * one file over, for the second time in this fixture after the identity problem.
   *
   * So the commit is built here: BASE's own tree with BASE as its single parent. Same move as
   * the identity fix — construct the condition rather than inherit it — and it now exercises
   * both configurations whatever the runner hands us.
   */
  const singleParent = git([
    "commit-tree",
    git(["rev-parse", `${BASE}^{tree}`]),
    "-p",
    BASE,
    "-m",
    "single-parent probe",
  ]);
  if (
    git(["rev-list", "--parents", "-n", "1", singleParent]).split(/\s+/)
      .length -
      1 !==
    1
  )
    bad(
      "PRECONDITION: the probe commit has exactly one parent",
      "fixture is not what it says"
    );
  const plain = runAt(singleParent, "plain");
  if (plain.code === 0 && /needs merge-commit/.test(plain.out))
    ok("a NON-MERGE commit is announced as unmeasured, not summed as a pass");
  else
    bad(
      "a NON-MERGE commit is announced as unmeasured, not summed as a pass",
      `exit=${plain.code} out=${plain.out.split("\n")[0].slice(0, 70)}`
    );
} finally {
  for (const w of made) {
    try {
      execFileSync("git", [...IDENT, "worktree", "remove", "--force", w], {
        cwd: ROOT,
        stdio: "ignore",
      });
    } catch {
      rmSync(w, { recursive: true, force: true });
    }
  }
  try {
    execFileSync("git", [...IDENT, "worktree", "prune"], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    /* best effort */
  }
}

const total = pass + fail;
const EXPECTED = 4; // PRECONDITION/SILENT/CONTROL/NON-MERGE — the probe's own precondition only speaks up when it is violated
console.log();
if (total !== EXPECTED) {
  console.error(
    `FAIL: ran ${total} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(
    `FAIL: ${fail}/${total} wrong. The merge-time census gate is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The gate was watched catching two cleanly-merging +1 branches,\n` +
    `      watched PASSING a merge that adds nothing, and refuses if the plant stops being owned.`
);
