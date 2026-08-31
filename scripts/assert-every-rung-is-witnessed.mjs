#!/usr/bin/env node
/**
 * Property: EVERY RUNG ABOVE THE FLOOR IS REMOVED BY AT LEAST ONE SEVERABILITY CELL.
 *
 * #481 fixed the per-cell half: each eject cell now asserts that the rungs it does not retain
 * are absent from the fork, by name and by count. Nothing checks the half BETWEEN the cells —
 * that the cells, taken together, exercise every rung on the removed side at all.
 *
 * A rung nothing removes has never been shown severable. Today that holds only because the
 * ladder is cumulative, which is a real guarantee stated nowhere: a future matrix edit could
 * drop a rung's only witnessing cell and every remaining cell would stay green, because each
 * one only ever speaks about its own removals.
 *
 * ── WHAT THIS CAN AND CANNOT CATCH TODAY, MEASURED ────────────────────────────────────────
 *
 * THE PROPERTY IS CURRENTLY ENTAILED, and saying so is the difference between a second line of
 * defence and a check pretending to be a first. `matrix.mjs` already refuses a manifest where
 * any rung gets no job:
 *
 *     FAIL: 1 declared rung(s) get no job and would never be verified: langchain (languages: [])
 *
 * Given a cell for every rung, and cells that retain a PREFIX of the ladder, the lowest cell
 * retains the floor alone and therefore removes every rung above it. So the coverage this
 * asserts follows from a guard that exists — written for a different reason, stated in
 * different terms, and load-bearing for this without saying so.
 *
 * That makes this a SECOND LINE, and it earns its place two ways: it PRINTS the mapping rung →
 * witnessing cell, which the entailment does not, and it fails if that entailment is ever
 * broken — the prefix property changing, the uncovered-rung guard being weakened, or the
 * matrix being derived some other way. What it does NOT do is catch a defect reachable today:
 * the failure below cannot be produced through the real generator, and the selftest constructs
 * it by supplying cells directly. A check whose red is currently unreachable through the real
 * inputs should say so rather than let its green be read as vigilance.
 *
 * ── THE FLOOR IS EXCLUDED, AND HERE IS WHY ────────────────────────────────────────────────
 *
 * Every cell retains a PREFIX of the ladder and the shortest prefix is the floor alone, so the
 * bottom rung is in every retained set BY CONSTRUCTION. Measured on main before this was
 * written:
 *
 *     langchain                  removed by 0 cell(s)
 *     langgraph                  removed by 2
 *     deepagents                 removed by 4
 *     open-swe                   removed by 6
 *     software-developer-agent   removed by 7
 *
 * So "every rung is removed by some cell" is not merely unmet, it is UNSATISFIABLE. Requiring
 * it would ship red, or ship with a day-one exemption on the floor — an allowlist entry
 * created in the same commit as the check it defeats, which is the hardest kind to ever
 * remove because it arrives with a good reason already attached.
 *
 * THE HONEST STATEMENT IS THAT THE QUESTION DOES NOT APPLY. There is nothing below the floor
 * for it to be severable FROM, so "is the floor severable" may not be a question `eject` can
 * ask; if it is worth asking it needs a different instrument. The exclusion is printed rather
 * than silent, for the same reason #481's IDENTITY cell is: a reader who goes looking for the
 * floor's severability should be redirected, not left to conclude it was checked.
 *
 * THIS IS THE SAME LIMIT AT BOTH ENDS. The top of the ladder cannot witness ITSELF — the cell
 * named after the top rung retains everything and removes nothing (#481). The bottom is never
 * removed by anything. The middle rungs are the only ones the matrix can speak about on both
 * sides, and that is a property of a cumulative ladder rather than a defect in the matrix.
 *
 * ── THE FLOOR IS COMPUTED, NEVER NAMED ────────────────────────────────────────────────────
 *
 * It is the rung that REQUIRES NOTHING — which is the exclusion's own reason expressed as
 * data, not a proxy for it. Hardcoding "langchain" would be an exemption wearing a
 * computation's clothes, and it would silently become wrong the day a rung is inserted below:
 * the new rung would carry `requires: []` and the old floor would gain a requirement, so this
 * moves on its own.
 *
 * Usage: node scripts/assert-every-rung-is-witnessed.mjs [--cwd DIR]
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const cwdFlag = process.argv.indexOf("--cwd");
const ROOT =
  cwdFlag !== -1 && process.argv[cwdFlag + 1]
    ? resolve(process.argv[cwdFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/** The severability matrix, read from the generator rather than re-derived. */
export function readCells(root = ROOT) {
  const out = execFileSync("node", [join(root, "scripts", "matrix.mjs"), "--github"], {
    cwd: root,
    encoding: "utf8",
  });
  const line = out.split("\n").find((l) => l.startsWith("matrix="));
  if (!line) return null;
  return JSON.parse(line.slice("matrix=".length)).include;
}

