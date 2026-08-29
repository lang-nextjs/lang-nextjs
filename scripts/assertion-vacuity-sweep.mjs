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
 *   --strict A,B    gate on both
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

const LOOP_START = /\b(for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\()/;
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
    bodies.push({ start: i, body: src.slice(open, end + 1) });
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

const files = walk(join(ROOT, SCAN_DIR));
const { ids, interpolated } = definedTestIds();
const a = shapeA(files);
const { found: b, dynamic } = shapeB(files, ids);

if (flag("--json")) {
  // `definedCount` is part of the payload so a consumer can tell a real zero
  // from a vacuous one without re-deriving it.
  console.log(
    JSON.stringify({ shapeA: a, shapeB: b, definedCount: ids.length }, null, 2)
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
    `\nRESIDUAL — what this sweep does NOT cover, stated so a zero above is not read as "none":`
  );
  console.log(
    `  - loops that empty via break, a truthy-condition continue, or a filter`
  );
  console.log(
    `  - a loop over a collection that is simply empty, with no guard at all`
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
  (strict.includes("A") ? a.length : 0) + (strict.includes("B") ? b.length : 0);
if (strict && gated > 0) {
  console.error(
    `\nFAIL: ${gated} finding(s) in gated shape(s) [${strict}]. ` +
      `A loop that can assert nothing passes without ever going red.`
  );
  process.exit(1);
}
