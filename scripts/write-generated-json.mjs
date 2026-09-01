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
import { writeFileSync } from "node:fs";

export async function writeGeneratedJson(path, value) {
  let prettier;
  try {
    prettier = (await import("prettier")).default;
  } catch (cause) {
    console.error(
      `REFUSE: cannot write ${path} — prettier is not resolvable from this tree.\n` +
        `        It is a declared devDependency; run \`pnpm install\`. Writing the file\n` +
        `        unformatted would regenerate the exact defect #622 removed: an artifact\n` +
        `        the format gate rejects, produced by the command that fixes it.\n` +
        `        (${cause?.message ?? cause})`
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
