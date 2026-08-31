#!/usr/bin/env node
/**
 * EVERY MANIFEST DISCRIMINANT HAS A COVERAGE DECISION, AND THE DECISIONS ARE
 * VISIBLE (#425).
 *
 * `shape` is exhaustive at the type level and unguarded at every consumer: a
 * third value would be treated as a run by the sidebar (`!== "conversation"`)
 * and as neither by the framework selector (`=== "conversation"`), silently and
 * in opposite directions at once. The compile-time guards that exist —
 * `assertNever` in the rungs test, the derived `RungShape` union — catch "a
 * value the TYPE does not know". They cannot catch "a value a CALL SITE does not
 * handle", because an `if/else` over a wider union still typechecks.
 *
 * WHY THIS IS NOT A `shape` CHECKER, WHICH WAS THE RISK WORTH DESIGNING AGAINST.
 *
 * `shape` is not the problem; it is one member of a family. `state` has the same
 * structure today and #451 adds `reach` this week. A guard shaped around `shape`
 * specifically would make the NEXT discriminant's arrival HARDER to notice, not
 * easier — because the manifest would then look like it has discriminant
 * coverage, and the fourth field would inherit that appearance without ever
 * being examined. That is the same defect this repository keeps finding, applied
 * to its own remedy.
 *
 * So this file answers the question for ANY per-rung discriminant, and derives
 * the list rather than restating it.
 *
 * HOW THE FAMILY IS DERIVED, and why not from `rungs.json`. The manifest already
 * declares its two enumerations two different ways — `shapes` is an ARRAY and
 * `states` is an OBJECT keyed by value — so a rule written against the manifest
 * would have to guess which style a third discriminant uses, and would silently
 * miss it on a wrong guess. `packages/rungs/src/generated.ts` normalises both:
 * a discriminant is a field on `interface Rung` whose type is a string-literal
 * union declared in the same file. However #451 declares `reach`, it arrives
 * here in that one shape.
 *
 * WHAT IT ENFORCES. Every derived discriminant must appear in COVERAGE below,
 * either with a witness that proves a new value fails loudly, or with a written
 * reason it is not covered. An unlisted discriminant FAILS. That is the whole
 * point: a fourth field either gets covered or visibly does not, and nobody has
 * to remember to come here.
 *
 * IT DOES NOT CLAIM THE CONSUMERS ARE SAFE. Today no discriminant has a witness,
 * and the report says so on every run. This is a census that cannot go quiet,
 * not a proof that the hazard is closed.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const GENERATED = "packages/rungs/src/generated.ts";
const CONSUMER_ROOTS = ["apps", "packages"];

/**
 * The coverage decision for each discriminant. One entry per derived field, or
 * this file fails — which is the mechanism, not a formality.
 *
 * `witness` names a test that adds a value the union does not have and watches
 * every consumer reject it. `uncovered` records why there is not one yet, in
 * enough detail that the next reader can act on it rather than re-measure it.
 */
const COVERAGE = {
  shape: {
    /*
     * COVERED. Every consumer that branches on `shape` now dispatches through
     * `byShape` over a `Record<RungShape, T>`, which is total by construction: a
     * third value is a tsc error at each call site and a runtime throw if it
     * arrives as manifest data.
     *
     * The witness proves BOTH halves that matter at runtime — that a third shape
     * is refused, and that `conversation` and `run` keep their exact current
     * treatment. The second is the one that could regress, because this was a
     * refactor of live navigation.
     */
    witness: "apps/open-swe/lib/shape-exhaustive-dispatch.test.ts",
  },
  reach: {
    /*
     * UNCOVERED, AND THIS ENTRY IS THE CHECK EARNING ITS KEEP. `reach` did not
     * exist when this file was written — #424 added it to the manifest, the
     * generated types and the schema — and it arrived here as an UNDECIDED
     * discriminant on main without anyone thinking to look, which is precisely
     * the case the derivation exists for.
     *
     * NOT a witness, and the distinction matters. `reach` has live consumers and
     * they are tested — nav.ts's `rungNote` branches on it and `nav.test.ts`
     * drives both declared values. That is coverage of the values that EXIST; a
     * witness is a proof that a value that does NOT exist yet fails loudly, and
     * nothing here provides one.
     *
     * Measured, both consumers positive-match:
     *
     *   dashboard/page.tsx:54  filter(r => r.reach === "referenced").length
     *                          feeds the "Reachable" tile — a third value is
     *                          excluded from the count, so the tile silently
     *                          under-reports rather than erroring.
     *   nav.ts:65              if (rung.reach === "vendored")
     *                          a third value falls through to the branches
     *                          below and takes whichever note they give it.
     *
     * So a third `reach` is DROPPED at both sites — uniform, unlike `shape`,
     * which absorbed at one consumer and excluded at another. Uniform is not
     * safe; it is merely easier to reason about, and a count that quietly stops
     * summing is the same defect the `shape` footnote had.
     *
     * The fix is the same shape as `shape`'s: exhaustive dispatch over a
     * `Record<RungReach, T>`, plus a witness. Not bundled here for the reason
     * the census/hardening split already established — this file records gaps,
     * it does not close them.
     */
    uncovered:
      "Arrived with #424 after this check was written, and caught by it. Two " +
      "consumers, both positive matches, so a third value is dropped at both: " +
      "the dashboard's Reachable tile under-counts and nav.ts falls through to " +
      "another branch. Live consumers are tested for the values that exist, " +
      "which is not a witness for one that does not.",
  },
  state: {
    uncovered:
      "Same structure as `shape` and not separately measured. Listed rather than " +
      "omitted precisely because an unexamined discriminant that nobody wrote " +
      "down is indistinguishable from a covered one.",
  },
  id: {
    uncovered:
      "IDENTITY RATHER THAN BEHAVIOUR, and the distinction is the argument. A " +
      'consumer keying on `id === "open-swe"` is naming ONE rung on purpose; a ' +
      "new rung falling through that is usually correct, because the branch was " +
      "about that rung and not about a category. `shape` and `state` are " +
      "categories, where falling through is a mis-bucketing. Kept in the report " +
      "rather than filtered out of it: it is derived the same way and the reason " +
      "it differs should be readable, not assumed.",
  },
};

