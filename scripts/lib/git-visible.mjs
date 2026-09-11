/**
 * The files git would show under `cwd`: tracked ones, plus untracked ones no ignore rule excludes.
 *
 * WHY A SWEEP ASKS GIT RATHER THAN SKIPPING DIRECTORY NAMES (#1200). A filesystem walk counts
 * whatever a build left behind. `.svelte-kit/`, `.next/` and each app's `next-env.d.ts` are all
 * gitignored, and the census counted them only when turbo's cache happened to be cold, so one commit
 * gave two counts depending on the machine's history. DEV1 measured the difference as exactly the
 * gitignored files: +54 and +4. A skip list cannot catch `next-env.d.ts`, which sits at an app root,
 * and it is a second copy of `.gitignore` that goes stale without anything noticing.
 *
 * `--others`, so an untracked file a developer is still writing IS examined; only what an ignore rule
 * excludes is dropped. `--exclude-standard` also reads `.git/info/exclude` and the user's global
 * excludes, which are not in the commit. Measured and accepted: those act only on untracked files,
 * and the trees the census and CI measure (fresh worktrees, fresh clones) have none for them to act
 * on. The alternative, `--exclude-per-directory=.gitignore`, would sweep a locally excluded nested
 * checkout (`.claude/worktrees/`) on a developer's machine, which is the same defect again.
 *
 * Throws with git's own message when `cwd` is not in a work tree. A caller must REFUSE (exit 2) on
 * that: without git there is no telling the tree's own files from a build's, and falling back to the
 * walk would silently count both.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function gitVisibleFiles(cwd) {
  const out = execFileSync(
    "git",
    ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
      maxBuffer: 256 << 20,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return new Set(
    out
      .split("\0")
      .filter(Boolean)
      .map((rel) => join(cwd, rel))
  );
}
