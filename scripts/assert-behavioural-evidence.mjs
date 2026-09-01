#!/usr/bin/env node
/**
 * Property: A BEHAVIOURAL REQUIREMENT IS NOT SATISFIED BY EVIDENCE THAT ONLY DESCRIBES SURFACE.
 *
 * `ADAPT-05` says "the run pauses until an explicit approval or rejection". It is marked
 * SATISFIED in four places. The run does not pause. What satisfied it was:
 *
 *     Server package exports `createApprovalGatingTransform`, `createApprovalRoutes`,
 *     `ApprovalGatingConfig`. Handler option available. All 234 server tests pass
 *
 * A BEHAVIOURAL CRITERION CLOSED BY AN EXISTENCE CHECK -- and it survived audit because every
 * clause of that evidence is TRUE. None of it is a claim about pausing. Second instance:
 * v1.3's reconnect row, satisfied by the single word `✓ EXPORTED` (#450, #453).
 *
 * ── THE RULE, WHICH THIS REPO HAD ALREADY WRITTEN IN ONE FILE ────────────────────────────
 *
 * From apps/fastapi-backend/tests/test_approval_withholds.py: "The whole question is one
 * observable: DID THE SIDE EFFECT HAPPEN. Not 'was a frame emitted' -- those are reports, and
 * a report is the thing that was already wrong."
 *
 *     A behavioural requirement is satisfied only by evidence naming three things: the
 *     OBSERVABLE the criterion is about, the VALUE it took, and the CONTROL showing the
 *     harness could have observed the other value.
 *
 * The control clause is not ceremony, and that file argues it better than any abstraction:
 * "0 effects is equally consistent with a harness that never ran the agent at all, and a
 * suite that cannot tell those apart reports the same green for both."
 *
 * ── WHAT THIS CHECKER CAN ACTUALLY DECIDE, WHICH IS LESS ──────────────────────────────────
 *
 * It cannot read for an observable, a value and a control -- that is a human reading. It
 * implements the MECHANICAL HALF, which catches both known instances with no NLP: reject an
 * evidence field whose substantive content is EXCLUSIVELY
 *
 *     1. symbols exported by a package barrel     (string membership against index.ts)
 *     2. test counts                              ("234 tests pass")
 *     3. build/surface verbs                      (exports, available, wired, builds, passes)
 *
 * ADAPT-05's evidence is categories 1, 3, 2 and nothing else. `✓ EXPORTED` is category 3
 * alone.
 *
 * ── THE TRIGGER IS THE SAME CLASSIFIER, POINTED AT THE CRITERION ──────────────────────────
 *
 * "The package exports X" is LEGITIMATELY satisfied by "X is exported", and a rule that fired
 * there would be red on every surface requirement and muted within a week. So the criterion
 * decides WHETHER the standard applies; it does not decide whether the evidence meets it.
 *
 * That trigger runs the same three categories over the CRITERION: if the criterion itself is
 * exclusively surface, the standard does not apply. This is deliberate -- a verb list would
 * be a second thing to keep current, and would go stale silently the first time someone wrote
 * a behavioural criterion with a verb nobody listed.
 *
 * ── WHAT IT CANNOT DO, STATED HERE SO NOBODY EXPECTS IT ───────────────────────────────────
 *
 * THE RULE MAKES EVIDENCE MEASURABLE. IT DOES NOT MAKE IT CORRECT. Someone can name "did a
 * `data-approval-required` frame appear" as the observable, give it a value and a control, and
 * pass -- while still not measuring execution. That near-miss is the MORE dangerous version of
 * ADAPT-05, not a weaker one, and this checker admits it.
 *
 * Choosing the right observable is a human reading, and that is the step that failed in v1.5.
 *
 * ── MEASURED COVERAGE OF THE TWO KNOWN INSTANCES, INCLUDING THE ONE IT MISSES ─────────────
 *
 * #453 says both known instances are caught. ONE IS. Measured, not assumed:
 *
 *   ADAPT-05, both copies of v1.5-02-VERIFICATION.md   REJECTED.
 *
 *   v1.3-MILESTONE-AUDIT.md:77 -- `✓ EXPORTED`         NOT REACHED, and it is not a parser
 *                                                      gap that can be closed by widening.
 *
 * That row lives in a "Cross-Phase Wiring" table with no requirement id, and as a WIRING claim
 * it is CORRECT: `server/index.ts → reconnect.ts` genuinely does export those symbols. The
 * defect was a human treating that row as closing the reconnect requirement -- a linkage that
 * exists in nobody's table, so no row-level rule can see it.
 *
 * Extending the parser to tables without a requirement id was tried and reverted: it produced
 * 45 rejects, almost all coverage tables, route lists and test-file inventories, and STILL
 * missed line 77. A rule that fires on those would be red everywhere and muted within a week,
 * which costs more than the row it was reaching for.
 *
 * AND THE REQUIREMENT BEHIND IT IS A MISS TOO, WHICH IS WORTH KNOWING. `STR-01` is evaluated
 * where its evidence actually lives -- v1.3-03-VERIFICATION.md:73 -- and this rule ACCEPTS
 * "All artifacts implemented, tests pass, feature flag guard confirmed". The first two clauses
 * are categories 3 and 2; the third names a GUARD rather than an observable, and "guard" is
 * not a barrel symbol or a surface verb, so the evidence is not EXCLUSIVELY surface and the
 * rule lets it through. It is the near-miss above, in the wild.
 *
 * So the honest coverage claim is: one of the two motivating instances, plus the shape of the
 * other. Stated here because a check that oversells itself is the defect this whole line of
 * work keeps finding.
 * The honest claim is narrow: IT MAKES "THE EXPORTS EXIST" UN-WRITABLE AS EVIDENCE FOR A
 * BEHAVIOURAL REQUIREMENT. Worth having, less than a guarantee. A check that oversold its own
 * coverage would be the same defect one level out.
 *
 * Usage: node scripts/assert-behavioural-evidence.mjs [--cwd DIR] [--list]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
const cwdFlag = process.argv.indexOf("--cwd");
const ROOT =
  cwdFlag !== -1 && process.argv[cwdFlag + 1]
    ? resolve(process.argv[cwdFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/* CATEGORY 3. The issue names these five; the morphological variants are the same claim. */
