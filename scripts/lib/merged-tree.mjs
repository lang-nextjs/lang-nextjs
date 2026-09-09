/**
 * merged-tree.mjs — materialise the tree a merge WOULD produce, and answer there (#922).
 *
 * A review states a property of the tree AFTER a pull request lands, and derives it from the
 * pull request's diff against its own merge-base. On this board that base goes stale within the
 * hour, and a measurement against a stale base is INTERNALLY CONSISTENT -- it is plausible,
 * self-consistent, and wrong in whichever direction the missing commits point. #804 asserted a
 * pull request CREATED a dual dependency version when main already had one and the pull request
 * CLOSED it. Nothing in the review process finds that.
 *
 * A WRITTEN RULE DOES NOT FIX IT, WHICH IS WHY THIS IS A LIBRARY AND NOT A GUIDELINE. The rule
 * "re-read origin/main at the moment of writing" was recorded on #804 and is correct. The
 * reviewer who missed it had caught the identical thing an hour earlier on #911. Nobody forgot;
 * they were attending to something else. A rule standing in for an instrument is the shape #922
 * exists to retire.
 *
 * WHAT IS EXTRACTED HERE AND WHY IT IS NOT REWRITTEN PER CALLER. `assert-census-fresh.mjs`
 * already did all of this for ONE property, and the parts that are easy to get wrong are the
 * parts that are not about the property at all:
 *
 *   - `commit-tree` needs an author, and a CI runner has no `user.name` configured. Supplying it
 *     from the environment makes a tool that passes wherever that state exists and nowhere else.
 *     The identity is therefore passed with `-c` on every call.
 *   - `rmSync` alone deletes the directory and leaves git's ADMIN ENTRY behind, so the next
 *     `git worktree list` shows a phantom that `git worktree prune` will not reclaim while the
 *     directory exists. Both halves have to go, in order. (That residue is also what a
 *     worktree-counting checker sees, which is #1166.)
 *   - a CONFLICT and a SHALLOW CLONE both surface as a merge-tree failure and want opposite
 *     responses from the reader, so they are told apart here rather than at each call site.
 *
 * IT SHORTENS THE WINDOW, IT DOES NOT CLOSE IT. The answer describes the merge of these two
 * shas. If another pull request lands between measuring and merging, it expires again --
 * `describe()` says so in the text it returns, so a pasted result carries its own scope.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Why a merge could not be materialised. Each is a REFUSAL (exit 2), never a finding. */
export const REFUSAL = {
  CONFLICT: "CONFLICT",
  UNRELATED: "UNRELATED_HISTORIES",
  MERGE_FAILED: "MERGE_TREE_FAILED",
  BAD_OID: "MERGE_TREE_GAVE_NO_OID",
  UNRESOLVABLE: "REF_DOES_NOT_RESOLVE",
};

const run = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * Resolve a ref to a commit sha, or return null. Callers must treat null as a REFUSAL rather
 * than as a default: an unresolvable ref and a ref pointing at nothing are different questions,
 * and only one of them is the caller's fault.
 */
