#!/usr/bin/env node
/**
 * traceability.mjs — every ✓ requirement in PROJECT.md names a test that exists.
 *
 * THE DEFECT (#36). 43 requirements carry a ✓ and, until this check, not one named the test
 * that earns it. That is not merely "untested" — combined with the id collision fixed in #207,
 * "find the test for this ✓" returned a green test that tested something else, so CHECKING IT
 * FELT LIKE IT WORKED. A claim with no link is unfalsifiable; a claim with a wrong link
 * manufactures confidence.
 *
 * WHAT THIS VERIFIES, AND WHAT IT CANNOT — read this before trusting a green run.
 * It verifies that a citation EXISTS and RESOLVES: the file is there and contains a test of
 * that name. **It cannot verify that the cited test actually tests the requirement.** DEV5's
 * ADAPT-01 is the standing counter-example — twelve tests kept passing with the pipeline order
 * deliberately flipped, so they were green against a property they did not exercise. No link
 * checker catches that; only a reader does.
 *
 * So the whole claim is: this converts 43 UNVERIFIABLE claims into 43 HUMAN-CHECKABLE ones.
 * It must not be sold as more than that, and a green run is not evidence a requirement holds.
 *
 * WHAT WOULD MAKE THIS PASS WHILE TRACEABILITY IS BROKEN?
 *   1. Validate only the rows that HAPPEN to carry a citation. On a file with zero citations —
 *      today's state — that passes vacuously while proving nothing. TOTALITY is therefore the
 *      load-bearing decision here: every ✓ row must be cited OR explicitly allowlisted.
 *   2. The parse finds no rows at all, so "all zero rows are cited" holds.
 *      >>> G1: row count > 0 and equal to an independent grep.
 *   3. Two rows share an id, so one claim silently shadows another and an audit keyed on ids
 *      collapses them.
 *      >>> G2: duplicate ids are refused.
 *   4. The UNCITED allowlist rots into a mute button as rows get backfilled.
 *      >>> G3: every entry must STILL be uncited, and must still name a real row.
 *
 * CITATION SYNTAX, appended to a ✓ row:
 *   - ✓ **SRV-01** — description — v1.0 — verified by `path/to/file.test.ts` "the test name"
 *
 * Usage: node scripts/traceability.mjs [--root DIR] [--json]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
const ROOT = ri === -1 ? process.cwd() : argv[ri + 1];
const JSON_OUT = argv.includes("--json");

const PROJECT = join(ROOT, ".planning/PROJECT.md");

/**
 * Requirements whose ✓ predates this check and carries no citation yet.
 *
 * NOT a mute button. G3 asserts every entry is STILL uncited and STILL a real row, so
 * backfilling one makes its entry stale and this check tells you to delete it. The list only
 * ever shrinks; adding to it is a visible, reviewable edit.
 *
 * Landing with everything allowlisted is deliberate: an empty-but-honest gate that grows beats
 * a 43-row backfill PR that stalls. The backfill is the real work and belongs in its own
 * changes.
 */
const UNCITED = new Set([
  "ADAPT-01","ADAPT-02","ADAPT-03","ADAPT-04","AUTH-01","CI-01","DASH-01",
  "DASH-02","DASH-03","DASH-04","DASH-05","DX-01","DX-02","DX-03","E2E-01","E2E-02",
  "E2E-03","E2E-04","E2E-05","EX-01","FWK-01","FWK-02","MCP-01","MCP-02",
  "MCP-03","MCP-04","PKG-01","PKG-02","PKG-03","PKG-04","RCT-01","RCT-02","RCT-03",
  "RCT-04","SRV-01","SRV-02","SRV-03","SRV-04","SRV-05","SRV-06","STR-02",
]);


/**
 * Ids carried by MORE THAN ONE ✓ row. PERMANENT BY RULING — see PROJECT.md.
 *
 * v1.2 and v1.5 each assigned ADAPT-03 and ADAPT-04 to different requirements. Ruled: do NOT
 * renumber. Renumbering the v1.5 pair makes every v1.5 document citing ADAPT-03 resolve to the
 * v1.2 requirement; renumbering v1.2 does the same in reverse. Either way one archive lies
 * SILENTLY — the reference still resolves, just to the wrong thing — which is strictly worse
 * than resolving to two things a reader can see. An ambiguity you can detect beats a wrong
 * answer you cannot. Requirement ids are historical keys (#207), and a duplicated key is not an
 * exception to that rule but the case that most tempts you to break it.
 *
 * This is NOT "duplication is fine". It is that the duplication already happened and every
 * available repair costs more than it recovers. Read the note in PROJECT.md before touching it.
 *
 * The staleness check below is kept even though these entries are expected to be permanent: if
 * someone renumbers anyway, the entry stops applying and this says so — surfacing a change that
 * contradicts the ruling rather than letting it pass quietly.
 *
 * NEW duplicates are still refused. That is the part with future value.
 */
