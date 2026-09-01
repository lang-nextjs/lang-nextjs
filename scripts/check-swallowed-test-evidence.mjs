#!/usr/bin/env node
/**
 * EVIDENCE A TEST PRINTS ON THE SUCCESS PATH IS NEVER SEEN (#456).
 *
 * Under vitest's default reporter, console output from a test that PASSES is
 * captured and never rendered. Output from a test that FAILS is shown. So
 * `console` is exactly inverted against the thing this repo keeps asking checks
 * to do: name your subject, so that a bare PASS is not the whole output. A
 * check that satisfies that rule with `console.log` produces NO LINE AT ALL and
 * is indistinguishable from a check that never adopted the rule.
 *
 * MEASURED, not read from docs — probe test in every workspace, 2026-08-31:
 *
 *   runner                            console on PASS   on FAIL   stdout.write
 *   vitest 4.1.x, all 11 projects     SWALLOWED         visible   visible
 *   node (scripts/*.mjs, CI path)     visible           visible   visible
 *   playwright (list reporter)        visible           visible   visible
 *
 * The mechanism is the reporter, not the environment: `--disableConsoleIntercept`
 * and `--reporter=verbose` both make it reappear, a real TTY does not, and no
 * config in this repo sets `silent`. CI uses the default reporter, so CI is the
 * swallowing case.
 *
 * WHY THE SCOPE IS VITEST ONLY. e2e/ is Playwright and prints console on a
 * passing test — measured above, not assumed. Widening this to e2e/ would flag
 * lines that are genuinely visible. If that measurement ever changes, change it
 * here with a new one beside it.
 *
 * WHY THIS PARSES INSTEAD OF GREPPING. The first version stripped comments and
 * string literals with a hand-written scanner. It reported ZERO on this fixture:
 *
 *     const re = /it's a trap/;
 *     console.log("REAL");
 *
 * — the apostrophe inside the regex opened a string that swallowed the rest of
 * the file, so a real call went unreported and the checker passed. A checker
 * with a silent false negative is the defect it is looking for. TypeScript is
 * already a devDependency, so this walks the real AST: no comment, string,
 * template or regex can hide a call, and `vi.spyOn(console, "error")` is not a
 * call ON console and is not matched, without needing a special case.
 *
 * WHY THE SUBJECT IS THE FILESYSTEM, NOT `git ls-files`. A brand-new test file
 * is exactly when someone writes their first evidence line, and a tracked-files
 * subject cannot see it until it is staged — the blind spot that produced #209.
 * Walking the tree has no such gap, so there is nothing here to report as
 * unseen.
 *
 * THE ESCAPE HATCH TAKES AN ARGUMENT. Failure-path diagnostics are legitimate
 * and visible, so `// swallowed-ok: <reason>` on the call's line or the line
 * above allows one. The reason is REQUIRED: a bare marker is still reported,
 * because an opt-out nobody had to justify is a silencer.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
/** Directories that are build output or vendored code, never authored tests. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "build",
  "playwright-report",
]);

/**
 * The vitest workspaces. e2e/ is deliberately absent — see the docstring.
 * Roots rather than a hardcoded project list, so a NEW app or package is in
 * scope the day it is created; a hand-listed set would expire silently, which
 * is the failure mode #444 was about.
 */
const ROOTS = ["apps", "packages"];

const TEST_FILE = /\.(test|spec)\.(m?[jt]sx?)$/;

export function testFilesUnder(cwd, roots = ROOTS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (TEST_FILE.test(e.name)) {
        out.push(path.relative(cwd, abs));
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(cwd, r);
    try {
      if (statSync(abs).isDirectory()) walk(abs);
    } catch {
      // A fork that ejected a whole root simply has nothing there. Absence of
      // one root is not a failure; absence of EVERY file is, and the caller
      // refuses on that below.
    }
  }
  return out.sort();
}

/** `// swallowed-ok: reason` on this line or the one above, with a real reason. */
function allowedAt(lines, lineNo) {
  const re = /\/\/\s*swallowed-ok\s*:\s*(\S.*)$/;
  for (const l of [lines[lineNo - 1], lines[lineNo - 2]]) {
    if (typeof l === "string" && re.test(l)) return true;
  }
  return false;
}

/**
 * Every call ON the `console` object, by line. Returns [] for a file that
 * parses to nothing; THROWS if TypeScript cannot be loaded, because a checker
 * that cannot parse must refuse rather than report a confident zero.
 */
export async function consoleCallsIn(file, source) {
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lines = source.split("\n");
  const hits = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      const lineNo = line + 1;
      if (!allowedAt(lines, lineNo)) {
        hits.push({ line: lineNo, method: n.expression.name.text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

export async function check({ cwd = process.cwd(), roots = ROOTS } = {}) {
  const files = testFilesUnder(cwd, roots);
  const findings = [];
  for (const rel of files) {
    const src = readFileSync(path.join(cwd, rel), "utf8");
    for (const h of await consoleCallsIn(rel, src))
      findings.push({ file: rel, ...h });
  }
  return { files, findings };
}

async function main() {
  const cwd = process.cwd();
  let result;
  try {
    result = await check({ cwd });
  } catch (e) {
    // REFUSES rather than passes. The common cause is a missing `typescript`,
    // and a parse-less run would otherwise report zero findings over zero
    // parsed files and read exactly like a clean tree.
    console.error(
      `REFUSING: could not scan for swallowed evidence — ${e.message}`
    );
    process.exit(2);
  }

  const { files, findings } = result;
  if (files.length === 0) {
    console.error(
      `REFUSING: found no vitest test files under ${ROOTS.join(", ")}. ` +
        `A scan of nothing reports the same clean result as a scan of everything.`
    );
    process.exit(2);
  }

  if (findings.length > 0) {
    console.error(
      `FAIL: ${findings.length} console call(s) inside vitest tests — ` +
        `output from a PASSING test is swallowed by the default reporter, so ` +
        `each of these is invisible unless the test fails:\n`
    );
    for (const f of findings) {
      console.error(`    ${f.file}:${f.line}  console.${f.method}(...)`);
    }
    console.error(
      `\n  If the line is EVIDENCE (naming the subject so a bare PASS is not\n` +
        `  the whole output): ASSERT it instead — an assertion cannot be\n` +
        `  swallowed, and it fails when the claim stops holding. Where it must\n` +
        `  be printed rather than asserted, use process.stdout.write.\n` +
        `  If it is FAILURE diagnostics, it is already visible: keep it and say\n` +
        `  so with \`// swallowed-ok: <reason>\`.\n` +
        `  If it is left-over debugging, delete it.`
    );
    process.exit(1);
  }

  // NAMES ITS OWN SUBJECT, and this script may do it with console.log because
  // it runs under plain node, where console is visible — measured, and the
  // whole point of the issue.
  console.log(
    `PASS: no console calls in ${files.length} vitest test files across ` +
      `${ROOTS.join(
        ", "
      )} (e2e/ is Playwright and prints console on pass, so ` +
      `it is out of scope by measurement).`
  );
}

if (invokedAsProgram(import.meta.url)) await main();
