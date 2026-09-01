/**
 * A GENERATED JSON ARTIFACT IS WRITTEN IN THE SHAPE THE FORMAT GATE EXPECTS (#622).
 *
 * THE LOOP THIS BREAKS. `rungs.json` and `scripts/shared-census.json` are written by
 * `classify.mjs --freeze` and `census.mjs --freeze` with `JSON.stringify(x, null, 2)`, which
 * is NOT what prettier produces — prettier collapses a short array onto one line when it fits
 * the print width, and stringify always expands it. So both files fail `prettier --check` the
 * moment they are regenerated. Formatting them by hand works and is undone by the very next
 * freeze, which is the operation that necessitated it. Measured: `--write` then `--check`
 * exits 0; `pnpm census:freeze` then `--check` exits 1 again.
 *
 * `assert-formatted` gates CHANGED files, so these sat inert until a branch touched them —
 * and the branches that touch them are every rung-owned file addition and every integration
 * batch, which is why it surfaced as two PRs failing for something their authors did not do.
 *
 * WHY FORMATTING HERE RATHER THAN IGNORING THE FILES. `.prettierignore` would be smaller, and
 * this repo already does it for `packages/rungs/src/generated.ts`. But that is a generated
 * TypeScript barrel nobody greps, and these two are READ AS TEXT by assert-census-fresh,
 * classify, assert-no-undeclared-reverts and others. Ignoring them would leave NOTHING pinning
 * their shape, in a repo where #463 was filed because a re-indent made a parity reader find
 * nothing. The trade that is right for the barrel is wrong here.
 *
 * ── THE VERSION QUESTION, MEASURED RATHER THAN ASSUMED ────────────────────────────────────
 *
 * Formatting here couples the artifacts to prettier, and #577 has a version bump pending. So:
 * do 2.8.8 and 3.x agree on JSON? On both artifacts, and on a stress case covering short and
 * long and empty arrays, nesting, unicode, escapes, numbers and long strings — the output is
 * BYTE-IDENTICAL, and idempotent under re-formatting. A future bump does not rewrite these.
 *
 * THE API IS NOT VERSION-STABLE EVEN THOUGH THE OUTPUT IS, and that is the coupling that
 * actually exists: `format()` returns a string in 2.8.8 and a Promise in 3.x. `await` accepts
 * both, which is why every call here is awaited even though today's prettier is synchronous.
 * Removing the await would work now and break on the bump.
 *
 * IF PRETTIER IS ABSENT this REFUSES with exit 2 rather than writing unformatted output. A
 * generator that silently produced a file the gate rejects is the loop above, re-created one
 * level down — and exit 2 is this repo's code for "could not do the work", as distinct from
 * "the work found a problem" (#580).
 */
import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Prettier, from this tree if it has one and from the CHECKOUT THIS WORKTREE BELONGS TO if
 * it does not.
 *
 * WHY THE FALLBACK EXISTS, AND WHY IT IS NOT A SHORTCUT. A linked worktree has no
 * node_modules, so requiring the formatter made the freeze refuse in every temp-worktree
 * fixture. That broke three selftests in two rounds — two I found and repaired by lending the
 * install to each worktree, and a THIRD that landed on main after I swept, and hit exactly the
 * same wall. The population grew between writing the fix and landing it, which is a property
 * of parallel work and not something a more careful sweep would have caught.
 *
 * So the repair is to stop having a rule for callers to remember. THE FORMATTER IS TOOLING,
 * NOT PART OF THE TREE UNDER TEST: a linked worktree shares its checkout's installation, and
 * that install is the one `pnpm freeze:all` would use if run normally. Resolving it there is
 * the same answer, not a different one.
 *
 * IT CANNOT MASK A GENUINELY MISSING INSTALL. In a plain clone `--git-common-dir` is this
 * repo's own .git, so the fallback looks in the same tree, finds nothing, and the refusal
 * below still fires. The fallback discriminates exactly the worktree case and nothing else.
 */
async function loadPrettier(nearPath) {
  try {
    return (await import("prettier")).default;
  } catch {
    // fall through — a linked worktree simply has no node_modules of its own
  }
  try {
    const from = dirname(resolve(nearPath));
    const common = execFileSync(
      "git",
      ["-C", from, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
    const checkout = dirname(resolve(from, common));
    if (!existsSync(join(checkout, "node_modules"))) return null;
    const req = createRequire(join(checkout, "package.json"));
    const spec = req.resolve("prettier");
    const mod = await import(pathToFileURL(spec).href);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function writeGeneratedJson(path, value) {
  const prettier = await loadPrettier(path);
  if (!prettier) {
    console.error(
      `REFUSE: cannot write ${path} — prettier is not resolvable from this tree, nor from
` +
        `        the checkout this worktree belongs to. It is a declared devDependency; run
` +
        `        \`pnpm install\`. Writing the file unformatted would regenerate the exact
` +
        `        defect #622 removed: an artifact the format gate rejects, produced by the
` +
        `        command that fixes it.`
    );
    process.exit(2);
  }

  // The gate reads .prettierrc.json, so this must too — a printWidth mismatch would produce
  // a file that is "formatted" by a config nothing else uses.
  const options = (await prettier.resolveConfig(path)) ?? {};
  const text = await prettier.format(JSON.stringify(value, null, 2), {
    ...options,
    parser: "json",
  });
  writeFileSync(path, text);
  return text;
}
