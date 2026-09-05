#!/usr/bin/env node
/**
 * Will this branch's census still be true AFTER it merges? (#145)
 *
 * `ownedFileCount` describes the tree the branch BECOMES, not the branch — so a
 * number that is correct on the branch can be wrong the moment something else
 * lands. That is #145's merge-order form, and it hit three PRs in one evening.
 *
 * GIT CATCHES HALF OF IT AND SILENTLY MERGES THE OTHER HALF. Two PRs that write
 * DIFFERENT values conflict on the same line, and GitHub reports CONFLICTING —
 * that half needs no help. Two PRs that write the SAME value do not:
 *
 *     base 128   ours 129   theirs 129   ->  identical change, clean merge
 *
 * and the merged file says 129 over a tree of 130. That is exactly #145's
 * original arithmetic (#132 froze 129, #144 moved main to 129), and it is what
 * two PRs each adding ONE file always produce. Tonight #326 wrote 199 and #329
 * wrote 199; only a rebase kept main green.
 *
 * So the case worth a check is precisely the one that merges cleanly, and it
 * cannot be found by reading either branch — both are internally correct.
 *
 * HOW IT ANSWERS WITHOUT PREDICTING. `git merge-tree --write-tree` produces the
 * ACTUAL merged tree; this materialises it as a detached worktree and runs the
 * REAL census over it. No reimplemented glob matcher, no arithmetic, no
 * "expected" number — the same code that freezes, run against the tree the
 * merge would produce. Predicting the number is how the defect reproduces in
 * the guidance, which I did to a teammate tonight and had to retract.
 *
 * Usage:  node scripts/assert-census-fresh.mjs [--base origin/main] [--head HEAD]
 */

import { execFileSync } from "node:child_process";
import { classify } from "./classify.mjs";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const BASE = arg("base", "origin/main");
const HEAD = arg("head", "HEAD");
/*
 * `--at <commit>`: JUDGE THE TREE THAT LANDED, NOT A RE-DERIVATION OF IT (#644).
 *
 * The default mode asks a PRE-FLIGHT question — will this branch's census still hold once it
 * merges — and the only way to see that tree is to build it, because it does not exist yet.
 *
 * On a commit that has ALREADY merged, the tree exists and is HEAD. Re-merging its parents
 * asks a question the commit has answered, and DISCARDS EVERY RESOLUTION THE COMMIT CARRIES —
 * including the census correction this gate exists to verify. Measured both ways: a
 * union-resolved merge refuses with exit 2 ("the merged tree cannot be built") over a tree
 * that is right there; and a cleanly-merged commit whose census was then re-frozen on the
 * union — the fix this checker's own failure message asks for — is reported STALE at exit 1,
 * naming a divergence that no longer exists. The second is the worse one: a wrong verdict
 * about a correct tree, telling you to apply the remedy you already applied.
 *
 * So `--at` skips the merge entirely. The parents are not needed for the ANSWER: the commit's
 * own rungs.json is the declaration that landed, and its own tree is what it owns. A caller
 * that wants to say what the base declared can print it; it must not compute with it.
 */
const AT = arg("at", null);

const git = (a, opts = {}) =>
  execFileSync("git", a, {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    ...opts,
  }).trim();

let tmp = null;
/*
 * THE EXIT CODE IS RECORDED, NOT TAKEN (#763).
 *
 * Every ending below used to be a `process.exit` INSIDE the try. process.exit
 * terminates synchronously and does NOT run a pending `finally`, so the cleanup
 * at the bottom — which removes this run's worktree and prunes git's admin entry
 * — was reachable only from an uncaught throw. Measured:
 *
 *     process.exit path   finally ran: false
 *     throw path          finally ran: true
 *
 * Not dead code: correct code, unreachable from every path anyone designed for.
 * The five endings after `tmp` is assigned each leaked a directory AND git's
 * admin entry, which is why `git worktree prune` reported 0 prunable while
 * `git worktree list` carried the leftovers — the directories still existed.
 *
 * RECORD AND BREAK, rather than classifying which endings leak. A per-site fix
 * would need someone to decide, for each new exit added later, whether it sits
 * after line ~215 — and that classification is exactly the step a future author
 * skips. One label makes the question not arise.
 */
