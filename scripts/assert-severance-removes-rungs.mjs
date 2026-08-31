#!/usr/bin/env node
/**
 * Property: EVERY RUNG THE FORK DOES NOT RETAIN IS ABSENT FROM IT, BY NAME AND BY COUNT.
 *
 * The severability matrix runs a step called "severance is exact and non-vacuous". Both of its
 * guards check for OVER-deletion:
 *
 *     if [ "$AFTER" -lt 1 ] ...                 fork has zero test files
 *     if [ "$AFTER" -lt "$MIN" ] ...            kept less than half — over-deletion?
 *
 * NOTHING IN IT REQUIRES `AFTER < BEFORE`. So severing NOTHING satisfies a check written to
 * prove severance happened, and `eject 5-software-developer-agent` — which retains all five
 * rungs and removes zero files — passes it. Measured on main @ 0109169a, run 33383736903:
 *
 *     eject 1-langchain                 RETAINED: langchain                   211 -> 138
 *     eject 4-open-swe                  RETAINED: langchain..open-swe         211 -> 200
 *     eject 5-software-developer-agent  RETAINED: langchain..sda              211 -> 211
 *
 * That is not a defect in `eject`: the ladder is cumulative, so a rung-5 fork legitimately
 * contains everything. The defect is that the one job carrying rung 5's NAME contributes
 * nothing to rung 5's severability, and its green reads as though it does. Same family as a
 * criterion that passes by symmetry — THE IDENTITY CASE SATISFIES A RULE WRITTEN FOR THE
 * ASYMMETRIC ONE (#481).
 *
 * ── THE INVERSION, WHICH IS THE POINT ─────────────────────────────────────────────────────
 *
 * Rung 5's severability is NOT proven by ejecting TO rung 5. It is proven by the four cells
 * BELOW it, where rung 5 is the thing removed. A reader looking for rung 5's evidence goes to
 * the cell with rung 5's name, which is the one cell that cannot provide it.
 *
 * So this asserts the property where it is actually claimed, and PRINTS IT — `248 -> 0` rather
 * than a green tick. Until now it held only as a side effect of `classify.mjs`'s total-and-
 * disjoint requirement on the fork, which is a real guarantee stated nowhere.
 *
 * ── WHY TWO PHASES ────────────────────────────────────────────────────────────────────────
 *
 * Ownership can only be computed BEFORE the eject: afterwards the manifest no longer declares
 * the removed rungs and their files are gone from the index, so nothing on disk can say what
 * rung 5 used to own. `--record` captures the subject; `--verify` checks it is gone. A check
 * that derived the subject from the post-eject tree would be asking the fork to describe what
 * it no longer contains.
 *
 * Ownership comes from `classify()`'s exported `owner` map, whose own comment says it is
 * exposed so other gates need not reimplement the glob matcher: "a second implementation is a
 * second answer, and the two drift silently."
 *
 * Usage:
 *   node scripts/assert-severance-removes-rungs.mjs --record <file>
 *   node scripts/assert-severance-removes-rungs.mjs --verify <file> --retained a,b,c [--cwd DIR]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { classify } from "./classify.mjs";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const ROOT = resolve(argOf("--cwd") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

/** Every rung's owned files, as the classifier sees them right now. */
export function record(root = ROOT) {
  const manifestPath = join(root, "rungs.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: `no rungs.json at ${manifestPath}` };
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = classify(root, m);

  const byRung = {};
  for (const rung of m.rungs) byRung[rung.id] = [];
  for (const [file, rungId] of result.owner) {
    if (byRung[rungId]) byRung[rungId].push(file);
  }
  for (const id of Object.keys(byRung)) byRung[id].sort();
  return { ok: true, byRung };
}

export function verify(recorded, retained, root = ROOT) {
  const all = Object.keys(recorded);
  const keep = new Set(retained);
  const removed = all.filter((id) => !keep.has(id));
  const rows = removed.map((id) => {
    const owned = recorded[id];
    const present = owned.filter((f) => existsSync(join(root, f)));
    return { id, owned: owned.length, present };
  });
  return { all, removed, rows };
}

function main() {
  const recordTo = argOf("--record");
  const verifyFrom = argOf("--verify");

  if (recordTo) {
    const r = record(ROOT);
    if (!r.ok) {
      console.error(`FAIL: ${r.reason}`);
      process.exit(2);
    }
    const counts = Object.entries(r.byRung).map(([k, v]) => `${k}=${v.length}`);
    /*
     * VACUITY. A record of zero owned files makes every absence assertion below trivially
     * true, and that is what a broken walk or a mis-parsed manifest produces. "I measured
     * nothing" and "there was nothing to measure" print the same green otherwise.
     */
    const total = Object.values(r.byRung).reduce((n, v) => n + v.length, 0);
    if (total === 0) {
      console.error(
        `FAIL: recorded 0 owned files across ${Object.keys(r.byRung).length} rung(s).\n` +
          `      Every later "these files are absent" check would pass vacuously, so this ` +
          `COULD NOT\n      COMPUTE the property rather than finding it holds.`
      );
      process.exit(2);
    }
    writeFileSync(recordTo, JSON.stringify(r.byRung));
    console.log(`recorded owned files per rung -> ${recordTo}`);
    console.log(`  ${counts.join("  ")}`);
    return;
  }

  if (!verifyFrom) {
    console.error("FAIL: pass --record <file> or --verify <file> --retained a,b,c");
    process.exit(2);
  }
  const retainedArg = argOf("--retained");
  if (!retainedArg) {
    console.error("FAIL: --verify requires --retained");
    process.exit(2);
  }
  if (!existsSync(verifyFrom)) {
    console.error(
      `FAIL: no record at ${verifyFrom}. The pre-eject step did not run, so there is nothing ` +
        `to\n      check absence against — which is not the same as everything being absent.`
    );
    process.exit(2);
  }
  const recorded = JSON.parse(readFileSync(verifyFrom, "utf8"));
  const retained = retainedArg.split(",").map((s) => s.trim()).filter(Boolean);
  const { all, removed, rows } = verify(recorded, retained, ROOT);

  /*
   * THE IDENTITY CASE, NAMED RATHER THAN PASSED OVER.
   *
   * A fork that retains every rung removes nothing, so "the removed rungs are absent" is
   * vacuously true. Reporting that as a pass is exactly the defect this check exists to close,
   * so it says what it is instead — and says where the evidence actually lives.
   */
  if (removed.length === 0) {
    console.log(
      `IDENTITY: this fork retains all ${all.length} rung(s) [${all.join(", ")}] and removes ` +
        `none.\n` +
        `          Nothing was severed, so THIS CELL IS NOT EVIDENCE OF SEVERANCE for any ` +
        `rung —\n          including the one it is named after. The ladder is cumulative, so ` +
        `the topmost\n          fork legitimately contains everything; what it proves is that ` +
        `the whole tree\n          still builds, which is worth having under a different name.\n` +
        `          Severability of the top rung is proven by the cells BELOW it, where it is ` +
        `the\n          thing removed.`
    );
    return;
  }

  let bad = 0;
  console.log(`fork retains [${retained.join(", ")}], so ${removed.length} rung(s) must be gone:`);
  for (const row of rows) {
    // NAME THE SUBJECT AND PRINT THE NUMBER. "0 present" is only meaningful beside the count
    // that should have gone to zero.
    console.log(`  ${row.id.padEnd(28)} ${row.owned} owned -> ${row.present.length} present`);
    if (row.present.length > 0) {
      bad++;
      for (const f of row.present.slice(0, 10)) console.error(`      STILL PRESENT: ${f}`);
      if (row.present.length > 10) console.error(`      … and ${row.present.length - 10} more`);
    }
  }

  if (bad > 0) {
    console.error(
      `\nFAIL: ${bad} removed rung(s) left files behind. A fork that still carries a rung it ` +
        `does not\n      declare is not severed from it — the manifest says one thing and the ` +
        `tree another.`
    );
    process.exit(1);
  }
  const totalOwned = rows.reduce((n, r) => n + r.owned, 0);
  console.log(
    `\nPASS: ${totalOwned} file(s) owned by ${removed.length} non-retained rung(s), 0 present ` +
      `in the fork.\n      Asserted by name and by count, not inferred from the classifier ` +
      `still being total.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