export function resolve(ref, cwd) {
  try {
    /*
     * `stderr: "pipe"` so a ref that does not resolve does not PRINT `fatal: Needed a single
     * revision` on the way to a handled null. An expected refusal that writes a fatal to the
     * terminal reads, to anyone scrolling, exactly like a proof that is failing.
     */
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the merged tree of `head` into `base` and check it out detached.
 *
 * Returns either
 *   { ok: true,  dir, probe, baseSha, headSha, cleanup }
 *   { ok: false, refusal, message, baseSha, headSha }
 *
 * NEVER throws for an ordinary failure: a conflicted merge is a state this is expected to meet,
 * and turning it into an exception invites a caller to catch it beside a programming error.
 */
export function materialiseMerge({ base, head, prefix = "merged-tree-", cwd }) {
  const baseSha = resolve(base, cwd);
  const headSha = resolve(head, cwd);
  if (!baseSha || !headSha)
    return {
      ok: false,
      refusal: REFUSAL.UNRESOLVABLE,
      baseSha,
      headSha,
      message:
        `cannot resolve ${
          !baseSha ? `base \`${base}\`` : `head \`${head}\``
        }. ` +
        "Fetch it first; a ref that does not exist locally is not a ref that does not exist.",
    };

  let tree;
  try {
    tree = run(["merge-tree", "--write-tree", baseSha, headSha], cwd)
      .split("\n")[0]
      .trim();
  } catch (e) {
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    if (/CONFLICT/i.test(out))
      return {
        ok: false,
        refusal: REFUSAL.CONFLICT,
        baseSha,
        headSha,
        message:
          `the merge of ${headSha.slice(0, 12)} into ${baseSha.slice(
            0,
            12
          )} CONFLICTS, so ` +
          "there is no merged tree to measure. This is a REFUSAL, not a finding: " +
          '"could not ask" and "the property is false" are the two states this exists to ' +
          "keep apart, and git blocks the merge on its own anyway.",
      };
    if (/unrelated histories/i.test(out))
      return {
        ok: false,
        refusal: REFUSAL.UNRELATED,
        baseSha,
        headSha,
        message:
          "no common ancestor between base and head. This is almost always a SHALLOW CLONE -- " +
          "`actions/checkout` truncates history and a merge-base cannot be computed from two " +
          "truncated sides. Deepen first: git fetch --no-tags --unshallow origin",
      };
    return {
      ok: false,
      refusal: REFUSAL.MERGE_FAILED,
      baseSha,
      headSha,
      message: `merge-tree failed: ${String(e).split("\n")[0]}`,
    };
  }
  if (!/^[0-9a-f]{40}$/.test(tree))
    return {
      ok: false,
      refusal: REFUSAL.BAD_OID,
      baseSha,
      headSha,
      message: `merge-tree produced no tree oid (got ${JSON.stringify(
        tree.slice(0, 60)
      )}).`,
    };

  /*
   * IDENTITY SUPPLIED EXPLICITLY, NEVER FROM THE ENVIRONMENT. `commit-tree` needs an author and
   * a CI runner has none configured, so reading it from ambient git config produces a tool that
   * works on the author's machine and nowhere else. The probe commit dies with the worktree, so
   * the identity is arbitrary -- what matters is that it is ours.
   */
  const probe = run(
    [
      "-c",
      "user.name=merged-tree-probe",
      "-c",
      "user.email=merged-tree-probe@local",
      "commit-tree",
      tree,
      "-p",
      baseSha,
      "-m",
      "merged-tree-probe",
    ],
    cwd
  );
  const dir = mkdtempSync(join(tmpdir(), prefix));
  run(["worktree", "add", "-q", "--detach", dir, probe], cwd);

  return {
    ok: true,
    dir,
    probe,
    baseSha,
    headSha,
    cleanup: () => cleanup(dir, cwd),
  };
}

/**
 * Remove BOTH HALVES, in order. `rmSync` alone leaves git's admin entry, and `prune` will not
 * reclaim an entry whose directory still exists -- which is how a repository accumulates phantom
 * worktrees that a listing reports and a prune reports as 0 prunable.
 */
export function cleanup(dir, cwd) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    /* fall through to the manual pair; the worktree may never have been added */
  }
  rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "ignore" });
  } catch {
    /* prune is best-effort; a failure here leaves a phantom, not a wrong answer */
  }
}

/**
 * The sentence a result should carry when it is pasted into a review. It names BOTH parents,
 * because a merge result without its two inputs is unattributable and the whole point is that
 * one of them moves -- and it states its own expiry, because the honest scope of this
 * measurement is "these two shas", not "after this lands".
 */
export function describe({ baseSha, headSha }) {
  return (
    `measured on the merge of ${headSha.slice(0, 12)} into ${baseSha.slice(
      0,
      12
    )}. ` +
    "This answer describes THOSE TWO SHAS. If anything lands on the base before this merges, " +
    "it expires and must be re-taken -- the window is shortened, not closed."
  );
}
