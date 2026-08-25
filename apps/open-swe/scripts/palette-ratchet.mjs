#!/usr/bin/env node
/**
 * Bound the apps/open-swe palette exclusion. It may shrink; it may not grow.
 *
 * WHY THIS EXISTS. `check-palette.mjs` deliberately does not scan apps/open-swe —
 * 237 known findings would be 237 cry-wolf failures, and a check that cries wolf
 * gets turned off. But an exclusion is a check that cannot fail over a subject
 * that keeps growing, and it demonstrably did grow: AgentModeBanner.tsx added 12
 * of those 237 AFTER the exclusion was written, and nothing objected, because an
 * excluded path cannot fail.
 *
 * So: no per-finding failures, but the count is pinned.
 *
 * NOT A SECOND HOME FOR THE PATTERN. This imports `scan()` rather than
 * re-implementing the regex. check-palette's own docstring records what a second
 * copy costs: #60 converted apps/example onto tokens and six E2E tests broke
 * because the hardcoded palette had a second home in the assertions.
 *
 * Exit 0 under-or-at baseline, 1 if it grew, 2 if it could not check.
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const CHECKER = join(REPO, "scripts/check-palette.mjs");
const BASELINE = join(REPO, "apps/open-swe/palette-baseline.json");

async function main() {
  // Fail LOUD, not silent, when the checker is absent. A ratchet that cannot find
  // its checker is not passing — it is not running, which is the failure mode this
  // whole exercise exists to stamp out.
  if (!existsSync(CHECKER)) {
    console.error(`palette-ratchet: cannot check — ${CHECKER} not found.`);
    console.error("It lands with the check-palette work; this script depends on it.");
    return 2;
  }
  if (!existsSync(BASELINE)) {
    console.error(`palette-ratchet: cannot check — ${BASELINE} not found.`);
    return 2;
  }

  const { scan } = await import(CHECKER);
  if (typeof scan !== "function") {
    console.error("palette-ratchet: check-palette.mjs does not export scan().");
    return 2;
  }

  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const findings = scan([base.root]);
  const files = new Set(findings.map((f) => f.file)).size;

  console.log(
    `palette-ratchet: ${base.root} — ${findings.length} findings in ${files} files ` +
      `(baseline ${base.findings} in ${base.files})`
  );

  if (findings.length > base.findings) {
    const grew = findings.length - base.findings;
    console.error(`\n✖ The palette exclusion GREW by ${grew}.`);
    console.error("  New hardcoded palette classes were added to an excluded path,");
    console.error("  where check-palette cannot see them. Either use a theme token");
    console.error("  (bg-success / bg-warning / text-muted-foreground / bg-destructive),");
    console.error("  or convert the file and lower the baseline deliberately.");
    console.error("  Context: apps/open-swe/docs/PALETTE-EXCEPTION.md");
    return 1;
  }

  if (findings.length < base.findings) {
    console.log(
      `\n✔ Down ${base.findings - findings.length}. Lower "findings" to ${findings.length} ` +
        `and "files" to ${files} in palette-baseline.json to lock the gain in.`
    );
    return 0;
  }

  console.log("\n✔ Unchanged — exclusion is bounded.");
  return 0;
}

// realpath BOTH sides: import.meta.url is realpath-resolved and process.argv[1] is
// not, so on a symlinked path (/tmp -> /private/tmp) a naive comparison is false,
// main() never runs, and the process exits 0 — a check that passes by not executing.
// That exact bug is why this file exists in the shape it does.
const invokedDirectly =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(await main());
