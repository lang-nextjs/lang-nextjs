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
  "ADAPT-02",
  "ADAPT-03",
  "CI-01",
  "DASH-02",
  "DX-03",
  "E2E-01",
  "E2E-02",
  "E2E-03",
  "E2E-05",
  "PKG-01",
  "PKG-02",
  "RCT-04",
  "SRV-01",
  "SRV-06",
  // DASH-07 — no test drives two concurrent streams through the route handler. DO NOT cite
  // apps/open-swe/app/api/open-swe/runs/[runId]/stream/route.test.ts "stream isolation: runId
  // from params is included in upstream URL" — it is in the right file, has the right name, and
  // asserts URL CONSTRUCTION rather than isolation. It is the first thing a search for this row
  // finds. The client-side half is DASH-05 and is proven; this is the server-side half.
  "DASH-07",
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

/*
 * THERE IS NO ALLOWLIST FOR THIS RULE, AND THAT IS DELIBERATE (#523-adjacent, see below).
 *
 * #510 landed one — RETRACTED_TICKS — holding PKG-03 and PKG-04 while PRODUCT repaired rows
 * this checker could see and I could not fix. That was scaffolding around a known-bad state,
 * and #524 removed the reason for it: a retracted ✓ now MOVES TO THE "### Retired" SECTION as
 * a plain bullet, which the row regex does not match. The repair is one line, available to
 * whoever trips this check, on the day they trip it.
 *
 * AN EXCEPTION LIST WHOSE EVERY EXCEPTION HAS A KNOWN ONE-LINE REPAIR IS A MUTE BUTTON BY
 * CONSTRUCTION — the only thing it can be used for is postponing a fix that takes less time
 * than adding the entry. Unlike UNCITED above, which has 39 members and a real refill cycle,
 * this list reached zero and has no way back: every future member arrives with its own repair
 * already established.
 *
 * If a case ever appears where a row must genuinely stay ✓ while its prose retracts it, the
 * right response is to re-add the list and argue for it, not to have kept an empty one waiting.
 */

