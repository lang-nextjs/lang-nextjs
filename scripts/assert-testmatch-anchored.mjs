#!/usr/bin/env node
/**
 * Property: EVERY `testMatch` PATTERN IS ANCHORED AT BOTH ENDS.
 *
 * `playwright.config.ts` scopes projects with per-file regexes. An unanchored one means "this
 * spec" to a reader and "any path CONTAINING this substring" to the engine, and the two only
 * diverge when a file with a suffixing name appears. Demonstrated on #473:
 *
 *     /accessibility\.spec\.ts/   claimed   e2e/rungs/open-swe/open-swe-accessibility.spec.ts
 *
 * so `chromium` ran an open-swe spec — against PLAYWRIGHT_BASE_URL, which in the Django and
 * FastAPI jobs is the EXAMPLE APP. It failed only because that spec happens to assert which app
 * answered. Without that, it would have reported green in two jobs: a passing open-swe
 * accessibility gate that never once looked at open-swe (#475).
 *
 * THE FAILURE HAS NO NATURAL SYMPTOM. A spec joining an extra project still runs, still
 * reports, still goes green — it simply runs against a configuration nobody intended. It is
 * not a missing test; it is a test whose SUBJECT silently changed.
 *
 * ── WHY THIS PARSES THE CONFIG, WHEN ITS SIBLING REFUSES TO ───────────────────────────────
 *
 * `check-e2e-registration.mjs` deliberately never parses: it asks Playwright via
 * `--list --reporter=json` and uses the resulting assignments as ground truth, because
 * re-implementing the match would silently treat unreadable forms as "no match".
 *
 * That instrument cannot answer THIS question. `--list` reports which specs a project claimed;
 * it cannot report whether the pattern that claimed them was anchored, and an unanchored
 * pattern that has not yet collided is indistinguishable from an anchored one in its output.
 * The question is about the PATTERN, so the pattern is what gets read — and anything this
 * cannot classify is a REFUSAL, never a skip, because a form silently treated as "fine" is the
 * same defect one level up.
 *
 * ── THE OPPOSITE ERROR IS NOT COVERED BY THIS, AND I WAS WRONG ABOUT WHO COVERS IT ────────
 *
 * Anchoring is the repair that can go stale silently: AN ANCHOR TOO TIGHT MATCHES NOTHING, AND
 * A PATTERN MATCHING NOTHING LOOKS EXACTLY LIKE ONE MATCHING ITS INTENDED SET.
 *
 * I first wrote here that `check-e2e-registration.mjs` already covered that direction. It does
 * not, and the mutation says so plainly:
 *
 *     /(^|\/)shared\/nextjs\.spec\.ts$/  ->  /(^|\/)shared\/nextjs-NOPE\.spec\.ts$/
 *
 *     assert-testmatch-anchored   exit 0   still anchored — correctly indifferent
 *     check-e2e-registration      exit 0   the spec still runs in OTHER projects so it is not
 *                                          an orphan, and the project still matches twelve
 *                                          others so it is not a ghost
 *
 * Emptiness at both ends is a weaker property than membership. The tightened project silently
 * ran one fewer spec and reported the same green. `assert-e2e-partition.mjs` was written for
 * that gap and catches it as `LEFT project "firefox"`.
 *
 * So this checker prevents over-matching BEFORE it happens; the partition freeze detects any
 * membership change, either direction, AFTER it happens. Neither implies the other, and the
 * claim that one did was itself the defect class — a coverage assertion nobody had measured.
 *
 * Usage: node scripts/assert-testmatch-anchored.mjs [--cwd DIR] [--config PATH]
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const ROOT = resolve(
  argOf("--cwd") ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
const CONFIG = resolve(argOf("--config") ?? join(ROOT, "playwright.config.ts"));

const LITERAL = /\/(?:[^/\\\n]|\\.)+\/[a-z]*/g;

/**
 * Every regex literal used to scope a project, from `testMatch:` values and from any shared
 * const whose name ends in TESTMATCH.
 *
 * Returns `strings` separately: Playwright also accepts glob STRINGS, which have different
 * anchoring rules. They are reported rather than silently passed — an unclassifiable form is
 * the thing this checker exists to stop being invisible.
 */
