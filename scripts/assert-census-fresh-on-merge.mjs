#!/usr/bin/env node
/**
 * assert-census-fresh-on-merge.mjs — ask the freshness question where the union first exists.
 *
 * #145's silent half, and the half nothing was asking about. Two branches that each add one
 * rung-owned file both freeze N+1 from a base of N. Git sees the SAME NUMBER on both sides, so
 * there is no conflict and no diff: the merge succeeds and the merged tree holds N+2 files
 * declaring N+1. The failure surfaces later, in `pnpm eject`, as a census that does not
 * describe the tree.
 *
 * THE CHECKER FOR THIS ALREADY EXISTS AND IS PROVEN. assert-census-fresh.mjs materialises
 * `merge-tree --write-tree` and recomputes the census against it; its SILENT case is exactly
 * this scenario and reports "two +1 branches merge CLEANLY and the checker still catches it".
 * What was missing was not a mechanism but a MOMENT: it is invoked once, in severability.yml,
 * gated `if: github.event_name == 'pull_request'` and asking about the merge of a BRANCH into
 * its base. Nobody asked it about the merge of two branches into each other, which is what a
 * batch is.
 *
 * MEASURED BEFORE THIS WAS WRITTEN, because the obvious repair is wrong. On a materialised
 * two-branch merged tree whose declaration is one short:
 *
 *     re-freezing it yields 138, the tree declares 137   the divergence is real
 *     node scripts/classify.mjs                exit 0    does NOT catch it
 *     node scripts/census.mjs                  exit 0    different subject: the shared globs
 *     node scripts/freeze-all.mjs              exit 0    it REWRITES rather than verifies
 *
 * So "wire the census check into pnpm checks" — the first thing I tried — closes nothing. The
 * CLI attributes an unregistered arrival to no rung and agrees with the declaration. Only the
 * recompute-and-compare in assert-census-fresh sees it, because it calls classify as a
 * FUNCTION against the probe tree and diffs `stats.byRung` against the merged manifest.
 *
 * WHY NOT MAKE THE COUNT DERIVED (option a). The frozen number is a tripwire: it notices when
 * the tree changed and nobody said so. A derived number can never disagree with the tree,
 * which is another way of saying it can never catch anything. The declaration stays; this
 * refuses to let it drift.
 *
 * WHY NOT RECORD THE BASE IN THE DECLARATION (option b). It does not fire on the case it is
 * for. Two branches freezing from the SAME base both write the same base marker, so the marker
 * is identical on both sides and merges as cleanly as the number did — demonstrated, not
 * argued. A marker that DID conflict would have to be branch-unique, and would then conflict
 * on every pair of branches touching rungs.json, including the ones that are fine.
 *
 * Usage: node scripts/assert-census-fresh-on-merge.mjs
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (a) =>
  execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

let parents;
try {
  parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])
    .split(/\s+/)
    .slice(1);
} catch (e) {
  console.error(
    `REFUSING TO REPORT: cannot read HEAD's parents: ${
      String(e).split("\n")[0]
    }`
  );
  process.exit(2);
}

/*
 * A NON-MERGE COMMIT IS NOT A PASS. It is the absence of a subject, and saying so is the same
 * discipline run-checks applies to a skipped check: a skip is recorded with its reason, never
 * summed into the passes. The per-PR invocation in severability.yml already covers the
 * branch-into-base direction; this one exists for the direction nothing asked about.
 */
if (parents.length < 2) {
  console.log(
    `needs merge-commit — HEAD has ${parents.length} parent(s), so there is no union to judge here.\n` +
      `This is NOT a pass: two branches only collide once something merges them.`
  );
  process.exit(0);
}

console.log(
  `merge commit: asking whether the census survives ${parents[0].slice(
    0,
    12
  )} + ${parents[1].slice(0, 12)}`
);
try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "scripts", "assert-census-fresh.mjs"),
      /*
       * `--at HEAD`, NOT `--base P1 --head P2` (#644).
       *
       * Re-merging the parents asks a question this commit has already answered, and discards
       * every resolution it carries — including the census correction this gate exists to
       * verify. Measured: a union-resolved merge refused with exit 2 over a tree that was
       * right there, and a cleanly-merged commit re-frozen on the union — the fix this
       * checker's own message asks for — was reported STALE, naming a divergence that no
       * longer existed.
       *
       * The parents stay in the line printed above, because "P1 + P2" is what makes the
       * verdict legible. They are not passed here, because they are not needed for the
       * answer: HEAD's rungs.json is the declaration that landed and HEAD's tree is what it
       * owns. That also makes an octopus merge work, which nothing required but which is the
       * sign the shape is right rather than fitted to the two-parent case.
       */
      "--at",
      "HEAD",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
} catch (e) {
  process.exit(e.status ?? 1);
}