const SURFACE_VERBS = [
  "export",
  "exports",
  "exported",
  "exporting",
  "available",
  "availability",
  "wired",
  "wiring",
  "wire",
  "build",
  "builds",
  "built",
  "pass",
  "passes",
  "passed",
  "passing",
  "defined",
  "declared",
  "present",
  "documented",
  "documents",
  "implemented",
  "implementation",
  "executed",
  "complete",
  "created",
];

/* CATEGORY 1. Every identifier a package barrel exports. */
export function barrelSymbols(root) {
  const symbols = new Set();
  const pkgDir = join(root, "packages");
  if (!existsSync(pkgDir)) return symbols;
  for (const name of readdirSync(pkgDir)) {
    const idx = join(pkgDir, name, "src", "index.ts");
    if (!existsSync(idx)) continue;
    const src = readFileSync(idx, "utf8");
    for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const id = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (id && /^[A-Za-z_$][\w$]*$/.test(id)) symbols.add(id);
      }
    }
    for (const m of src.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
    )) {
      symbols.add(m[1]);
    }
  }
  return symbols;
}

/** Split a cell into claims. `.` inside `v1.5-02` is not a sentence end. */
export function splitClaims(text) {
  return text
    .split(/\.\s+|\.$|;\s+|\n|(?:^|\s)[-•]\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Is this claim EXCLUSIVELY surface?
 *
 * Category 2 is deliberately narrow: a bare number is not a test count. "the counter went
 * 0 -> 1" is a VALUE, which is exactly what the rule wants evidence to carry.
 */
export function isSurfaceClaim(claim, barrel) {
  const words = claim.match(/[A-Za-z_$][\w$]*/g) ?? [];
  if (words.length === 0) return true; // punctuation / a bare tick

  const isTestCount =
    /\b\d+\s*(?:\/\s*\d+)?\s+\w*\s*tests?\b/i.test(claim) ||
    /\btests?\s+(?:pass|passed|passes|passing)\b/i.test(claim);

  let sawSubstantive = false;
  for (const w of words) {
    if (barrel.has(w)) continue; // 1
    if (SURFACE_VERBS.includes(w.toLowerCase())) continue; // 3
    if (
      isTestCount &&
      /^(tests?|all|total|unit|server|e2e|suite|failures?|0)$/i.test(w)
    )
      continue; // 2
    if (STOPWORDS.has(w.toLowerCase())) continue;
    if (/^v\d/i.test(w)) continue; // plan ids: v1.5-02-01
    /*
     * A LOCATION IS NOT AN OBSERVABLE. "L23", "line 31", "lines 32-33" name WHERE code sits,
     * not WHAT was observed taking WHICH value. Without this, the v1.3 shape --
     * "L23 exports createDeepAgentsResumeHandler + isStreamReconnectEnabled" -- passes on the
     * strength of the token `L23` alone, every other word in it being a barrel symbol or a
     * surface verb. A pointer to the code is the definition of surface evidence.
     */
    if (/^L\d+$/i.test(w) || /^lines?$/i.test(w)) continue;
    if (/^[A-Z]{2,}$/.test(w) && /^(RED|GREEN|TODO|API|SSE|CI|E2E)$/.test(w))
      continue;
    sawSubstantive = true;
    break;
  }
  return !sawSubstantive;
}

const STOPWORDS = new Set(
  (
    "a an the and or of to in on at by for with from as is are was were be been being this that " +
    "these those all three two one both each every no not its it their there here now then " +
    "package server client handler option options route routes factory line lines file files " +
    "plan plans phase phases source src ts tsx py md statement statements import imports " +
    "public api surface full new via see per plus"
  ).split(" ")
);

/** Requirement rows from every markdown table in .planning, closed milestones included. */
export function parseRows(root) {
  const rows = [];
  const base = join(root, ".planning");
  if (!existsSync(base)) return rows;
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) files.push(p);
    }
  })(base);

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let cols = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim().startsWith("|")) {
        cols = null;
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const lower = cells.map((c) => c.toLowerCase().replace(/[`*]/g, ""));
      /*
       * HEADER SPELLINGS VARY ACROSS MILESTONES, and a parser that knows only the newest one
       * reports a clean green over the older tables -- which is where both known instances
       * live. v1.3 writes `REQ` and `Final Status`; v1.5 writes `Requirement` and `Status`.
       * Missing that cost an entire audit table, silently, until the row counts were read.
       */
      if (/^(requirements?|req-?id|req|id)$/.test(lower[0] ?? "")) {
        const exact = lower.findIndex((c) => /^status$/.test(c));
        cols = {
          desc: lower.findIndex((c) =>
            /^(description|criterion|acceptance)/.test(c)
          ),
          status:
            exact >= 0
              ? exact
              : lower.map((c) => /status/.test(c)).lastIndexOf(true),
          evidence: lower.findIndex((c) => /^(evidence|proof)/.test(c)),
        };
        continue;
      }
      if (!cols || /^[-: ]+$/.test(cells[0] ?? "")) continue;
      const id = (cells[0] ?? "").replace(/[`*]/g, "").trim();
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) continue;
      rows.push({
        file: relative(root, file),
        line: i + 1,
        id,
        description: cols.desc >= 0 ? cells[cols.desc] ?? "" : "",
        status: cols.status >= 0 ? cells[cols.status] ?? "" : "",
        evidence: cols.evidence >= 0 ? cells[cols.evidence] ?? "" : null,
      });
    }
  }
  return rows;
}