/*
 * Ids that legitimately carry more than one ✓ row (a v1.2 claim and a v1.5 claim, say), so G2
 * does not read them as two claims colliding on one key.
 *
 * THIS SET INTERACTS WITH `UNCITED`, AND THE INTERACTION IS NOT VISIBLE FROM EITHER ONE.
 * `cited` is keyed by ID while the totality loop runs per ROW, so a duplicated id is either
 * fully cited or fully allowlisted — never half. Cite one row and keep the entry: G3 reports
 * STALE ALLOWLIST. Cite one row and delete the entry: the OTHER row is unmuted and reports
 * UNCITED, naming an id the author just cited. Both halves must land in the same change.
 *
 * Documented here and repeated in the UNCITED note itself, because the only other way to
 * learn it is to break the checker, and the failure names an id rather than a row.
 */
const DUPLICATE_IDS = new Set(["ADAPT-03", "ADAPT-04"]);

/**
 * A ✓ ROW WHOSE OWN PROSE RETRACTS THE TICK (#510).
 *
 * `ROW` treats the tick as the status and captures everything after the id as `rest`, which is
 * searched only for a citation. So a row can say "nothing runs them, so nothing passes them"
 * and still be counted as satisfied: a reader gets the truth and every tool gets the tick.
 *
 * That is not an incomplete record, it is a SELF-CONTRADICTORY one — a WRONG-class finding that
 * landed as an annotation next to a machine-readable status it did not change. The honest
 * correction was made, in prose, in the one place nothing reads.
 *
 * MEASURED BEFORE IT WAS WRITTEN, not invented: across the 45 ✓ rows in PROJECT.md today, these
 * phrases appear in exactly the two rows that retract themselves and in none of the other 43.
 * A pattern calibrated against the corpus rather than against an idea of one.
 */
const RETRACTION =
  /nothing (?:runs|passes)|no longer (?:runs|passes|applies)|does not run|\bretired\b|\bsuperseded\b|\bwithdrawn\b/i;

/**
 * Rows already known to retract themselves, with the tick still standing.
 *
 * NOT A MUTE BUTTON, and the staleness check below is what makes that true rather than merely
 * claimed: the moment a listed row stops being a self-contradicting ✓ — because someone removed
 * the tick, which is the honest repair — its entry goes STALE and this tells you to delete it.
 * The list can only shrink, exactly like UNCITED above.
 *
 * These two are PRODUCT's to repair: the rows claim tooling that is not a dependency, a script
 * or in any workflow. There is no citation to add and no test to write. Listing them here does
 * not endorse the ✓ — it records that the checker can now SEE them, which it could not before.
 */
const RETRACTED_TICKS = new Set(["PKG-03", "PKG-04"]);

