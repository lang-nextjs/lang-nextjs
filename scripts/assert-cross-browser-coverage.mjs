#!/usr/bin/env node
/**
 * Property: HOW MUCH CROSS-BROWSER COVERAGE HAS BEEN GIVEN UP IS A NUMBER
 * SOMEBODY IS WATCHING.
 *
 * THE FINDING (#749). `e2e/hitl.spec.ts` carries three browser restrictions.
 * Each is individually well-argued — a Playwright WebKit stream-truncation
 * harness bug, a #114 quarantine that says in its own text "a quarantine and not
 * a fix, cause NOT identified", and #748's scoping of a case that could only be
 * observed where its flake occurs. None should be reverted; the ruling on #749
 * is explicit that whether three is too many is NOT what this decides.
 *
 * What was missing is that nothing counted them. The point at which the total
 * becomes a problem is invisible from any single pull request, because every
 * individual restriction is a local decision with a local justification — the
 * same argument as an integration batch finding what no member PR can.
 *
 * ── WHY PER ENGINE AND NOT PER RESTRICTION ──────────────────────────────────
 *
 * A count of restrictions is the wrong unit, and it was wrong before anyone
 * tried to game it. Measured at 41afc308:
 *
 *   hitl.spec.ts:549   browserName !== "chromium"   skips webkit AND FIREFOX
 *   hitl.spec.ts:1034  browserName === "webkit"     webkit
 *   hitl.spec.ts:1520  browserName === "webkit"     webkit
 *
 *   webkit 3   firefox 1   chromium 0
 *
 * THREE RESTRICTIONS ARE FOUR ENGINE-LOSSES. The one costing two engines reads
 * as a single decision and its stated reason is about webkit throughout, so
 * nobody reviewing it was thinking about firefox — which is how it got there. A
 * pinned "3" is not merely satisfiable by writing "4"; it is already wrong about
 * what has been lost.
 *
 * Pinned per engine, a new negative condition has to move TWO numbers, which is
 * what it actually costs.
 *
 * ── AND A PER-ISSUE TALLY BESIDE IT ─────────────────────────────────────────
 *
 * All three name an issue and TWO NAME THE SAME ONE. Three restrictions are two
 * causes, and #114 has spread to a second site. "A quarantine is spreading" and
 * "a new unrelated skip appeared" are different alarms deserving different
 * responses, and the first is invisible in any per-engine count.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT REQUIRE ─────────────────────────────────
 *
 * A machine-readable un-skip condition was considered and REJECTED (#749). The
 * most honest restriction in the file says its cause is not identified;
 * requiring a parseable condition would force it to invent one, and an invented
 * condition is a promise that reads as accountability and can never fire. The
 * check would then be passed most easily by whoever was least careful.
 *
 * ── THE PARSE IS BALANCED, NOT LINE-WISE ────────────────────────────────────
 *
 * These are multi-line calls: `test.skip(` opens on one line and the condition
 * sits on the next. Measured:
 *
 *   grep -cE 'test\.(skip|fixme)\(.*browserName'   ->  0   on every file
 *
 * A single-line pattern reports NO restrictions in a file containing three. Same
 * continuation-line shape that undercounted #736's `|| true` corpus by four, and
 * that this repo's shell-verdict checker was itself shipped with once.
 *
 * Usage: node scripts/assert-cross-browser-coverage.mjs [--cwd DIR] [--freeze]
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { reportSubject } from "./lib/subject.mjs";

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD =
  ci >= 0
    ? resolve(argv[ci + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");
const FREEZE = argv.includes("--freeze");
const FROZEN_PATH = join(CWD, "scripts", "cross-browser-coverage.json");
const CONFIG = join(CWD, "playwright.config.ts");

const refuse = (why) => {
  console.error(`REFUSING: ${why}\n`);
  console.error(
    "  Exiting 2: the question could not be asked, not answered. A count this\n" +
      "  checker could not compute must not be reported as a count of zero."
  );
  process.exit(2);
};

if (!existsSync(CONFIG)) refuse(`no playwright.config.ts under ${CWD}`);
const config = readFileSync(CONFIG, "utf8");

/*
 * THE SCOPE COMES FROM THE CONFIG, NOT FROM A LIST HERE.
 *
 * Which files are cross-browser, and which projects run them, are already
 * declared once in playwright.config.ts. A second copy in this file is a
 * declaration that can go stale silently — and the stale one is always the copy
 * that is not the source of truth. Adding a sixth file to CROSS_BROWSER_TESTMATCH
 * brings it into this checker's subject with no edit here.
 */
