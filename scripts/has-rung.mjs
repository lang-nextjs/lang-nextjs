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
 * That second line is the fail-closed half. Callers use:
 *
 *     if [ "$(node scripts/has-rung.mjs open-swe)" = "yes" ]; then ... fi
 *
 * Under `bash -e` — which is GitHub Actions' default for `run:` — an unreadable manifest aborts
 * the step instead of quietly reading as "no". "I could not tell" must never look like "absent",
 * for the same reason a missing file must never look like a clean grep.
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
