#!/usr/bin/env node
/**
 * SWEEP FOR CHECKS THAT CAN GO QUIET WITHOUT GOING RED (#328).
 *
 * #328 collects one defect wearing several costumes: the SUBJECT of a check
 * drifted from the subject its reader assumed, and nothing failed. Two of the
 * shapes it names are mechanically findable, and this finds them.
 *
 * WHAT THIS DETECTS, AND WHAT IT MEANS — stated separately on purpose, because
 * conflating them is itself the defect (#339: a grep for the literal
 * `next start` reported that no suite runs against a production build; eight
 * invocations were spelled `pnpm --filter <app> start`).
 *
 *   SHAPE A  detects:  a loop whose body contains BOTH a skip guard
 *                      (`if (!x) continue|return`) and an `expect(`.
 *            means:    a loop that can execute zero assertions and still pass.
 *            gap:      a loop can also empty out via `break`, a truthy-cond
 *                      `continue`, a `.filter()` that removes everything, or a
 *                      `count()` of zero with no guard at all. Those are NOT
 *                      found here and are reported as the residual, not as
 *                      absence.
 *
 *   SHAPE B  detects:  `[data-testid^="P"]` where more than one testid defined
 *                      in the app source starts with P.
 *            means:    a locator that can match controls it was not written for.
 *            gap:      prefixes built by interpolation (`^="${x}-"`) are not
 *                      resolved, and a testid rendered from a template literal
 *                      is not in the definition set. Both are reported.
 *
 * NEITHER SHAPE IS A VERDICT. Some skip guards are correct — a genuinely
 * optional element is a real thing — and some prefix families are exactly what
 * the author meant. The grep is the easy part; deciding which is which is the
 * work. This prints evidence for a human, and exits 0 unless asked not to.
 *
 * CALIBRATION IS NOT OPTIONAL HERE. A sweep reporting "0 found" is
 * indistinguishable from a sweep that searched wrong — the exact defect #328
 * collects, which would make this script an instance of its own subject. So
 * assertion-vacuity-sweep.selftest.mjs runs it against the two REAL historical
 * instances (recovered from 9b5e64e, before #327 fixed them) and fails if it
 * does not find them. A positive fixture is stronger than a mutation for this:
 * a broken regex cannot find a known instance, whatever else it reports.
 *
 * Usage:
 *   node scripts/assertion-vacuity-sweep.mjs [--dir e2e] [--json] [--strict]
 *   --strict A      exit 1 if SHAPE A finds anything (the gate CI runs)
 *   --strict A,C    gate on both (the two shapes clean on main)
 *
 * SHAPE A IS GATED AND SHAPE B IS NOT, deliberately. Shape A is clean on main
 * and its one historical instance is fixed, so a new one is a new defect.
 * Shape B currently reports five hits in open-swe-remaining-paths.spec.ts that
 * are all CORRECT: `rename-${id}` and `rename-input-${id}` are the two arms of
 * a ternary (AppSidebar.tsx:226), so only one exists at a time and the prefix
 * cannot match the wrong control. Static analysis cannot see that, and gating
 * on it would train people to widen an allowlist. Reported, not enforced —
 * until either the locators are narrowed or the sweep learns mutual exclusion.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const ROOT = process.cwd();
const SCAN_DIR = opt("--dir", "e2e");
/**
 * Where testids are DEFINED — the app and component source, not the specs.
 *
 * Overridable because the shape-B fixture has to pair an OLD spec with NEW
 * definitions: `framework-select` did not exist when that locator was written
 * (it arrived with #327), which is the whole mechanism — the locator did not
 * become wrong, the family it ranges over grew a member.
 */
const DEFINITION_DIRS = (opt("--defs", "apps,packages") || "")
  .split(",")
  .filter(Boolean);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".next") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  SHAPE A — a loop that can execute zero assertions                         */
/* -------------------------------------------------------------------------- */

const LOOP_START = /^(for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\()/;
const SKIP_GUARD =
  /if\s*\([^)]*\)\s*\{?\s*(continue|return)\b|if\s*\([^)]*\)\s*(continue|return)\s*;/;