const ROW = /^- ✓ \*\*([A-Z0-9]+-[0-9]+)\*\*(.*)$/;
const CITE = /verified by `([^`]+)` "([^"]+)"/;

const src = readFileSync(PROJECT, "utf8");
const lines = src.split("\n");

const rows = [];
lines.forEach((line, i) => {
  const m = ROW.exec(line);
  // The 1-indexed line travels with the row so a note about a DUPLICATED id can name the row
  // it means. Reporting only the id is what makes the duplicate interaction below unreadable:
  // the reader has just cited that id and is told it names no test.
  if (m) rows.push({ id: m[1], rest: m[2], line: i + 1 });
});

const failures = [];
const note = (s) => failures.push(s);

// ── G1: a parse that matched nothing makes everything below vacuous ──────────────────────
const grepCount = lines.filter((l) => /^- ✓ \*\*[A-Z0-9]+-[0-9]+\*\*/.test(l)).length;
if (rows.length === 0) note("G1 no ✓ rows parsed — the row regex matched nothing");
if (rows.length !== grepCount)
  note(`G1 parsed ${rows.length} rows but an independent scan found ${grepCount}`);

// ── G2: two claims must not share a key ──────────────────────────────────────────────────
const seen = new Map();
for (const r of rows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
for (const [id, n] of seen) {
  if (n > 1 && !DUPLICATE_IDS.has(id))
    note(`G2 duplicate id: ${id} appears ${n} times — two claims sharing a key make an audit collapse them`);
}

// ── TOTALITY: every ✓ row is cited, or explicitly allowlisted ────────────────────────────
const cited = new Set();
for (const r of rows) {
  const c = CITE.exec(r.rest);
  if (!c) {
    if (!UNCITED.has(r.id))
      note(
        `UNCITED: ${r.id} claims ✓ but names no test (PROJECT.md:${r.line}). ` +
          `Add: — verified by \`path\` "test name"` +
          (DUPLICATE_IDS.has(r.id)
            ? `\n      ${r.id} IS A PERMANENT DUPLICATE — it has more than one ✓ row, and the ` +
              `UNCITED\n      allowlist is keyed by ID, not by row. So citing ONE row forces its ` +
              `entry to be\n      deleted (G3 calls it stale), and that deletion unmutes EVERY ` +
              `other row sharing the\n      id — which is this one. THERE IS NO PARTIAL STATE ` +
              `THAT PASSES: cite every ${r.id}\n      row in the same change, or cite none.`
            : "")
      );
    continue;
  }
  cited.add(r.id);
  const [, relPath, testName] = c;
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    note(`BROKEN CITATION: ${r.id} cites ${relPath}, which does not exist`);
    continue;
  }
  if (!readFileSync(abs, "utf8").includes(testName))
    note(`BROKEN CITATION: ${r.id} cites ${relPath} but it contains no test named "${testName}"`);
}

// ── G3: anti-rot on the allowlist ────────────────────────────────────────────────────────
// ── RETRACTED TICK: the row's own prose denies its ✓ (#510) ──────────────────────────────
for (const r of rows) {
  if (!RETRACTION.test(r.rest)) continue;
  if (RETRACTED_TICKS.has(r.id)) continue;
  note(
    `RETRACTED TICK: ${r.id} is marked ✓ and its own text retracts it — ` +
      `"${r.rest.trim().slice(0, 90)}". A row that says nothing passes it is not a ✓. ` +
      `Remove the tick, or if the prose is wrong, fix the prose.`
  );
}

const allIds = new Set(rows.map((r) => r.id));
for (const id of DUPLICATE_IDS) {
  if ((seen.get(id) ?? 0) < 2)
    note(`STALE ALLOWLIST: ${id} is no longer duplicated — delete it from DUPLICATE_IDS`);
}
for (const id of RETRACTED_TICKS) {
  const row = rows.find((r) => r.id === id);
  if (!row)
    note(`STALE ALLOWLIST: ${id} is no longer a ✓ row — delete it from RETRACTED_TICKS`);
  else if (!RETRACTION.test(row.rest))
    note(`STALE ALLOWLIST: ${id} no longer retracts itself — delete it from RETRACTED_TICKS`);
}
for (const id of UNCITED) {
  if (!allIds.has(id))
    note(`STALE ALLOWLIST: ${id} is no longer a ✓ row — delete it from UNCITED`);
  else if (cited.has(id))
    note(
      `STALE ALLOWLIST: ${id} now HAS a citation — delete it from UNCITED` +
        (DUPLICATE_IDS.has(id)
          ? `\n      AND CITE ITS OTHER ROW(S) IN THE SAME CHANGE. ${id} is a permanent ` +
            `duplicate:\n      more than one ✓ row, one shared allowlist entry. Deleting the ` +
            `entry unmutes every\n      row sharing the id, so a half-done backfill trades this ` +
            `error for an UNCITED one\n      naming the id you just cited. THERE IS NO PARTIAL ` +
            `STATE THAT PASSES.`
          : "")
    );
}

if (JSON_OUT) {
  console.log(JSON.stringify({ rows: rows.length, cited: [...cited], failures }, null, 2));
} else {
  console.log(
    `PROJECT.md: ${rows.length} ✓ rows · ${seen.size} distinct · ${cited.size} cited · ${UNCITED.size} allowlisted`
  );
  if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  - " + f);
  } else {
    console.log("\nOK — every ✓ row names a test that exists, or carries a live allowlist entry.");
  }
}
process.exit(failures.length ? 1 : 0);
