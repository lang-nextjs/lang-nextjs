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
  "ADAPT-01","ADAPT-02","ADAPT-03","ADAPT-04","ADAPT-05","AUTH-01","CI-01","DASH-01",
  "DASH-02","DASH-03","DASH-04","DASH-05","DX-01","DX-02","DX-03","E2E-01","E2E-02",
  "E2E-03","E2E-04","E2E-05","E2E-11","EX-01","FWK-01","FWK-02","MCP-01","MCP-02",
  "MCP-03","MCP-04","PKG-01","PKG-02","PKG-03","PKG-04","RCT-01","RCT-02","RCT-03",
  "RCT-04","SRV-01","SRV-02","SRV-03","SRV-04","SRV-05","SRV-06","STR-02",
]);


/**
 * Ids carried by MORE THAN ONE ✓ row today.
 *
 * Two claims sharing a key is a real defect — an audit keyed on ids silently collapses them —
 * and this check refuses it by default. These two predate the check: v1.2 and v1.5 each
 * assigned ADAPT-03/ADAPT-04 to different requirements, in the same file.
 *
 * NOT fixed here, deliberately. Renumbering the later pair would repair PROJECT.md and
 * silently redirect every archival reference to the EARLIER requirement — the same
 * "changes referent" cost that #207 ruled against, and a vocabulary decision of exactly the
 * kind that should be ruled rather than improvised by whoever happens to be in the file.
 *
 * Carries the same delete-me property as UNCITED: an entry that stops being a duplicate is
 * reported as stale.
 */
const DUPLICATE_IDS = new Set(["ADAPT-03", "ADAPT-04"]);

const ROW = /^- ✓ \*\*([A-Z0-9]+-[0-9]+)\*\*(.*)$/;
const CITE = /verified by `([^`]+)` "([^"]+)"/;

const src = readFileSync(PROJECT, "utf8");
const lines = src.split("\n");

const rows = [];
for (const line of lines) {
  const m = ROW.exec(line);
  if (m) rows.push({ id: m[1], rest: m[2] });
}

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
      note(`UNCITED: ${r.id} claims ✓ but names no test. Add: — verified by \`path\` "test name"`);
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
const allIds = new Set(rows.map((r) => r.id));
for (const id of DUPLICATE_IDS) {
  if ((seen.get(id) ?? 0) < 2)
    note(`STALE ALLOWLIST: ${id} is no longer duplicated — delete it from DUPLICATE_IDS`);
}
for (const id of UNCITED) {
  if (!allIds.has(id))
    note(`STALE ALLOWLIST: ${id} is no longer a ✓ row — delete it from UNCITED`);
  else if (cited.has(id))
    note(`STALE ALLOWLIST: ${id} now HAS a citation — delete it from UNCITED`);
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
