#!/usr/bin/env node
/**
 * has-rung.mjs — does THIS tree declare a given rung? Prints `yes` or `no`.
 *
 * For CI steps and scripts that invoke a rung-owned workspace. `pnpm --filter open-swe dev`
 * in a rung-1 fork starts an app that is not there; the step exists on main and must not exist
 * in that fork.
 *
 * WHY A GUARD RATHER THAN LETTING `pnpm eject` PRUNE THE STEP.
 *
 * eject already deletes files, rewrites barrels, prunes playwright projects and edits the Python
 * registries — so editing a workflow step would not be a new capability. It would be a new
 * mutation class WITH NO VERIFIER, which is the part that matters. Every other thing eject
 * rewrites has something downstream that checks it: deletions are counted exactly against the
 * frozen census, barrel edits are caught by tsc, the Python edits are executed by the py matrix
 * booting a real server. A pruned YAML step has nothing. Workflow YAML that still parses can be
 * semantically wrong, and the fork's first CI run is where you would find out.
 *
 * The guard is also the better artifact ON MAIN. A step named "Start open-swe dev server"
 * asserts that this repo has an open-swe app. If that is conditional, the workflow should say so
 * — that is information a reader wants here, not only in a fork. Deleting the step in a fork
 * HIDES the conditionality; guarding it DOCUMENTS it.
 *
 * And it is derived by construction rather than by tool: this reads the manifest at run time, so
 * there is no moment where something decides what to remove and could decide wrong.
 *
 * The cost, stated plainly: a fork carries guarded steps that never fire. Self-documenting
 * clutter is a better trade than a tool silently rewriting somebody's CI.
 *
 * CONTRACT
 *   stdout `yes` / `no`, exit 0   — the manifest was read and answered
 *   exit non-zero, empty stdout   — the manifest could not be read; the CALLER MUST FAIL
 *
 * CALLERS MUST CHECK THE EXIT CODE. This is not a style note — the original callers did not,
 * and the guard was the exact defect it was written to prevent.
 *
 * The first version of this file documented the opposite, confidently and untested:
 *
 *     WRONG:  if [ "$(node scripts/has-rung.mjs open-swe)" = "yes" ]; then ... fi
 *             "Under `bash -e` an unreadable manifest aborts the step."
 *
 * It does not. `$( )` inside a `[ ]` string comparison yields the command's STDOUT; the exit
 * status of the `if` comes from `[`, never from the substitution. So exit 2 was discarded
 * entirely, stdout was empty, `"" != "yes"` was true, and BOTH error paths — a missing argument
 * and an unreadable manifest — silently SKIPPED the guarded step and left the job green.
 *
 * Measured: `bash -e -c 'if [ "$(node scripts/has-rung.mjs)" != "yes" ]; then ...'` reaches the
 * skip branch and continues. `set -e` cannot help; there is no non-zero status to see.
 *
 * The step this guards starts the open-swe dev server, so a silent skip means the open-swe E2E
 * specs run against nothing.
 *
 *     RIGHT:  if ! present=$(node scripts/has-rung.mjs open-swe); then
 *               echo "cannot determine rung presence"; exit 1
 *             fi
 *             if [ "$present" != "yes" ]; then echo "skipping"; exit 0; fi
 *
 * `if ! var=$(...)` DOES consult the exit status, so "I could not tell" fails loudly instead of
 * reading as "absent" — the same rule as a missing file never looking like a clean grep.
 *
 * Usage: node scripts/has-rung.mjs <rung-id>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = process.argv[2];

if (!id) {
  console.error("usage: has-rung.mjs <rung-id>");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(process.env.RUNGS_MANIFEST || join(ROOT, "rungs.json"), "utf8"));
} catch (e) {
  console.error(`has-rung: cannot read rungs.json, so rung "${id}" cannot be resolved: ${e.message}`);
  process.exit(2);
}

if (!Array.isArray(manifest.rungs) || manifest.rungs.length === 0) {
  console.error(`has-rung: rungs.json declares no rungs — refusing to answer for "${id}"`);
  process.exit(2);
}

process.stdout.write(manifest.rungs.some((r) => r.id === id) ? "yes\n" : "no\n");