const SATISFIED = /✓|✅|satisfied|complete|passed|\[x\]/i;

export function evaluate(root = ROOT) {
  const barrel = barrelSymbols(root);
  const rows = parseRows(root);
  const surfaceOnly = (text) =>
    splitClaims(text).every((c) => isSurfaceClaim(c, barrel));

  const results = [];
  for (const r of rows) {
    if (!SATISFIED.test(r.status)) {
      results.push({ ...r, verdict: "not-claimed" });
      continue;
    }
    if (!r.description || surfaceOnly(r.description)) {
      // The criterion is itself about surface -- "the package exports X" is legitimately
      // satisfied by "X is exported". The standard does not apply.
      results.push({ ...r, verdict: "surface-criterion" });
      continue;
    }
    if (r.evidence === null) {
      results.push({ ...r, verdict: "no-evidence-column" });
      continue;
    }
    if (r.evidence.trim() === "") {
      results.push({ ...r, verdict: "empty-evidence" });
      continue;
    }
    results.push({
      ...r,
      verdict: surfaceOnly(r.evidence) ? "REJECT" : "accept",
    });
  }
  return { results, barrelCount: barrel.size };
}

/**
 * Rows already known to fail, each owned by an issue.
 *
 * A BASELINE, NOT AN ALLOWLIST, and the difference is that it must SHRINK: an entry whose row
 * now passes is itself a failure ("stale baseline entry"), so it cannot quietly outlive the
 * defect it records. Without this the check could not be wired into CI at all while the two
 * known instances stand -- and an unwired checker is inert, which is the failure mode where a
 * rule exists on disk and guards nothing.
 */
const BASELINE_PATH = "scripts/behavioural-evidence-baseline.json";

function loadBaseline(root) {
  const p = join(root, BASELINE_PATH);
  if (!existsSync(p)) return { known: [], positiveControls: [] };
  return JSON.parse(readFileSync(p, "utf8"));
}