const ROW = /^- ✓ \*\*([A-Z0-9]+-[0-9]+)\*\*(.*)$/;
const CITE = /verified by `([^`]+)` "([^"]+)"/;

/*
 * MARKDOWN ESCAPING IS NOT PART OF THE TEST NAME (#544 made this reachable, #555 hit it).
 *
 * The cited name sits in plain double quotes, OUTSIDE a code span, so prettier escapes
 * markdown-significant characters in it: `*` becomes `\*`. The test is named with a bare `*`,
 * so a literal compare reports BROKEN CITATION for a citation that is correct.
 *
 * Measured: prettier rewrites `a * b` to `a \* b` outside a code span and leaves `` `a * b` ``
 * untouched inside one. STR-02 cites "waits initialDelayMs * 2^attempt between retries
 * (exponential backoff)", so this fired the moment the formatting gate landed.
 *
 * The citation and the formatter were each correct and disagreed about the same bytes. The
 * TEST NAME is ground truth; the escape is an artifact of where the name is quoted. Normalised
 * ONCE at extraction rather than at each comparison, because there are now two consumers —
 * the citation check and #586's stubs-its-own-subject rule — and a second one added later
 * would otherwise silently keep the raw form.
 */
const unescapeMd = (s) => s.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1");

const src = readFileSync(PROJECT, "utf8");
const lines = src.split("\n");

/*
 * A ROW CARRIES A MARK, AND THE MARK DECIDES WHICH GUARDS APPLY — NOT WHETHER ANY DO (#606).
 *
 * `ROW` is ✓-only and stays that way for TOTALITY, G1, G3 and the retracted-tick guard: an
 * unticked row is not claiming to be done, so demanding a citation of it would be wrong.
 *
 * But CITATION CORRECTNESS and G2 are not claims about doneness. A citation naming a test that
 * does not exist is wrong at any mark, and two rows sharing an id collapse an audit at any
 * mark. Restricting those to ✓ meant a ⚠ row was exempt from every check in the file — and the
 * only ⚠ row in the tree is ADAPT-05, the one requirement this repo has caught closing on bad
 * evidence. Marking a row ⚠ is the sanctioned response to the retracted-tick guard, so it must
 * not also buy silence from the guards that have nothing to do with the tick.
 */
const MARKED = /^- (✓|⚠) \*\*([A-Z0-9]+-[0-9]+)\*\*(.*)$/;
const allRows = [];
const rows = [];
lines.forEach((line, i) => {
  const m = ROW.exec(line);
  // The 1-indexed line travels with the row so a note about a DUPLICATED id can name the row
  // it means. Reporting only the id is what makes the duplicate interaction below unreadable:
  // the reader has just cited that id and is told it names no test.
  if (m) rows.push({ id: m[1], rest: m[2], line: i + 1, mark: "✓" });
  const a = MARKED.exec(line);
  if (a) allRows.push({ mark: a[1], id: a[2], rest: a[3], line: i + 1 });
});

const failures = [];
const note = (s) => failures.push(s);

// ── G1: a parse that matched nothing makes everything below vacuous ──────────────────────
const grepCount = lines.filter((l) =>
  /^- ✓ \*\*[A-Z0-9]+-[0-9]+\*\*/.test(l)
).length;
if (rows.length === 0)
  note("G1 no ✓ rows parsed — the row regex matched nothing");
if (rows.length !== grepCount)
  note(
    `G1 parsed ${rows.length} rows but an independent scan found ${grepCount}`
  );

// ── G2: two claims must not share a key ──────────────────────────────────────────────────
const seen = new Map();
// Over allRows: an id shared between a ✓ row and a ⚠ row collapses an audit exactly as two
// ✓ rows would, and the mark does not change what a duplicate key costs a reader.
for (const r of allRows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
for (const [id, n] of seen) {
  if (n > 1 && !DUPLICATE_IDS.has(id))
    note(
      `G2 duplicate id: ${id} appears ${n} times — two claims sharing a key make an audit collapse them`
    );
}

// ── TOTALITY: every ✓ row is cited, or explicitly allowlisted ────────────────────────────
const cited = new Set();
for (const r of allRows) {
  const c = CITE.exec(r.rest);
  if (!c) {
    // TOTALITY is the ✓-only half: only a ticked row is claiming to be done.
    if (r.mark === "✓" && !UNCITED.has(r.id))
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
  // `cited` feeds TOTALITY and G3's staleness, both ✓-only, so a ⚠ row's citation is
  // VALIDATED without being counted as satisfying anything.
  if (r.mark === "✓") cited.add(r.id);
  const [, relPath, rawTestName] = c;
  const testName = unescapeMd(rawTestName);
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    note(`BROKEN CITATION: ${r.id} cites ${relPath}, which does not exist`);
    continue;
  }
  const fileSrc = readFileSync(abs, "utf8");
  if (!fileSrc.includes(testName)) {
    note(
      `BROKEN CITATION: ${r.id} cites ${relPath} but it contains no test named "${testName}"`
    );
    continue;
  }
  stubbingItsOwnSubject(r, relPath, testName, fileSrc);
}

/**
 * A CITATION MUST NOT STUB THE THING ITS ROW IS ABOUT (#586).
 *
 * DASH-03 claims `GET /api/open-swe/runs/[runId]/stream` DELIVERS live SSE output, and was
 * cited to an e2e test that `page.route(...)`-fulfils that very path. The route handler never
 * executed; what was proven is that the client renders what a stub sent it. The row is about
 * the producer and the test replaced it.
 *
 * THIS IS NOT A BAN ON route.fulfill. It is right nearly everywhere it appears — 20 uses in
 * open-swe-dashboard.spec.ts alone, almost all stubbing someone ELSE'S dependency, which is
 * what a stub is for. It is wrong in exactly one case: when the thing stubbed IS THE SUBJECT
 * OF THE CLAIM. A blanket rule would be noise; this one is narrow enough to be true.
 *
 * The repo had already written the diagnosis down. When E2E-11 was rewritten (#501): "the
 * ORIGINAL test claimed to exercise the SSE resume path but FULFILLED TWO COMPLETE RESPONSES
 * VIA route.fulfill — which cannot hold a stream open mid-way, so the 'interruption' was
 * fiction." That fix went to the instance. The same instrument stayed cited one row over,
 * which is what a rule costs when it lives in a PR body instead of a checker.
 *
 * SCOPE, STATED SO IT IS NOT MISTAKEN FOR MORE: it fires only for rows whose criterion names
 * a literal `/api/...` path, which is three rows today. It says nothing about rows that
 * describe behaviour without naming an endpoint — those need a human reading, which is what
 * #586 was.
 */
function stubbingItsOwnSubject(r, relPath, testName, fileSrc) {
  // The endpoint the ROW names, if it names one at all.
  const ep = /`(?:GET|POST|PUT|PATCH|DELETE)?\s*(\/api\/[^`]+)`/.exec(r.rest);
  if (!ep) return;

  /*
   * Compared by LITERAL SEGMENTS, because the row spells a dynamic segment `[runId]` and a
   * test spells it `${runId}`. Requiring both spellings to match would make the rule fire on
   * nothing; requiring the literal parts IN ORDER matches the same route however it is
   * written, and does not match a different endpoint that merely shares a prefix.
   */
  const segments = ep[1].split(/\[[^\]]+\]/).filter((x) => x.length > 1);
  if (segments.length === 0) return;

  /*
   * Only the CITED test's own body. Scoped to the next test declaration, because a file may
   * legitimately stub this endpoint in a different case — the claim is about the test the row
   * points at, not about the file it lives in.
   */
  const start = fileSrc.indexOf(testName);
  const rest = fileSrc.slice(start);
  const nextTest = rest.slice(1).search(/\n\s*(?:it|test)\s*\(/);
  const body = nextTest === -1 ? rest : rest.slice(0, nextTest + 1);

  for (const m of body.matchAll(/\.route\(\s*([`'"])([^`'"]+)\1/g)) {
    const glob = m[2];
    if (segments.every((seg) => glob.includes(seg)))
      note(
        `CITATION STUBS ITS OWN SUBJECT: ${r.id} names ${ep[1]} and its cited test ` +
          `"${testName}" intercepts it (${relPath} :: .route("${glob}")).\n` +
          `      The handler under test never runs, so the test proves the CONSUMER renders ` +
          `what a stub sent it.\n` +
          `      Cite a test that lets the real route execute and asserts its RESPONSE — see ` +
          `#586, and E2E-11's rewrite in #501 for the shape.`
      );
  }
}

// ── G3: anti-rot on the allowlist ────────────────────────────────────────────────────────
// ── RETRACTED TICK: the row's own prose denies its ✓ (#510) ──────────────────────────────
for (const r of rows) {
  if (!RETRACTION.test(r.rest)) continue;
  note(
    `RETRACTED TICK: ${r.id} is marked ✓ and its own text retracts it — ` +
      `"${r.rest
        .trim()
        .slice(0, 90)}". A row that says nothing passes it is not a ✓. ` +
      `Remove the tick, or if the prose is wrong, fix the prose.`
  );
}

const allIds = new Set(rows.map((r) => r.id));
for (const id of DUPLICATE_IDS) {
  if ((seen.get(id) ?? 0) < 2)
    note(
      `STALE ALLOWLIST: ${id} is no longer duplicated — delete it from DUPLICATE_IDS`
    );
}
for (const id of UNCITED) {
  if (!allIds.has(id))
    note(
      `STALE ALLOWLIST: ${id} is no longer a ✓ row — delete it from UNCITED`
    );
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
  console.log(
    JSON.stringify({ rows: rows.length, cited: [...cited], failures }, null, 2)
  );
} else {
  console.log(
    `PROJECT.md: ${rows.length} ✓ rows · ${
      allRows.length - rows.length
    } ⚠ row(s), citations validated · ` +
      `${seen.size} distinct · ${cited.size} cited · ${UNCITED.size} allowlisted`
  );
  if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  - " + f);
  } else {
    console.log(
      "\nOK — every ✓ row names a test that exists, or carries a live allowlist entry."
    );
  }
}
process.exit(failures.length ? 1 : 0);