const matchBlock = /const CROSS_BROWSER_TESTMATCH\s*=\s*\[([\s\S]*?)\];/.exec(
  config
);
if (!matchBlock)
  refuse("could not find CROSS_BROWSER_TESTMATCH in playwright.config.ts");
/*
 * ONE REGEX LITERAL PER LINE, TAKEN FROM THE FIRST `/` TO THE LAST.
 *
 * The patterns contain ESCAPED slashes — `/(^|\/)hitl\.spec\.ts$/` — so a
 * character class excluding `/` splits them in the middle and yields fragments
 * that match nothing. The first version of this file did exactly that: it
 * resolved zero in-scope files, reported "0 restriction(s) in scope", EXCLUDED
 * all three restrictions it exists to count, and exited 0. It then froze
 * {webkit: 0, firefox: 0} — a record of nothing, which would have passed
 * forever.
 *
 * That is this checker's own subject arriving inside its instrument, and it is
 * why the scope guard below is not optional.
 */
const patterns = matchBlock[1]
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("/"))
  .map((l) => l.slice(1, l.lastIndexOf("/")))
  .filter(Boolean);
if (patterns.length === 0)
  refuse("CROSS_BROWSER_TESTMATCH parsed to zero patterns");

/** Projects whose testMatch IS that constant — the engines actually at stake. */
const ENGINES = [
  ...config.matchAll(
    /name:\s*"([a-z-]+)",\s*\n\s*use:[^\n]*\n\s*testMatch:\s*CROSS_BROWSER_TESTMATCH/g
  ),
].map((m) => m[1]);
if (ENGINES.length === 0)
  refuse("no project in playwright.config.ts uses CROSS_BROWSER_TESTMATCH");

const specs = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".spec.ts")) specs.push(p);
  }
})(join(CWD, "e2e"));
if (specs.length === 0) refuse(`swept 0 spec files under ${join(CWD, "e2e")}`);

const inScope = (rel) =>
  patterns.some((src) => {
    try {
      return new RegExp(src).test(rel);
    } catch {
      refuse(`CROSS_BROWSER_TESTMATCH entry is not a usable regex: ${src}`);
    }
  });

/*
 * A SCOPE THAT RESOLVED TO NOTHING IS NOT AN EMPTY SUBJECT.
 *
 * If the config declares cross-browser files and none of them exist on disk,
 * every restriction falls into "excluded" and the tallies are zeroes about a set
 * that was never read. Refusing here is what turns the parsing defect above from
 * a silent green into a stop.
 */
const scopeFiles = specs.filter((f) => inScope(relative(CWD, f)));
if (scopeFiles.length === 0)
  refuse(
    `CROSS_BROWSER_TESTMATCH declares ${patterns.length} pattern(s) but they match ` +
      `none of the ${specs.length} spec files under e2e/. Every tally would be a zero ` +
      "about a subject that was never read."
  );

/**
 * Every `test.skip(...)` / `test.fixme(...)` whose call mentions `browserName`.
 *
 * Balanced-paren, so a condition on a continuation line is inside the call text
 * rather than invisible to it.
 */