const key = (r) => `${r.file}:${r.id}`;

function main() {
  const list = process.argv.includes("--list");
  const { results, barrelCount } = evaluate(ROOT);
  const baseline = loadBaseline(ROOT);
  const knownKeys = new Set(baseline.known.map((k) => k.row));

  const considered = results.filter((r) => r.verdict !== "not-claimed");
  const rejects = results.filter((r) => r.verdict === "REJECT");
  const accepts = results.filter((r) => r.verdict === "accept");
  const files = new Set(results.map((r) => r.file));

  if (list) {
    for (const r of results)
      console.log(`${r.verdict.padEnd(18)} ${r.file}:${r.line} ${r.id}`);
  }

  /*
   * VACUITY. "every behavioural row carries real evidence" and "I parsed no rows" print the
   * same green, and the second is what happens the day the tables are reformatted. Nothing
   * examined is not nothing wrong.
   */
  if (results.length === 0 || considered.length === 0) {
    console.error(
      `FAIL: parsed ${results.length} requirement row(s) from .planning, ${considered.length} ` +
        `claiming satisfaction.\n      This checker is about those rows, so an empty set means ` +
        `it COULD NOT COMPUTE the\n      property -- not that the property holds.`
    );
    process.exit(2);
  }

  const problems = [];

  /*
   * PROPERTY 2: THE POSITIVE CONTROL SET. Rows that DO carry behavioural evidence and must
   * keep accepting. Without them a checker that mis-parses the tables -- or classifies
   * everything as surface -- passes every row it was pointed at and its green means nothing.
   */
  const byKey = new Map(results.map((r) => [key(r), r]));
  for (const pc of baseline.positiveControls ?? []) {
    const row = byKey.get(pc.row);
    if (!row) {
      problems.push(
        `positive control ${pc.row} was NOT PARSED at all. The tables changed shape or the ` +
          `parser broke; every verdict below is over an unknown subject.`
      );
    } else if (row.verdict !== "accept") {
      problems.push(
        `positive control ${pc.row} now reports "${row.verdict}", expected "accept". ` +
          `${pc.why} A classifier that rejects real behavioural evidence would push people ` +
          `toward vocabulary rather than measurement.`
      );
    }
  }

  /* A baseline entry that now passes must be REMOVED, or the record outlives the defect. */
  const rejectKeys = new Set(rejects.map(key));
  for (const k of baseline.known) {
    if (!rejectKeys.has(k.row)) {
      problems.push(
        `stale baseline entry ${k.row}: it no longer fails, so delete it from ` +
          `${BASELINE_PATH}. A baseline that only grows is an allowlist.`
      );
    }
  }

  const newRejects = rejects.filter((r) => !knownKeys.has(key(r)));
  for (const r of newRejects) {
    problems.push(
      `${r.file}:${r.line} ${r.id} is a BEHAVIOURAL requirement marked satisfied, but its ` +
        `evidence is exclusively barrel exports, test counts and surface verbs:\n` +
        `        criterion: ${r.description.slice(0, 150)}\n` +
        `        evidence:  ${r.evidence.slice(0, 150)}\n` +
        `        Name the OBSERVABLE, the VALUE it took, and the CONTROL showing the harness ` +
        `could have seen the other value.`
    );
  }

  // NAME THE SUBJECT. A verdict that does not say what it examined cannot be distinguished
  // from one that examined nothing, and fools each reader once.
  console.log(
    `examined ${considered.length} requirement row(s) claiming satisfaction, across ` +
      `${files.size} file(s) in .planning\n` +
      `  ${accepts.length} accept   ${rejects.length} reject ` +
      `(${baseline.known.length} known, ${newRejects.length} new)   ` +
      `${
        results.filter((r) => r.verdict === "surface-criterion").length
      } surface criteria ` +
      `(standard does not apply)\n` +
      `  ${
        results.filter((r) => r.verdict === "no-evidence-column").length
      } row(s) in tables ` +
      `with no evidence column, ${
        results.filter((r) => r.verdict === "empty-evidence").length
      } ` +
      `with an empty one\n` +
      `  ${barrelCount} barrel symbol(s) read from packages/*/src/index.ts`
  );

  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    process.exit(1);
  }
  console.log(
    `\nPASS: no behavioural requirement is satisfied by surface evidence alone, beyond the ` +
      `${baseline.known.length} recorded in\n      ${BASELINE_PATH}. This makes "the exports ` +
      `exist" un-writable as evidence; it does NOT\n      check that the observable named is ` +
      `the right one -- that remains a human reading.`
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