/** Every `export type X = "a" | "b"` in the generated file. */
function literalUnions(src) {
  const out = {};
  const re = /export type (\w+) =\s*([^;]+);/g;
  for (const m of src.matchAll(re)) {
    const members = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    // Two or more members, and nothing in the body that is not a quoted literal
    // or a union bar — a discriminated object union (RungTarget) is not this.
    const bodyIsLiteralsOnly = !/[{}]/.test(m[2]);
    if (members.length >= 2 && bodyIsLiteralsOnly) out[m[1]] = members;
  }
  return out;
}

/** Fields on `interface Rung` whose type is one of those unions. */
function discriminantsOf(src, unions) {
  const iface = src.match(/export interface Rung \{([\s\S]*?)\n\}/);
  if (!iface) return null;
  const found = {};
  for (const m of iface[1].matchAll(/readonly (\w+)\??:\s*(\w+);/g)) {
    if (unions[m[2]]) found[m[1]] = { type: m[2], values: unions[m[2]] };
  }
  return found;
}

function sourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, acc);
    else if ([".ts", ".tsx"].includes(extname(p)) && !/\.test\.tsx?$/.test(p))
      acc.push(p);
  }
  return acc;
}

/**
 * Comparison sites against a discriminant's literal values, by direction.
 *
 * TEXTUAL, AND THEREFORE AN UPPER BOUND. It matches `=== "conversation"` without
 * knowing that the left-hand side is a `shape` — an unrelated field compared to
 * the same string counts here. The counts are evidence that consumers exist and
 * roughly where, NOT a precise inventory, and no decision in this file turns on
 * an exact number.
 *
 * The direction that would matter is the other one: a site this MISSES would be
 * an unexamined consumer counted as absent. Known misses are a value built by
 * interpolation, held in a variable, or compared with `==`. That is why a zero
 * count is treated as a failure rather than as good news — for this scanner,
 * finding nothing is more likely to mean it broke than that nothing is there.
 */
