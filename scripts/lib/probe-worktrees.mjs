/**
 * PROBE WORKTREES, COUNTED BY PATH — never by grepping a formatted listing (#815).
 *
 * `git worktree list` prints THREE columns: path, sha, and the BRANCH in brackets. Filtering
 * that output for a string therefore matches branch names too, and this repo has the collision
 * live right now:
 *
 *     /Users/…/wt-763   9929edd0  [fix/763-census-fresh-cleanup]
 *
 * A search for `census-fresh-` matches that line. It is an agent's worktree on a branch named
 * after the issue that FIXED the leak — counted as though it were one of the leftovers. Tonight
 * the whole-line count returned 9 where the path column returned 8.
 *
 * THE SAME CONFOUND HAS BITTEN THIS TEAM THREE TIMES: it cost DEV3-lang a `--force` delete of
 * the worktree they were working in, because their branch name contained the string they were
 * hunting; and it twice made a sweep look incomplete that was not. It is latent rather than
 * live in a before/after delta — a constant offset cancels — but it goes live the moment anyone
 * creates or deletes a branch containing the prefix mid-run, which on this board is a matter of
 * when rather than whether.
 *
 * SO: `--porcelain`, and the `worktree` field. The porcelain format is one record per worktree
 * with the path on its own `worktree <path>` line, no branch column to collide with, and it is
 * the documented stable interface rather than the human-readable one.
 *
 * AND THE MATCH IS ON basename().startsWith(), NOT includes(). A probe lives at
 * `<tmpdir>/<prefix><random>`, so its basename STARTS with the prefix. `includes` would also
 * match a repository that merely happens to sit under a directory containing the string —
 * a checkout at `/Users/someone/census-fresh-notes/repo`, say. Narrower is correct here because
 * the subject is "directories this checker made", not "paths that mention it".
 */
import { basename } from "node:path";

/** Every worktree path in `git worktree list --porcelain` output. */
export function worktreePaths(porcelain) {
  return porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean);
}

/** Those whose directory NAME begins with `prefix` — the ones a probe run created. */
export function probeWorktrees(porcelain, prefix) {
  return worktreePaths(porcelain).filter((p) => basename(p).startsWith(prefix));
}
