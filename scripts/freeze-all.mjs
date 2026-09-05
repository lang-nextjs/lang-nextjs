#!/usr/bin/env node
/**
 * Settle BOTH frozen artifacts in one measurement, or refuse and explain.
 *
 * THE DEADLOCK (#275). `rungs:freeze` writes `rungs.json`'s ownedFileCount and
 * refuses while the shared census is stale; `census:freeze` writes
 * `scripts/shared-census.json` and refuses while classification is failing. A
 * single commit that adds one rung-owned file AND one shared file makes both
 * artifacts stale at once, so each refuses because the other is:
 *
 *   $ pnpm rungs:freeze   REFUSING TO FREEZE — the shared census is stale…
 *   $ pnpm census:freeze  REFUSING TO FREEZE — classification is failing…
 *
 * Neither has a --force. There is no ordering that works, and the only way out
 * was to HAND-EDIT the count — the exact thing the freeze exists to prevent.
 *
 * BOTH REFUSALS ARE RIGHT, AND THIS DOES NOT WEAKEN EITHER. Their shared
 * reasoning — "freezing one over a stale other commits a half-consistent tree
 * whose green comes from whichever half you happened to run" — is what makes
 * the pair trustworthy. The refusals exist because the two artifacts are
 * different and people reach for the wrong one.
 *
 * What they are actually protecting against is adopting a number NOBODY
 * MEASURED. That is a property of one process measuring both, which is exactly
 * what this does: it measures, checks that the only thing wrong is staleness,
 * then writes both. It is not an override — it is the case the pair could not
 * express because each could only see half the tree.
 *
 * WHAT IT REFUSES. A classification failure that is not a stale count is not a
 * freezing problem at all, and neither artifact fixes it. A C4 `glob matched
 * zero tracked files` is a dead glob in rungs.json — census.mjs says so in its
 * own refusal — and writing both artifacts over it would bury a real defect
 * under two green checks. Those still stop here, with the underlying message.
 *
 * ORDER IS LOAD-BEARING. Census first, then re-measure, then rungs. classify's
 * refusal explains why: an unclassified file may belong to a rung's `owns`
 * rather than to the shared set, and if it does THEN THE RUNG COUNT CHANGES
 * TOO — so a count measured before the census settles is about to be wrong.
 * Re-running classify after the census freeze is not defensive padding; it is
 * the only measurement that can be trusted.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

/** Run one of the scripts, capturing everything it said. */
function runScript(name, args = []) {
  const r = spawnSync(node, [join(ROOT, "scripts", name), ...args], {
    encoding: "utf8",
  });
  return {
    status: r.status ?? 1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd(),
  };
}

/**
 * Is every classification error merely a stale frozen count?
 *
 * Matched on the C6 marker the error itself carries, not on a substring of the
 * prose around it. A count in the message would have made this pass on any
 * error that happened to mention a number.
 */
function onlyStaleCounts(errors) {
  return (
    errors.length > 0 && errors.every((e) => e.startsWith("C6 census is STALE"))
  );
}

const { classify } = await import(join(ROOT, "scripts", "classify.mjs"));

// --- 1. Measure classification BEFORE touching anything ------------------------------------
const before = classify();

if (!before.ok && !onlyStaleCounts(before.errors)) {
  console.error(
    "REFUSING TO FREEZE BOTH — classification is failing for a reason no freeze fixes.\n"
  );
  for (const e of before.errors) console.error(`  ${e}`);
  console.error(
    "\n  Only a STALE ownedFileCount is a freezing problem. The failures above are\n" +
      "  something else — a C4 dead glob in rungs.json, for instance, is a manifest\n" +
      "  defect, and writing both artifacts over it would bury it under two green\n" +
      "  checks.\n\n" +
      "  Fix the manifest, then re-run `pnpm freeze:all`.\n"
  );
  process.exit(1);
}

// --- 2. Freeze the census first ------------------------------------------------------------
// Its own precondition would refuse here, correctly, on the stale counts we just proved are
// the ONLY thing wrong. `--skip-cross-check` is honoured solely because this process has
// already done the cross-check that precondition stands in for.
const census = runScript("census.mjs", ["--freeze", "--skip-cross-check"]);
if (census.status !== 0) {
  console.error("REFUSING TO FREEZE BOTH — the census freeze itself failed.\n");
  console.error(census.out);
  process.exit(1);
}
console.log(census.out);

// --- 3. RE-MEASURE, because the census may have moved the counts ---------------------------
const after = classify();
if (!after.ok && !onlyStaleCounts(after.errors)) {
  console.error(
    "\nSTOPPED AFTER THE CENSUS — classification now fails for a reason no freeze fixes.\n"
  );
  for (const e of after.errors) console.error(`  ${e}`);
  console.error(
    "\n  The census freeze has been written. rungs.json has NOT been touched, so the\n" +
      "  tree is in the state `pnpm census:freeze` alone would have left it.\n"
  );
  process.exit(1);
}

// --- 4. Freeze the rung counts, from the measurement taken AFTER the census ----------------
const rungs = runScript("classify.mjs", ["--freeze"]);
if (rungs.status !== 0) {
  console.error("\nTHE CENSUS IS FROZEN BUT THE RUNG COUNTS ARE NOT.\n");
  console.error(rungs.out);
  process.exit(1);
}
console.log(rungs.out);

// --- 5. Prove it, rather than announcing it ------------------------------------------------
// Both artifacts are written; the claim worth making is that the checks now pass, and the
// only honest way to make it is to run them.
const verifyCensus = runScript("census.mjs");
const verifyRungs = runScript("classify.mjs");
if (verifyCensus.status !== 0 || verifyRungs.status !== 0) {
  console.error(
    "\nBOTH WERE WRITTEN AND THE CHECKS STILL FAIL — do not commit this.\n"
  );
  if (verifyCensus.status !== 0) console.error(verifyCensus.out);
  if (verifyRungs.status !== 0) console.error(verifyRungs.out);
  process.exit(1);
}
console.log(
  "\nBoth artifacts frozen from one measurement, and both checks re-run clean.\n" +
    "  Commit rungs.json and scripts/shared-census.json TOGETHER — a commit with\n" +
    "  only one of them is the half-consistent tree both guards exist to prevent."
);
