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
import { probeWorktrees } from "./lib/probe-worktrees.mjs";

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

/*
 * THE PROBE THIS SELFTEST'S SUBJECT LEAVES BEHIND (#815).
 *
 * assert-census-fresh-on-merge.mjs delegates to assert-census-fresh.mjs (:88), which
 * materialises a `census-fresh-` probe worktree and removes it in a `finally`. This file
 * drives that checker several times, so it is the heaviest producer of those probes in the
 * tree — and until now NOTHING asserted they were cleaned up. Tonight eight leftovers were
 * found whose HEAD commits are THIS FILE'S fixtures.
 *
 * The property is scoped to endings the process REACHES. A `finally` does not run when a
 * process is signal-killed, so "no probe outlives its run" is a promise the runtime cannot
 * keep; those eight came from runs that ended abnormally. Asserting the unachievable version
 * would make the first person to SIGKILL a run file a bug against this check rather than
 * against the leak.
 */
const probesBefore = probeWorktrees(
  git(["worktree", "list", "--porcelain"]),
  "census-fresh-"
).length;

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
/*
 * THIS EXECUTES THE CHECKER AS COMMITTED AT `sha`; a working-tree edit is invisible here, so a
 * mutation must be COMMITTED before it can be tested. That is by construction — the path is
 * `join(wt, CHECKER)` inside a worktree checked out at `sha`, and there is no branch that reads
 * the source tree. Stated because the design being right is exactly what makes it expensive to
 * discover: mutating the working copy and re-running produces a green that reads as "the arm
 * does not bite", which cost a cycle while building #815.
 */
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

    /*
     * ---- THE CORRECTED MERGE (#644) ------------------------------------------------------
     *
     * The case where today's answer is WRONG rather than absent, which is why it goes first.
     *
     * Two branches merge CLEANLY, so there is no conflict anywhere. The assembler then does
     * exactly what this checker's own failure message tells them to do — re-freeze on the
     * union — and amends the merge. HEAD now declares what HEAD owns: correct, and the state
     * every batch is supposed to reach.
     *
     * Re-merging the parents discards that correction and judges the UNCORRECTED tree, so the
     * checker reports a divergence that no longer exists and names the remedy that was already
     * applied. A gate that fails you for following its own advice is worse than one that
     * declines to answer.
     */
    const corrected = (() => {
      const wt = worktree(a.sha, "corrected");
      git(["merge", "--no-ff", "--no-edit", b.sha], wt);
      // the fix the assembler applies by hand
      execFileSync("node", [join(wt, "scripts", "freeze-all.mjs")], {
        cwd: wt,
        stdio: "ignore",
      });
      git(["add", "-A"], wt);
      git(["commit", "-q", "--amend", "--no-edit"], wt);
      return git(["rev-parse", "HEAD"], wt);
    })();
    // PRECONDITION: the correction must actually have changed the tree, or this case is a
    // second copy of CONTROL rather than the case it claims to be.
    if (
      git(["rev-parse", `${corrected}^{tree}`]) ===
      git(["merge-tree", "--write-tree", a.sha, b.sha]).split("\n")[0].trim()
    )
      bad(
        "CORRECTED the re-freeze changed the merged tree",
        "amending changed nothing — the fixture is not exercising a correction"
      );
    else ok("CORRECTED the re-freeze changed the merged tree");

    const fixed = runAt(corrected, "corrected");
    if (fixed.code === 0)
      ok(
        "CORRECTED a merge whose census was re-frozen on the union PASSES",
        "exit=0"
      );
    else
      bad(
        "CORRECTED a merge whose census was re-frozen on the union PASSES",
        `exit=${fixed.code} — judged the RE-MERGE, not the tree that landed: ` +
          ((fixed.out.match(/declares \d+, but the merged tree owns \d+/) ?? [
            "",
          ])[0] || fixed.out.split("\n")[0].slice(0, 60))
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
   * ---- THE HAND-RESOLVED CONFLICT (#644) --------------------------------------------------
   *
   * The reported case. Two branches each register a checker in scripts/checks.json at the same
   * anchor, which conflicts textually — the normal shape when two PRs both add a gate. The
   * assembler union-resolves it by hand into a valid file holding both entries, and no rung
   * file is added, so the census legitimately holds.
   *
   * Re-merging refused this with exit 2, "the merged tree cannot be built", over a tree that
   * exists and is correct. The refusal was honest and the exit code right for the question it
   * asked; the question was the wrong one.
   */
  {
    const entry = (t) =>
      `    {\n      "name": "zz-${t}",\n      "proof": "scripts/classify.selftest.mjs",\n` +
      `      "checker": "scripts/classify.mjs",\n      "why": "probe ${t}"\n    },\n`;
    const withEntry = (base, tag) => {
      const wt = worktree(base, `cj-${tag}`);
      const f = join(wt, "scripts", "checks.json");
      writeFileSync(
        f,
        readFileSync(f, "utf8").replace(
          '  "checks": [\n',
          '  "checks": [\n' + entry(tag)
        )
      );
      git(["add", "-A"], wt);
      git(["commit", "-q", "-m", `register zz-${tag}`], wt);
      return git(["rev-parse", "HEAD"], wt);
    };
    const ca = withEntry(BASE, "a");
    const cb = withEntry(BASE, "b");

    // PRECONDITION: these must genuinely conflict, or this is the CONTROL case again.
    let conflicts = false;
    try {
      git(["merge-tree", "--write-tree", ca, cb]);
    } catch {
      conflicts = true;
    }
    if (!conflicts)
      bad(
        "RESOLVED the two registrations conflict textually",
        "they merged cleanly"
      );
    else ok("RESOLVED the two registrations conflict textually");

    const rw = worktree(ca, "resolve");
    try {
      git(["merge", "--no-commit", "--no-ff", cb], rw);
    } catch {
      /* the conflict is the point */
    }
    // The union a human writes: start from one side's committed file and add the other's
    // entry. Stripping markers naively yields invalid JSON — the entries need a separator —
    // which is why this is hand-resolved rather than scripted.
    writeFileSync(
      join(rw, "scripts", "checks.json"),
      git(["show", `${ca}:scripts/checks.json`]).replace(
        '  "checks": [\n',
        '  "checks": [\n' + entry("b")
      )
    );
    const union = JSON.parse(
      readFileSync(join(rw, "scripts", "checks.json"), "utf8")
    );
    if (union.checks.filter((c) => c.name.startsWith("zz-")).length !== 2)
      bad(
        "RESOLVED the union holds both registrations",
        "the resolution lost one"
      );
    else ok("RESOLVED the union holds both registrations");
    git(["add", "-A"], rw);
    git(["commit", "-q", "-m", "batch: union-resolved checks.json"], rw);

    const resolved = runAt(git(["rev-parse", "HEAD"], rw), "resolved");
    if (resolved.code === 0)
      ok(
        "RESOLVED a hand-resolved conflicting merge is JUDGED, not refused",
        "exit=0"
      );
    else
      bad(
        "RESOLVED a hand-resolved conflicting merge is JUDGED, not refused",
        `exit=${resolved.code} — ` +
          (
            resolved.out.split("\n").find((l) => /REFUSING|declares/.test(l)) ??
            ""
          ).slice(0, 70)
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

const probesAfter = probeWorktrees(
  git(["worktree", "list", "--porcelain"]),
  "census-fresh-"
).length;
if (probesAfter === probesBefore)
  ok(
    "every checker run this file drove removed its probe worktree",
    `census-fresh-* ${probesBefore} -> ${probesAfter}`
  );
else
  bad(
    "a probe worktree OUTLIVED the run that created it",
    `census-fresh-* ${probesBefore} -> ${probesAfter}. Counted by PATH via --porcelain, ` +
      `so a branch named after this issue is not what moved the number.`
  );

const total = pass + fail;
const EXPECTED = 10; // PRECONDITION/SILENT/CONTROL/NON-MERGE — the probe's own precondition only speaks up when it is violated
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