function restrictionsIn(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/test\.(skip|fixme)\s*\(/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    if (depth !== 0) continue; // unbalanced: not a call this can read
    const call = src.slice(m.index, i);
    if (!/\bbrowserName\b/.test(call)) continue;
    out.push({
      kind: m[1],
      line: src.slice(0, m.index).split("\n").length,
      condition: call
        .slice(call.indexOf("(") + 1)
        .split(",")[0]
        .trim(),
      issues: [...new Set([...call.matchAll(/#(\d+)/g)].map((x) => x[1]))],
    });
  }
  return out;
}

/**
 * Which engines does this condition remove the test from?
 *
 * REFUSES on a shape it cannot read, rather than returning an empty set. An
 * unreadable condition counted as zero engines is the exact defect this file
 * exists to prevent, arriving inside the instrument.
 */
function enginesLost(condition, where) {
  const eq = /^browserName\s*===\s*"([a-z]+)"$/.exec(condition);
  if (eq) return ENGINES.filter((e) => e === eq[1]);
  const ne = /^browserName\s*!==\s*"([a-z]+)"$/.exec(condition);
  if (ne) return ENGINES.filter((e) => e !== ne[1]);
  refuse(
    `${where}: cannot read the condition ${JSON.stringify(condition)}.\n` +
      '  Only `browserName === "x"` and `browserName !== "x"` are understood.\n' +
      "  A compound condition may remove a different set of engines than it appears\n" +
      "  to, and guessing here would put a wrong number in the frozen file."
  );
}

const counted = [];
const excluded = [];
for (const file of specs) {
  const rel = relative(CWD, file);
  for (const r of restrictionsIn(file)) {
    if (inScope(rel)) counted.push({ rel, ...r });
    else excluded.push({ rel, ...r });
  }
}

const engines = Object.fromEntries(ENGINES.map((e) => [e, 0]));
const issues = {};
for (const r of counted) {
  for (const e of enginesLost(r.condition, `${r.rel}:${r.line}`))
    engines[e] += 1;
  for (const i of r.issues) issues[i] = (issues[i] ?? 0) + 1;
}
const observed = { engines, issues };

if (FREEZE) {
  writeFileSync(FROZEN_PATH, `${JSON.stringify(observed, null, 2)}\n`);
  console.log(`froze ${relative(CWD, FROZEN_PATH)}:`);
  console.log(`  engines ${JSON.stringify(engines)}`);
  console.log(`  issues  ${JSON.stringify(issues)}`);
  process.exit(0);
}

if (!existsSync(FROZEN_PATH))
  refuse(
    `no ${relative(
      CWD,
      FROZEN_PATH
    )} — run with --freeze to record the current state`
  );
let frozen;
try {
  frozen = JSON.parse(readFileSync(FROZEN_PATH, "utf8"));
} catch (e) {
  refuse(`${relative(CWD, FROZEN_PATH)} is not valid JSON: ${e.message}`);
}

/*
 * THE EXCLUSIONS ARE STATED, NOT MERELY UNMATCHED (#749).
 *
 * A restriction outside CROSS_BROWSER_TESTMATCH is out of this checker's scope,
 * and "did not appear in the output" is indistinguishable from "the checker
 * never looked". Printing them, with the reason, means the domain is narrowed by
 * a rule someone wrote rather than by a pattern that happened not to match.
 */
const say = (l) => console.log(l);
say(
  `cross-browser coverage — ${counted.length} restriction(s) in scope across ` +
    `${ENGINES.length} engine(s) [${ENGINES.join(", ")}]`
);
for (const r of counted)
  say(
    `  counted  ${r.rel}:${r.line}  ${r.kind}  ${r.condition}  ${
      r.issues.map((i) => "#" + i).join(" ") || "(no issue cited)"
    }`
  );
for (const r of excluded)
  say(
    `  EXCLUDED ${r.rel}:${r.line}  ${r.condition}\n` +
      `           not matched by CROSS_BROWSER_TESTMATCH, so no cross-browser project runs it —\n` +
      `           it reduces no engine's coverage of the cross-browser subset.`
  );

const diffs = [];
for (const e of ENGINES)
  if ((frozen.engines?.[e] ?? null) !== engines[e])
    diffs.push(
      `  engine ${e}: frozen ${frozen.engines?.[e] ?? "(absent)"} -> observed ${
        engines[e]
      }`
    );
for (const i of new Set([
  ...Object.keys(frozen.issues ?? {}),
  ...Object.keys(issues),
]))
  if ((frozen.issues?.[i] ?? 0) !== (issues[i] ?? 0))
    diffs.push(
      `  issue #${i}: frozen ${frozen.issues?.[i] ?? 0} -> observed ${
        issues[i] ?? 0
      }`
    );

if (diffs.length) {
  console.error(
    `\nFAIL: cross-browser coverage changed and the frozen record does not say so.\n`
  );
  for (const d of diffs) console.error(d);
  console.error(
    "\n  This is not a verdict that the change is wrong. It is that the number moved\n" +
      "  and nobody wrote it down. If the restriction is justified, record it:\n\n" +
      "    node scripts/assert-cross-browser-coverage.mjs --freeze\n\n" +
      "  and say in the commit which engines it costs — a per-issue count rising is a\n" +
      "  quarantine SPREADING, which is a different fact from a new unrelated skip."
  );
  process.exit(1);
}

reportSubject(
  scopeFiles.length,
  "spec file(s) matched by CROSS_BROWSER_TESTMATCH"
);
say(
  `\nPASS: engines ${JSON.stringify(engines)}, issues ${JSON.stringify(
    issues
  )} — ` + `unchanged from ${relative(CWD, FROZEN_PATH)}.`
);