let code = 0;
census: try {
  // Resolve BOTH ends and SAY WHAT THEY RESOLVED TO. An unresolvable ref refuses
  // here rather than producing a confusing merge-tree error later.
  let atSha = null;
  if (AT) {
    try {
      atSha = git(["rev-parse", "--verify", `${AT}^{commit}`]);
    } catch {
      console.error(`REFUSING TO REPORT: cannot resolve ${AT}.`);
      code = 2;
      break census;
    }
    console.log(
      `census: judging ${atSha.slice(0, 12)}'s OWN tree (no re-merge).`
    );
  }
  let baseSha, headSha;
  try {
    baseSha = AT ? atSha : git(["rev-parse", "--verify", `${BASE}^{commit}`]);
  } catch {
    console.error(`REFUSING TO REPORT: cannot resolve ${BASE}.`);
    code = 2;
    break census;
  }
  try {
    headSha = AT ? atSha : git(["rev-parse", "--verify", `${HEAD}^{commit}`]);
  } catch {
    console.error(`REFUSING TO REPORT: cannot resolve ${HEAD}.`);
    code = 2;
    break census;
  }

  /*
   * SAY WHICH TWO COMMITS THIS IS ABOUT, ALWAYS.
   *
   * I merged a PR on the strength of a green from this tool that was comparing
   * main WITH ITSELF. `git fetch origin main other-branch` leaves FETCH_HEAD
   * holding BOTH, and `rev-parse FETCH_HEAD` takes the FIRST — so
   * `--head FETCH_HEAD` silently meant `main`. The check was correct; the
   * invocation asked a different question, and the answer to that question is
   * trivially PASS.
   *
   * A tool whose green cannot be traced to a subject is one you can be fooled
   * by exactly once per operator. Printing the resolved pair costs one line and
   * makes the substitution visible in the log.
   */
  if (!AT) {
    console.log(`  base ${BASE} -> ${baseSha.slice(0, 12)}`);
    console.log(`  head ${HEAD} -> ${headSha.slice(0, 12)}`);
  }
  // The identity refusal is about a MERGE of a commit with itself. In --at mode there is no
  // merge and both shas are deliberately the same commit, so the guard would refuse the very
  // question it was asked. It stays exactly as it is for the mode it belongs to.
  if (!AT && baseSha === headSha) {
    console.error(
      "\nREFUSING TO REPORT: head and base are the SAME COMMIT, so there is no\n" +
        "merge to reason about. THIS IS NOT A PASS — it is the absence of a\n" +
        "question. Exiting 2.\n\n" +
        "This is the exact shape that once let a red PR onto main: `--head\n" +
        "FETCH_HEAD` after a multi-ref `git fetch` resolves to the FIRST ref,\n" +
        "so the gate compared main with itself and reported success. Announcing\n" +
        "the identity case while still exiting 0 left that hole open — a caller\n" +
        "reads the exit code, not the prose."
    );
    code = 2;
    break census;
  }

  // The merged tree. A conflict here is NOT this check's business — GitHub
  // already reports it, loudly, and the merge cannot proceed. Say so and stop.
  let merged = null;
  try {
    // In --at mode nothing is merged: the tree under test already exists.
    merged = AT
      ? null
      : git(["merge-tree", "--write-tree", BASE, HEAD]).split("\n")[0].trim();
  } catch (e) {
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    if (/CONFLICT/i.test(out)) {
      console.error(
        `REFUSING TO REPORT: merge of ${HEAD} into ${BASE} CONFLICTS, so the\n` +
          "merged tree cannot be built and freshness CANNOT BE COMPUTED.\n" +
          "Rebase, then re-run. Exiting 2.\n\n" +
          "git blocks the merge independently, so nothing can land stale by this\n" +
          "path — but `conflicts` and `verified fresh` are the two states this\n" +
          "gate exists to distinguish, and reporting them with the same exit\n" +
          "code is a green over no verification."
      );
      code = 2;
      break census;
    }
    if (/unrelated histories/i.test(out)) {
      // A shallow clone, not a broken repo. Saying which one saves the next
      // person from looking for a merge conflict that does not exist.
      console.error(
        "REFUSING TO REPORT: no common ancestor between base and head.\n" +
          "  This is almost always a SHALLOW CLONE — actions/checkout truncates\n" +
          "  history, and a merge-base question cannot be answered from two\n" +
          "  truncated sides. Deepen first:\n" +
          "    git fetch --no-tags --unshallow origin"
      );
      code = 2;
      break census;
    }
    console.error(
      `REFUSING TO REPORT: merge-tree failed: ${String(e).split("\n")[0]}`
    );
    code = 2;
    break census;
  }
  if (!AT && !/^[0-9a-f]{40}$/.test(merged)) {
    console.error(
      `REFUSING TO REPORT: merge-tree gave no tree oid (got "${merged.slice(
        0,
        40
      )}").`
    );
    code = 2;
    break census;
  }

  // Materialise it and run the REAL census there.
  /*
   * IDENTITY SUPPLIED EXPLICITLY. `commit-tree` needs an author, and a CI runner
   * has no `user.name` / `user.email` configured — so this worked locally only
   * because my own global git config happened to supply one, and failed on the
   * first runner that saw it. A tool that depends on ambient state passes
   * wherever that state exists and nowhere else, which is the least useful place
   * for a gate to work.
   *
   * The probe commit is thrown away with the worktree, so the identity is
   * arbitrary; what matters is that it does not come from the environment.
   */
  // In --at mode the commit IS the probe: its tree is the subject, so nothing is built.
  const probe = AT
    ? atSha
    : git([
        "-c",
        "user.name=census-freshness",
        "-c",
        "user.email=census-freshness@local",
        "commit-tree",
        merged,
        "-p",
        BASE,
        "-m",
        "census-freshness-probe",
      ]);
  tmp = mkdtempSync(join(tmpdir(), "census-fresh-"));
  git(["worktree", "add", "-q", "--detach", tmp, probe]);

  // THE REAL MATCHER, NOT A SECOND ONE. classify.mjs exposes its per-rung
  // counts precisely so other gates need not reimplement the globs — its own
  // comment says "a second implementation is a second answer, and the two drift
  // silently". This calls it with the PROBE as cwd and the PROBE's manifest, so
  // both the file list and the globs come from the merged tree.
  const probeManifestPath = join(tmp, "rungs.json");
  if (!existsSync(probeManifestPath)) {
    console.error("REFUSING TO REPORT: the merged tree has no rungs.json.");
    code = 2;
    break census;
  }
  const probeManifest = JSON.parse(readFileSync(probeManifestPath, "utf8"));
  const result = classify(tmp, probeManifest);
  const actual = result.stats.byRung;

  /*
   * DECLARED COMES FROM THE MERGED TREE, NOT FROM THE BRANCH.
   *
   * This read `${HEAD}:rungs.json` at first, and false-positived on the first
   * real PR it saw: a branch that never touched rungs.json carries whatever
   * copy its base had, so it was compared against a stale declaration of its
   * own rather than against the one that will exist after the merge. Both
   * selftest cases changed rungs.json, so neither could see it — the case they
   * were missing was the ordinary one, a PR that does not touch the census.
   *
   * The merged tree's rungs.json IS the declaration that lands on the base
   * branch, so it is the only correct subject. When the branch did not change
   * it, git keeps the base's — which is exactly right and now reads as fresh.
   */
  const declared = new Map(
    (probeManifest.rungs ?? [])
      .filter((r) => typeof r.ownedFileCount === "number")
      .map((r) => [r.id, r.ownedFileCount])
  );
  if (declared.size === 0) {
    console.error(
      "REFUSING TO REPORT: the merged tree declares no ownedFileCount."
    );
    console.error("A freshness check over zero subjects is vacuous.");
    code = 2;
    break census;
  }

  // A walk that found nothing would make every comparison below vacuously
  // equal. classify already refuses that (C1); surface it rather than reporting
  // freshness computed over an empty tree.
  if (!result.ok && result.errors.some((e) => e.startsWith("C1 walk"))) {
    console.error("REFUSING TO REPORT: the probe tree did not walk.");
    for (const e of result.errors) console.error("  " + e);
    code = 2;
    break census;
  }

  const stale = [];
  for (const [id, want] of declared) {
    const got = actual[id];
    if (typeof got !== "number") continue;
    if (got !== want) stale.push({ id, declared: want, afterMerge: got });
  }

  if (stale.length === 0) {
    console.log(
      AT
        ? `PASS: every ownedFileCount holds in ${AT}'s OWN tree ` +
            `(${declared.size} rungs recounted against the tree that landed).`
        : `PASS: every ownedFileCount still holds after merging ${HEAD} into ${BASE} ` +
            `(${declared.size} rungs checked against the real merged tree).`
    );
    code = 0;
    break census;
  }

  console.error(
    AT
      ? `STALE IN THE TREE THAT LANDED — ${AT} declares a census its own tree does not match:\n`
      : `STALE AFTER MERGE — this branch is internally correct and will still turn ${BASE} red:\n`
  );
  for (const s of stale) {
    console.error(
      `  rung "${s.id}": declares ${s.declared}, but the merged tree owns ${s.afterMerge}.`
    );
  }
  console.error(
    `\n  Nothing is wrong with this branch in isolation — that is why CI on it is\n` +
      `  green and why git merges it cleanly: another branch wrote the SAME value,\n` +
      `  so there is no conflict to see.\n\n` +
      `  Fix:  git fetch origin && git rebase ${BASE}\n` +
      `        git add -A && pnpm freeze:all      # READ the number; never predict it\n` +
      `        commit rungs.json and scripts/shared-census.json together`
  );
  code = 1;
  break census;
} finally {
  // CLEAN UP BOTH HALVES. `rmSync` alone deletes the directory and leaves git's
  // admin entry behind, so the next `git worktree list` shows a phantom — and a
  // tool that litters the repo it checks gets switched off. Remove, then prune
  // unconditionally, and swallow nothing silently that matters.
  if (tmp) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", tmp], {
        stdio: "ignore",
      });
    } catch {
      rmSync(tmp, { recursive: true, force: true });
    }
    try {
      execFileSync("git", ["worktree", "prune"], { stdio: "ignore" });
    } catch {
      /* prune is best-effort; the remove above is the load-bearing half */
    }
  }
}
process.exit(code);
