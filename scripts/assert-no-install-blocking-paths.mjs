#!/usr/bin/env node
/**
 * NOTHING IN THE TREE MAKES A FRESH CHECKOUT FAIL BEFORE ANY TEST RUNS (#585).
 *
 * THE INSTANCE. A 131-byte file named `node_modules` was committed — a symlink to a
 * machine-local absolute path, created to share one install between worktrees. pnpm then
 * cannot `mkdir node_modules` because a file occupies that path, so EVERY job that installs
 * dies with `ENOTDIR` before running anything.
 *
 * WHY IT GOT IN. `.gitignore` said `node_modules/`. A trailing slash matches DIRECTORIES
 * ONLY, and a symlink is a file to git no matter what it points at — so the pattern did not
 * cover it and a plain `git add -A` staged it with no warning. Measured at the time:
 * `git check-ignore -v node_modules` exited 1, NOT matched, and `git ls-tree` showed mode
 * 120000. No forced add was involved. That pattern is fixed in the same change as this file.
 *
 * ── WHY A CHECK AS WELL AS THE PATTERN, WHICH IS THE HALF THAT MATTERS ────────────────────
 *
 * A gitignore pattern cannot fail loudly; it can only prevent, and only the case it names.
 * After the pattern fix a path can still arrive by `git add -f`, or as a symlink under a
 * DIFFERENT name — `.venv`, `dist`, a data directory — which the node_modules pattern will
 * never cover.
 *
 * And the cost of the instance was never the bad file. It was that 26 jobs failed
 * IDENTICALLY at "Install dependencies", which is the signature of a runner or registry
 * outage, so hours went into believing CI was broken. Jobs share their first steps, so a
 * content defect at checkout fails all of them the same way and reads as infrastructure.
 *
 * This check exists to put ONE sentence at the top of that red, naming the file. It does not
 * stop the other jobs failing; it explains them.
 *
 * IT THEREFORE RUNS BEFORE `pnpm install`, and that placement is load-bearing rather than
 * incidental: a check registered in checks.json runs under `pnpm checks`, which is AFTER
 * install, so it could never speak about an install that did not happen.
 *
 * ── WHAT IT REFUSES, AND WHY EACH IS NEVER LEGITIMATE ─────────────────────────────────────
 *
 *   AN ABSOLUTE-TARGET SYMLINK   `/Users/someone/...` resolves on exactly one machine. In any
 *                                other checkout it is a dangling path, so it cannot be
 *                                correct anywhere it is read. A RELATIVE symlink is fine and
 *                                is deliberately allowed — it travels with the tree.
 *   ANYTHING AT A node_modules   PATH. Installers own that directory. A tracked file there
 *                                collides with the mkdir; a tracked directory there is
 *                                overwritten or merged unpredictably. Neither is a thing
 *                                anyone means to commit.
 *
 * Usage: node scripts/assert-no-install-blocking-paths.mjs [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--cwd");
const ROOT = resolve(i === -1 ? process.cwd() : argv[i + 1]);

class Refusal extends Error {}

/**
 * Every tracked path with its mode, from git's own index.
 *
 * `git ls-files -s` is the subject rather than a filesystem walk: the question is what the
 * TREE carries, and a walk would also see untracked and ignored files — which is precisely
 * the state a working symlink is supposed to be in. Mode 120000 is git's symlink mode.
 */
export function trackedEntries(cwd = ROOT) {
  let out;
  try {
    out = execFileSync("git", ["-C", cwd, "ls-files", "-s", "-z"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch {
    throw new Refusal(
      `${cwd} is not a git repository, so nothing could be examined.`
    );
  }
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, sha] = meta.split(" ");
      return { mode, sha, path };
    });
}

/** The target a tracked symlink points at — its blob content, verbatim. */
function symlinkTarget(cwd, sha) {
  return execFileSync("git", ["-C", cwd, "cat-file", "blob", sha], {
    encoding: "utf8",
  }).trim();
}

export function analyse(cwd = ROOT) {
  const entries = trackedEntries(cwd);

  /*
   * THE VACUITY GUARD, and it is not ceremony. An empty index makes every loop below pass
   * having examined nothing — "no blocking paths found" over a subject that does not exist.
   * A wrong --cwd is the realistic way to get here, and it produces the reassuring answer.
   */
  if (entries.length === 0) {
    throw new Refusal(
      `${cwd} has no tracked files at all, so this check would pass having examined nothing.`
    );
  }

  const absoluteSymlinks = [];
  for (const e of entries) {
    if (e.mode !== "120000") continue;
    const target = symlinkTarget(cwd, e.sha);
    // Relative targets travel with the tree and are fine. Absolute ones name one machine.
    if (target.startsWith("/")) absoluteSymlinks.push({ path: e.path, target });
  }

  const nodeModules = entries
    .filter((e) => e.path.split("/").includes("node_modules"))
    .map((e) => ({ path: e.path, mode: e.mode }));

  return { examined: entries.length, absoluteSymlinks, nodeModules };
}

function main() {
  let r;
  try {
    r = analyse(ROOT);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSE: ${e.message}`);
      console.error(
        `        Nothing was examined, which is not the same as nothing being wrong.`
      );
      process.exit(2);
    }
    throw e;
  }

  const problems = [];
  for (const s of r.nodeModules) {
    problems.push(
      `  A TRACKED node_modules PATH EXISTS: ${s.path}${
        s.mode === "120000" ? " (a symlink)" : ""
      }\n` +
        `      Installers own that directory. pnpm cannot mkdir over a tracked file there, so\n` +
        `      EVERY job that installs will die at "Install dependencies" with ENOTDIR — which\n` +
        `      looks exactly like a runner outage and is not one.`
    );
  }
  for (const s of r.absoluteSymlinks) {
    problems.push(
      `  A TRACKED SYMLINK POINTS AT AN ABSOLUTE PATH: ${s.path} -> ${s.target}\n` +
        `      That path exists on one machine. Every other checkout gets a dangling link, so\n` +
        `      it cannot be correct anywhere it is read. A RELATIVE symlink is fine here.`
    );
  }

  if (problems.length) {
    console.error(
      `FAIL: ${problems.length} path(s) in this tree break a fresh checkout before any test runs:\n`
    );
    problems.forEach((p) => console.error(p + "\n"));
    console.error(
      `  Fix:   git rm --cached <path>    (and check EVERY commit on the branch, not just the\n` +
        `         tip — \`git commit --amend\` cleans one commit and leaves the rest)\n` +
        `  Cause: .gitignore patterns ending in "/" match DIRECTORIES ONLY, so a symlink of the\n` +
        `         same name is not ignored and \`git add -A\` stages it silently.`
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${r.examined} tracked path(s) examined; none blocks a fresh checkout — ` +
      `no tracked node_modules, no absolute-target symlinks.`
  );
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main();