/**
 * The rung with nothing below it.
 *
 * Returned with a `problem` rather than a guess when the ladder is not a ladder: two rungs
 * requiring nothing is a forest, none is a cycle, and in both cases "the floor" is not a thing
 * this check can identify. Refusing beats picking one.
 */
export function findFloor(rungs) {
  const roots = rungs.filter((r) => !Array.isArray(r.requires) || r.requires.length === 0);
  if (roots.length === 0) {
    return { problem: `no rung declares an empty \`requires\`, so the ladder has no floor — every rung sits on another one, which is a cycle rather than a ladder.` };
  }
  if (roots.length > 1) {
    return { problem: `${roots.length} rungs declare an empty \`requires\` [${roots.map((r) => r.id).join(", ")}], so this is a forest rather than a ladder and "the floor" is ambiguous.` };
  }
  const floor = roots[0];

  /*
   * TWO FACTS THAT MUST AGREE, WITH NOTHING ELSE ASSERTING THAT THEY DO. `requires` and
   * `ordinal` both encode the ladder. If they disagree the manifest is inconsistent and every
   * verdict below is over the wrong subject, so this refuses rather than trusting one.
   */
  const byOrdinal = [...rungs].sort((a, b) => a.ordinal - b.ordinal)[0];
  if (byOrdinal && byOrdinal.id !== floor.id) {
    return { problem: `\`requires\` says the floor is "${floor.id}" but the lowest \`ordinal\` is "${byOrdinal.id}". The manifest encodes the ladder twice and the two disagree.` };
  }
  return { floor };
}

export function evaluate(root = ROOT) {
  const manifestPath = join(root, "rungs.json");
  if (!existsSync(manifestPath)) return { problem: `no rungs.json at ${manifestPath}` };
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rungs = m.rungs ?? [];
  if (rungs.length < 2) {
    return { problem: `manifest declares ${rungs.length} rung(s); a ladder with fewer than two has no "above the floor" to check.` };
  }

  const cells = readCells(root);
  if (!cells || cells.length === 0) {
    return { problem: `the matrix generator emitted no cells, so no rung is witnessed by anything and every check below would be vacuous.` };
  }

  const f = findFloor(rungs);
  if (f.problem) return { problem: f.problem };

  const rows = rungs.map((r) => ({
    id: r.id,
    isFloor: r.id === f.floor.id,
    witnesses: cells
      .filter((c) => !String(c.retained).split(",").map((s) => s.trim()).includes(r.id))
      .map((c) => c.name),
  }));
  return { floor: f.floor.id, cells, rows };
}

function main() {
  const r = evaluate(ROOT);

  if (r.problem) {
    console.error(
      `FAIL: ${r.problem}\n      This checker is about which rungs the matrix removes, so it ` +
        `COULD NOT COMPUTE the\n      property rather than finding that it holds.`
    );
    process.exit(2);
  }

  // NAME THE SUBJECT: which cells, which rungs, and which cell witnesses each one.
  console.log(`${r.cells.length} severability cell(s); floor is "${r.floor}" (requires nothing)`);
  const unwitnessed = [];
  for (const row of r.rows) {
    if (row.isFloor) {
      console.log(
        `  ${row.id.padEnd(26)} FLOOR — excluded. Every cell retains a prefix of the ladder and ` +
          `the\n  ${" ".repeat(26)} shortest prefix is the floor alone, so nothing can remove it. ` +
          `There is\n  ${" ".repeat(26)} nothing below it for it to be severable FROM; that may ` +
          `not be a\n  ${" ".repeat(26)} question eject can ask.` +
          (row.witnesses.length > 0
            ? `\n  ${" ".repeat(26)} NOTE: it IS removed by ${row.witnesses.length} cell(s) — the ladder changed shape.`
            : "")
      );
      continue;
    }
    console.log(`  ${row.id.padEnd(26)} removed by ${String(row.witnesses.length).padStart(2)} cell(s)  ${row.witnesses.join(", ")}`);
    if (row.witnesses.length === 0) unwitnessed.push(row.id);
  }

  if (unwitnessed.length > 0) {
    console.error(
      `\nFAIL: ${unwitnessed.length} rung(s) above the floor are removed by NO cell: ` +
        `${unwitnessed.join(", ")}.\n` +
        `      Each cell asserts only its own removals, so every one of them stays green while ` +
        `a\n      rung goes unexercised on the removed side — its severability has never been ` +
        `shown.\n      Add a cell that retains the rungs below it and stops there.`
    );
    process.exit(1);
  }
  console.log(
    `\nPASS: every rung above the floor is removed by at least one cell, and the cell is named.\n` +
      `      The floor is excluded because nothing can remove it, not because it was skipped.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