const NEGATED_GUARD = /if\s*\(\s*!|===\s*null|===\s*undefined|== null/;

/**
 * Brace-matched loop bodies. Regex cannot bound a block, and a line-window
 * heuristic silently truncates the long loops — which are exactly the ones
 * where a guard and its assertion drift apart.
 */
function loopBodies(src) {
  const bodies = [];
  for (let i = 0; i < src.length; i++) {
    const rest = src.slice(i, i + 12);
    const m = rest.match(LOOP_START);
    if (!m || m.index !== 0) continue;
    const open = src.indexOf("{", i);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    bodies.push({
      start: i,
      body: src.slice(open, end + 1),
      form: m[1],
      head: src.slice(Math.max(0, i - 200), open),
    });
    i = open;
  }
  return bodies;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

function shapeA(files) {
  const found = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const { start, body } of loopBodies(src)) {
      if (!SKIP_GUARD.test(body)) continue;
      if (!/\bexpect\s*\(/.test(body)) continue;
      const guardLine = body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => SKIP_GUARD.test(l) && /continue|return/.test(l));
      found.push({
        file: relative(ROOT, file),
        line: lineOf(src, start),
        guard: guardLine ?? "(multiline)",
        negated: NEGATED_GUARD.test(guardLine ?? ""),
        assertions: (body.match(/\bexpect\s*\(/g) ?? []).length,
      });
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/*  SHAPE B — an unbounded testid prefix                                      */
/* -------------------------------------------------------------------------- */

function definedTestIds() {
  const ids = new Set();
  let interpolated = 0;
  for (const d of DEFINITION_DIRS) {
    // ABSOLUTE ENTRIES ARE USED AS-IS. `join(cwd, "/abs/path")` silently
    // produces `cwd/abs/path`, which walks nothing and yields an empty
    // definition set — and an empty definition set makes SHAPE B report a
    // confident zero. That is exactly how this sweep first "passed" its own
    // calibration while being unable to find a known instance.
    for (const file of walk(isAbsolute(d) ? d : join(ROOT, d))) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(/data-testid=["']([^"'{}]+)["']/g))
        ids.add(m[1]);
      for (const m of src.matchAll(/data-testid=\{`([^`]*)`\}/g)) {
        interpolated++;
        const literal = m[1].split("$")[0];
        if (literal) ids.add(literal + "…");
      }
    }
  }
  return { ids: [...ids].sort(), interpolated };
}

function shapeB(files, defined) {
  const found = [];
  let dynamic = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/data-testid\^=\\?["']([^"'\\]*)\\?["']/g)) {
      const prefix = m[1];
      if (!prefix || prefix.includes("$")) {
        dynamic++;
        continue;
      }
      const matches = defined.filter((id) => id.startsWith(prefix));
      if (matches.length > 1) {
        found.push({
          file: relative(ROOT, file),
          line: lineOf(src, m.index),
          prefix,
          matches,
        });
      }
    }
  }
  return { found, dynamic };
}

/* -------------------------------------------------------------------------- */

/*
 * `--dir` RESOLVES LIKE `--defs` DOES, and it did not (#328).
 *
 * `--defs` was already `isAbsolute(d) ? d : join(ROOT, d)` because this exact
 * defect was found and fixed there during development — the docstring records
 * it: "--defs received absolute paths, join(cwd, abs) walked nothing, and shape
 * B reported a confident zero while being structurally unable to find
 * anything." THE SAME LINE WAS NEVER FIXED FOR `--dir`. An absolute --dir
 * produced ROOT + "/abs/path", walked nothing, and printed 0 for every shape.
 *
 * Found by pointing the sweep at a fixture directory holding two KNOWN
 * instances and getting a clean report. A fix applied to one call site and not
 * the identical one beside it is the shape this whole file exists to catch.
 */
const files = walk(isAbsolute(SCAN_DIR) ? SCAN_DIR : join(ROOT, SCAN_DIR));

/*
 * A SWEEP OVER NOTHING IS NOT A CLEAN SWEEP. Every shape below reports 0 when
 * no file was read, which is indistinguishable from a tree with no defects —
 * the vacuity this file is named for, in the file itself. Exit 2 rather than 1:
 * nothing is WRONG with the tree, the run had no subject.
 */
if (files.length === 0) {
  console.error(
    `REFUSING: found no .ts/.tsx files under ${SCAN_DIR}. A sweep of nothing ` +
      `reports the same zeros as a sweep of a clean tree.`
  );
  process.exit(2);
}
const { ids, interpolated } = definedTestIds();
/* -------------------------------------------------------------------------- */
/*  SHAPE C — a loop over a QUERIED set that may simply be empty              */
/* -------------------------------------------------------------------------- */

/**
 * THE RESIDUAL SHAPE A NAMES AND CANNOT SEE (#328 class 2, the pure form).
 *
 * Shape A finds a loop that can execute zero assertions BECAUSE OF A GUARD. The
 * worse case has no guard at all: the collection is simply empty, the body never
 * runs, and nothing distinguishes that from a loop that checked twenty things.
 * A green run looks identical either way, which is what makes it the shape that
 * gets skipped.
 *
 * WHAT COUNTS AS "QUERIED", AND WHY THE OBVIOUS DEFINITION IS USELESS.
 * Measured before this was written: over e2e/, apps/ and packages/, treating any
 * runtime-shaped collection as discovered flags 27 loops, and essentially all of
 * them iterate `Object.entries(SOME_LITERAL)` over a constant declared in the
 * same file. THAT SIZE IS VISIBLE IN THE SOURCE — it can only be empty if
 * someone empties the literal, which is a diff a reader can see. Gating on those
 * would train people to widen an allowlist, which is worse than no gate.
 *
 * So "queried" means ASKED OF A RENDERED PAGE — `.count()`, `.all()`,
 * `getAllBy*`, `findAllBy*`, `querySelectorAll`, `$$`. Those are the sets whose
 * size the source cannot show, and they are the ones that changed underneath the
 * loop in the instance this issue was filed for.
 *
 * `.map` IS NOT SPECIAL-CASED, AND IT WAS, UNTIL A MUTATION SHOWED THE CASE WAS
 * DEAD. The first draft skipped `.map` on the reasoning that
 * `expect(labels.map(f)).toEqual([...])` is SAFE precisely when empty — the
 * assertion receives the whole collection, so `[]` fails a non-empty
 * expectation. That reasoning is correct and the exclusion was still useless:
 * removing it changed no result, because the safe form is already excluded
 * STRUCTURALLY. `loopBodies` requires a braced body, and an assertion-argument
 * `.map` has a brace-less arrow, so it is never collected.
 *
 * Keeping it would have been a rule with a justification and no test — the exact
 * thing this file exists to find. Worse, it would have SUPPRESSED a real defect:
 * a braced `.map` that discards its result iterates for effect exactly like
 * `forEach`, and is vacuous when the collection is empty. That case is now
 * asserted in the selftest, so re-adding the exclusion goes red.
 *
 * A LOOP WITH NO `expect(` IN ITS BODY IS NOT THIS DEFECT either. It acts rather
 * than asserts, so an empty set means the actions did not happen and a later
 * assertion carries the failure.
 */
const QUERIED =
  /\.count\s*\(\)|\.all\s*\(\)|getAllBy\w*\s*\(|findAllBy\w*\s*\(|querySelectorAll\s*\(|\$\$\s*\(/;

/** An assertion that the collection had members — the presence companion. */
const SIZE_ASSERT =
  /toHaveCount\s*\(|toHaveLength\s*\(|toBeGreaterThan(OrEqual)?\s*\(\s*\d|expect\s*\([^)]*\.length|expect\s*\(\s*(await\s+)?[\w.$]*count/;

/** How far back a size assertion may sit and still be about this loop. */
const SIZE_WINDOW = 900;

function shapeC(files) {
  const found = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const { start, body, form, head } of loopBodies(src)) {
      if (!QUERIED.test(head)) continue;
      if (!/\bexpect\s*\(/.test(body)) continue;
      const before = src.slice(Math.max(0, start - SIZE_WINDOW), start);
      if (SIZE_ASSERT.test(before)) continue;
      found.push({
        file: relative(ROOT, file),
        line: lineOf(src, start),
        loop: head.trim().split("\n").pop().trim().slice(0, 90),
      });
    }
  }
  return found;
}

const a = shapeA(files);
const c = shapeC(files);
const { found: b, dynamic } = shapeB(files, ids);

if (flag("--json")) {
  // `definedCount` is part of the payload so a consumer can tell a real zero
  // from a vacuous one without re-deriving it.
  console.log(
    JSON.stringify(
      { shapeA: a, shapeB: b, shapeC: c, definedCount: ids.length },
      null,
      2
    )
  );
} else {
  console.log(
    `Vacuity sweep over ${files.length} files in ${SCAN_DIR}/ ` +
      `(${ids.length} testids defined across ${DEFINITION_DIRS.join(", ")})\n`
  );
  /*
   * A ZERO FROM AN EMPTY DEFINITION SET IS NOT A ZERO. Shape B compares each
   * locator prefix against the testids the app defines; with none loaded,
   * every prefix matches nothing and the sweep reports a confident, false
   * "no ambiguous prefixes". Caught while calibrating: the first fixture run
   * printed 0 for shape B purely because the fixture directory had no app
   * source in it.
   */
  if (ids.length === 0) {
    console.log(
      "  WARNING: no testids found in the definition dirs — SHAPE B below is VACUOUS,\n" +
        "  not clean. Point --defs at the app source.\n"
    );
  }

  console.log(
    `SHAPE A — loops carrying both a skip guard and an assertion: ${a.length}`
  );
  for (const f of a) {
    console.log(`  ${f.file}:${f.line}  (${f.assertions} assertion(s))`);
    console.log(`      ${f.guard}${f.negated ? "   <-- negated guard" : ""}`);
  }

  console.log(
    `\nSHAPE B — testid prefixes matching more than one defined testid: ${b.length}`
  );
  for (const f of b) {
    console.log(
      `  ${f.file}:${f.line}  ^="${f.prefix}" matches ${f.matches.length}:`
    );
    console.log(`      ${f.matches.join(", ")}`);
  }

  console.log(
    `\nSHAPE C — a loop over a QUERIED set that may simply be EMPTY: ${c.length} found.`
  );
  console.log(
    `  A loop with no guard at all, whose collection is asked of the page. If it`
  );
  console.log(
    `  resolves to nothing the body never runs, and a green run is indistinguishable`
  );
  console.log(`  from one that checked twenty things.`);
  for (const f of c) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`      ${f.loop}`);
  }

  console.log(
    `\nRESIDUAL — what this sweep does NOT cover, stated so a zero above is not read as "none":`
  );
  console.log(
    `  - loops that empty via break, a truthy-condition continue, or a filter`
  );
  console.log(
    `  - a loop over an empty collection whose size is NOT asked of the page:`
  );
  console.log(
    `    Object.entries of a literal, a filter result, an array built in the test.`
  );
  console.log(
    `    Shape C covers the queried case only — 27 loops match the wider reading and`
  );
  console.log(
    `    essentially all iterate a constant declared in the same file, whose size a`
  );
  console.log(
    `    reader can see. Gating those would only teach allowlist-widening.`
  );
  console.log(
    `  - ${dynamic} interpolated locator prefix(es), not resolvable statically`
  );
  console.log(
    `  - ${interpolated} testid(s) built from template literals, recorded only by their literal head`
  );
}

const strict = (opt("--strict", "") || "").toUpperCase();
const gated =
  (strict.includes("A") ? a.length : 0) +
  (strict.includes("B") ? b.length : 0) +
  (strict.includes("C") ? c.length : 0);
if (strict && gated > 0) {
  console.error(
    `\nFAIL: ${gated} finding(s) in gated shape(s) [${strict}]. ` +
      `A loop that can assert nothing passes without ever going red.`
  );
  process.exit(1);
}