export function collect(configText) {
  const literals = [];
  const strings = [];
  const blocks = [];
  for (const m of configText.matchAll(
    /testMatch:\s*(\[[^\]]*\]|\/(?:[^/\\\n]|\\.)+\/[a-z]*|"[^"]*"|'[^']*')/gs
  )) {
    blocks.push(m[1]);
  }
  for (const m of configText.matchAll(
    /const\s+[A-Za-z_$][\w$]*TESTMATCH\s*=\s*(\[[^\]]*\])/gs
  )) {
    blocks.push(m[1]);
  }
  for (const b of blocks) {
    for (const lit of b.match(LITERAL) ?? []) literals.push(lit);
    for (const s of b.match(/["'][^"']*["']/g) ?? []) strings.push(s);
  }
  return {
    literals: [...new Set(literals)],
    strings: [...new Set(strings)],
    blockCount: blocks.length,
  };
}

/** A pattern is anchored when neither end can absorb extra path characters. */
export function classify(lit) {
  const i = lit.lastIndexOf("/");
  const body = lit.slice(1, i);
  const lead = body.startsWith("^") || body.startsWith("(^|");
  // A pattern ending in an escaped `/` is a DIRECTORY prefix; `$` would make it match nothing.
  const tail = body.endsWith("$") || body.endsWith("\\/");
  return { body, lead, tail, ok: lead && tail };
}

export function check(root = ROOT, configPath = CONFIG) {
  if (!existsSync(configPath)) return { problem: `no config at ${configPath}` };
  const { literals, strings, blockCount } = collect(
    readFileSync(configPath, "utf8")
  );
  /*
   * STRINGS ARE REPORTED BEFORE VACUITY, and the order is load-bearing: a config whose only
   * testMatch values are glob strings has ZERO regex patterns, so the vacuity guard would fire
   * first and refuse for the wrong reason. Caught by the selftest asserting WHICH complaint
   * appeared — an exit code alone could not tell the two refusals apart.
   */
  if (strings.length > 0) return { strings };
  if (blockCount === 0 || literals.length === 0) {
    return {
      problem:
        `found ${blockCount} testMatch value(s) and ${literals.length} regex pattern(s) in ` +
        `${
          relative(root, configPath) || configPath
        }. This checker is about those patterns, ` +
        `so an empty set means it COULD NOT COMPUTE the property — not that every pattern is ` +
        `anchored.`,
    };
  }
  const rows = literals.map((lit) => ({ lit, ...classify(lit) }));
  return { rows, strings, configPath };
}

function main() {
  const r = check(ROOT, CONFIG);
  if (r.strings && r.strings.length > 0 && !r.rows) {
    console.error(
      `FAIL: ${r.strings.length} testMatch value(s) are STRINGS, which this checker cannot ` +
        `classify:\n` +
        r.strings.map((x) => `        ${x}`).join("\n") +
        `\n      Glob strings anchor differently from regexes. Refusing rather than passing them, ` +
        `because a form\n      silently treated as "fine" is the defect this exists to prevent.`
    );
    process.exit(2);
  }
  if (r.problem) {
    console.error(`FAIL: ${r.problem}`);
    process.exit(2);
  }

  // NAME THE SUBJECT. A verdict that does not say which patterns it read cannot be told apart
  // from one that read none.
  const bad = r.rows.filter((x) => !x.ok);
  console.log(
    `${r.rows.length} testMatch pattern(s) in ${
      relative(ROOT, r.configPath) || r.configPath
    }; ` + `${r.rows.length - bad.length} anchored, ${bad.length} not`
  );

  if (r.strings.length > 0) {
    console.error(
      `FAIL: ${r.strings.length} testMatch value(s) are STRINGS, which this checker cannot ` +
        `classify:\n` +
        r.strings.map((s) => `        ${s}`).join("\n") +
        `\n      Glob strings anchor differently from regexes. Refusing rather than passing ` +
        `them, because\n      a form silently treated as "fine" is the defect this exists to ` +
        `prevent.`
    );
    process.exit(2);
  }

  for (const x of bad) {
    const missing = [!x.lead && "start", !x.tail && "end"]
      .filter(Boolean)
      .join(" and ");
    console.error(
      `FAIL: ${x.lit} is UNANCHORED at the ${missing}. It means "this spec" to a reader and ` +
        `"any path\n      containing this substring" to the engine, so a file named ` +
        `<something>-<this one> joins the\n      project silently and runs against whatever ` +
        `baseURL its jobs set.\n` +
        `      Anchor it: /(^|\\/)…$/ for a file, /(^|\\/)…\\// for a directory.`
    );
  }
  if (bad.length > 0) process.exit(1);

  reportSubject(r.rows.length, "testMatch pattern(s)");
  console.log(
    `\nPASS: every testMatch pattern is anchored at both ends, so no spec can join a project ` +
      `by\n      suffixing an existing name. The opposite error — an anchor so tight it ` +
      `matches nothing —\n      is NOT caught here, nor by the registration check; ` +
      `it is assert-e2e-partition.mjs's.`
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