function sitesFor(values, files, read = (f) => readFileSync(f, "utf8")) {
  const sites = [];
  for (const file of files) {
    if (file.endsWith(GENERATED)) continue;
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      for (const v of values) {
        const q = `"${v}"`;
        if (!line.includes(q)) continue;
        let direction = null;
        if (line.includes(`!== ${q}`)) direction = "negative";
        else if (line.includes(`=== ${q}`)) direction = "positive";
        else if (new RegExp(`case\\s+${q}`).test(line)) direction = "case";
        if (direction) sites.push({ file, line: i + 1, value: v, direction });
      }
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------

/**
 * The whole audit as a pure function of its inputs, so the selftest can drive
 * every outcome — including the ones unreachable by editing the real tree
 * without turning CI red, which are the ones worth proving.
 */
export function audit({ generatedSrc, files, coverage, read }) {
  const unions = literalUnions(generatedSrc);
  const discriminants = discriminantsOf(generatedSrc, unions);

  if (discriminants === null) {
    return {
      fatal:
        "no `export interface Rung` in the generated types. The derivation has " +
        "lost its subject; every check below would iterate an empty set and pass " +
        "having examined nothing.",
    };
  }
  const names = Object.keys(discriminants);
  if (names.length === 0) {
    return {
      fatal:
        "derived 0 discriminants. A check with no subject is vacuous, and its " +
        "green reads as coverage.",
    };
  }

  const failures = [];
  const rows = [];
  let totalSites = 0;

  for (const name of names) {
    const { type, values } = discriminants[name];
    const sites = sitesFor(values, files, read);
    totalSites += sites.length;
    const decision = coverage[name];

    if (!decision) {
      failures.push(
        `\`${name}\` (${type}: ${values
          .map((v) => `"${v}"`)
          .join(" | ")}) is a ` +
          `manifest discriminant with NO coverage decision. It is read at ` +
          `${sites.length} comparison site(s). Add an entry to COVERAGE in ` +
          `scripts/check-discriminant-guards.mjs: a \`witness\` naming a test that ` +
          `proves a new value fails loudly at every consumer, or an \`uncovered\` ` +
          `reason. This check exists so a new discriminant cannot inherit the ` +
          `appearance of coverage from the ones already here.`
      );
      rows.push({ name, type, values, sites, status: "UNDECIDED" });
      continue;
    }

    if (decision.witness) {
      if (!existsSync(decision.witness)) {
        failures.push(
          `\`${name}\` names a witness that does not exist: ${decision.witness}. ` +
            `A coverage claim pointing at nothing is worse than an admitted gap.`
        );
        rows.push({ name, type, values, sites, status: "BROKEN WITNESS" });
        continue;
      }
      rows.push({ name, type, values, sites, status: "witness" });
      continue;
    }

    if (sites.length === 0) {
      failures.push(
        `\`${name}\` is recorded as uncovered, but 0 comparison sites were found ` +
          `for any of its values. Either the consumers are gone — in which case ` +
          `the recorded reason is stale — or this scanner no longer matches how ` +
          `they are written, in which case every count in this report is too low.`
      );
    }
    rows.push({ name, type, values, sites, status: "UNCOVERED" });
  }

  if (totalSites === 0) {
    return {
      fatal:
        `found 0 comparison sites across all ${names.length} discriminant(s), ` +
        `having scanned ${files.length} files. A census that counts nothing is ` +
        `not evidence that nothing is there.`,
    };
  }
  return { rows, failures, totalSites, names };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(GENERATED)) {
    console.error(`FAIL: ${GENERATED} is missing — nothing to derive from.`);
    process.exit(2);
  }
  const files = CONSUMER_ROOTS.filter(existsSync).flatMap((d) =>
    sourceFiles(d)
  );
  const result = audit({
    generatedSrc: readFileSync(GENERATED, "utf8"),
    files,
    coverage: COVERAGE,
    read: (f) => readFileSync(f, "utf8"),
  });

  if (result.fatal) {
    console.error(`REFUSING TO PASS: ${result.fatal}`);
    process.exit(2);
  }

  // THE REPORT NAMES WHAT IT EXAMINED. A check that does not say what it looked
  // at convinces each reader once, and this one's whole purpose is to be read.
  console.log(
    `Manifest discriminants derived from ${GENERATED} (${files.length} consumer files scanned):\n`
  );
  for (const r of result.rows) {
    const byDir = r.sites.reduce((acc, s) => {
      acc[s.direction] = (acc[s.direction] ?? 0) + 1;
      return acc;
    }, {});
    const dirs =
      Object.entries(byDir)
        .map(([d, n]) => `${n} ${d}`)
        .join(", ") || "no comparison sites";
    console.log(
      `  ${r.status === "witness" ? "\u2713" : "!"} ${r.name} (${r.type})`
    );
    console.log(`      values : ${r.values.map((v) => `"${v}"`).join(" | ")}`);
    console.log(`      sites  : ${r.sites.length} (${dirs})`);
    console.log(`      status : ${r.status}`);
    const where = [...new Set(r.sites.map((s) => s.file))];
    if (where.length) console.log(`      in     : ${where.join(", ")}`);
    console.log("");
  }

  if (result.failures.length) {
    console.error(
      "FAIL — a manifest discriminant has no usable coverage decision:\n"
    );
    for (const f of result.failures) console.error("  - " + f + "\n");
    process.exit(1);
  }

  const witnessed = result.rows.filter((r) => r.status === "witness").length;
  console.log(
    `PASS: ${result.names.length} discriminant(s) derived and each has a ` +
      `coverage decision — ${witnessed} with a witness, ` +
      `${result.names.length - witnessed} recorded as uncovered. ` +
      `${result.totalSites} comparison sites examined.\n` +
      `NOTE: an uncovered discriminant is a KNOWN GAP, not a guarded one. This ` +
      `check proves the gaps are declared, never that they are closed.`
  );
}
