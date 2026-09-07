/**
 * THE REPO ROOT, FOUND BY SEARCHING UPWARD RATHER THAN BY COUNTING "..".
 *
 * Five test files in this package reached repo-root artifacts -- rungs.json,
 * docs/, apps/ -- by climbing a FIXED number of levels from their own location:
 *
 *     resolve(__dirname, "../../..")     // packages/server/src -> repo root
 *
 * That constant is right for where the file SITS and wrong for where it RUNS.
 * Stryker copies the package into a sandbox two directories deeper and runs the
 * suite from there, so the same expression lands two levels short:
 *
 *     normal   packages/server/src/                             -> repo root
 *     stryker  packages/server/.stryker-tmp/sandbox-XXXXXX/src/ -> packages/server
 *
 * `apps/`, `docs/` and `rungs.json` do not exist under packages/server, so the
 * walks found nothing, the reads threw ENOENT, and the mutation gate had been red
 * on main for weeks (#1021). It is not a cwd problem: neither __dirname nor
 * import.meta.url consults the working directory, and both report the sandbox.
 *
 * SEARCHING FINDS THE ROOT FROM INSIDE THE SANDBOX because .stryker-tmp lives
 * inside the repository, so the real root is still an ancestor. THAT IS A FACT
 * ABOUT AN UNSET CONFIG KEY, NOT ABOUT THE WORLD: Stryker's `tempDirName`
 * defaults to a path relative to the package, and packages/server/stryker.config.mjs
 * does not set it. Pointing it outside the tree turns every caller of this
 * function from working into refusing -- loudly, and with the search listed, which
 * is the right direction to fail in, but it is a dependency worth being able to
 * grep for from the file that controls it. It also survives
 * a file simply being MOVED between directories, which the constant does not --
 * the class of bug is "a distance recorded in one place and depended on in
 * another", and the repair is to stop recording the distance.
 *
 * WHY pnpm-workspace.yaml IS THE MARKER. It is what makes a directory the root of
 * this workspace, so no intermediate directory can carry one: packages/server has
 * a package.json and a tsconfig.json, which is why neither of those would do. It
 * survives `pnpm eject` -- verified against ejected trees -- so a stripped fork
 * resolves its root the same way.
 *
 * IT REFUSES RATHER THAN GUESSING. A caller that cannot find the root gets an
 * error naming every directory it looked in. Returning a plausible-but-wrong path
 * is what produced #1021: the walk succeeded, found nothing, and the emptiness
 * read as "no app mounts this handler" rather than "I was looking in the wrong
 * tree".
 */
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The file whose presence defines the workspace root. */
export const ROOT_MARKER = "pnpm-workspace.yaml";

/**
 * Accepts what a module can cheaply say about itself: `import.meta.url` (a
 * file:// URL) or `__dirname` (a directory path). A file path is reduced to its
 * directory, so callers never have to remember which they hold.
 */
function startDirectory(location: string): string {
  const asPath = location.startsWith("file:")
    ? fileURLToPath(location)
    : location;
  const absolute = resolve(asPath);
  // A path that does not exist is treated as a file name: its parent is the
  // sensible place to start, and existsSync on a deleted file must not decide.
  return existsSync(absolute) && statSync(absolute).isDirectory()
    ? absolute
    : dirname(absolute);
}

/**
 * Every directory from `location` up to the filesystem root, nearest first.
 * Exported so a caller can name the search in its own failure message.
 */
export function ancestors(location: string): string[] {
  const out: string[] = [];
  let dir = startDirectory(location);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** The repo root, or null when no ancestor carries the marker. */
export function findRepoRoot(location: string): string | null {
  return (
    ancestors(location).find((dir) => existsSync(resolve(dir, ROOT_MARKER))) ??
    null
  );
}

/**
 * The repo root, or a refusal that says where it looked. Use this at module
 * scope: a test that cannot locate the tree it is about has no subject, and
 * saying so is worth more than any assertion it could go on to make.
 */
export function repoRoot(location: string): string {
  const found = findRepoRoot(location);
  if (found !== null) return found;
  throw new Error(
    `REFUSE: no ${ROOT_MARKER} in any ancestor of ${startDirectory(
      location
    )}, ` +
      `so the repository root cannot be located and this file has no subject. ` +
      `Searched:\n  ${ancestors(location).join("\n  ")}`
  );
}
