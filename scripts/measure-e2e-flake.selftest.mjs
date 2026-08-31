#!/usr/bin/env node
/**
 * Proof for measure-e2e-flake.mjs.
 *
 * THE CASE THAT EARNS THIS FILE is the over-capture one. The first version of the parser
 * grepped every `[project] › spec.ts:NNN` in the log and, on a log declaring 2 flaky tests,
 * returned 229 identities — because the reporter also names every test that RAN, plus retries,
 * plus the failure section. The partition it produced would have implicated everything
 * equally, which is indistinguishable from having no partition.
 *
 * So the fixture below is a log that names many tests and declares two flaky, and the parse
 * must yield exactly those two. A synthetic log with only the flaky lines in it would pass
 * against the broken parser and prove nothing.
 *
 * Usage: node scripts/measure-e2e-flake.selftest.mjs
 */
import { parseFlakyBlock, declaredFlakyCount } from "./measure-e2e-flake.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log(`  ok   ${label}`); pass++; }
  else { console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`); fail++; }
};

const P = "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-08-31T20:57:39Z";

/** A log shaped like the real one: many tests run, a failure section, then the flaky block. */
const REALISTIC = [
  `${P}   Running 553 tests using 4 workers`,
  `${P}   [webkit] › e2e/hitl.spec.ts:157:7 › HITL demo › approve: card dismisses`,
  `${P}   [chromium] › e2e/shared/nextjs.spec.ts:167:7 › SPEC-02 › streams`,
  `${P}   [firefox] › e2e/shared/nextjs.spec.ts:167:7 › SPEC-02 › streams`,
  `${P}   [webkit] › e2e/hitl.spec.ts:654:7 › HITL demo › cross-tab`,
  `${P}   1) [webkit] › e2e/hitl.spec.ts:157:7 › HITL demo › approve: card dismisses`,
  `${P}     Error: expect(locator).toBeVisible() failed`,
  `${P}   ##[notice]  2 flaky`,
  `${P}     [webkit] › e2e/hitl.spec.ts:157:7 › HITL demo › approve: card dismisses `,
  `${P}     [webkit] › e2e/hitl.spec.ts:654:7 › HITL demo › cross-tab `,
  `${P}   2 skipped`,
  `${P}   551 passed (7.2m)`,
].join("\n");

console.log("\nmeasure-e2e-flake — the over-capture case\n");

const found = parseFlakyBlock(REALISTIC);
ok("a log naming many tests yields ONLY the flaky ones",
  found.length === 2, `got ${found.length}`);
ok("and they are the right two",
  found.map((f) => f.test).join(",") === "e2e/hitl.spec.ts:157,e2e/hitl.spec.ts:654",
  JSON.stringify(found));
ok("the project is captured, since the partition turns on it",
  found.every((f) => f.project === "webkit"));
ok("the parse agrees with the count the log declares",
  found.length === declaredFlakyCount(REALISTIC));

console.log("\nmeasure-e2e-flake — boundaries\n");

ok("a run with no flaky block yields nothing, not everything",
  parseFlakyBlock(`${P}   553 passed (7.0m)`).length === 0);

/*
 * THE BLOCK MUST END AT THE SUMMARY. Without the terminator the parser would keep reading into
 * whatever follows — on a real log that is the upload steps, and on a multi-job log it would be
 * the NEXT job's test list, silently attributing another job's tests to this one.
 */
const TRAILING = [
  `${P}   ##[notice]  1 flaky`,
  `${P}     [webkit] › e2e/hitl.spec.ts:157:7 › a`,
  `${P}   551 passed (7.2m)`,
  `${P}     [chromium] › e2e/other.spec.ts:1:1 › should NOT be counted`,
].join("\n");
ok("reading stops at the summary line, not at end of log",
  parseFlakyBlock(TRAILING).length === 1, JSON.stringify(parseFlakyBlock(TRAILING)));

ok("declaredFlakyCount reads the number the reporter printed",
  declaredFlakyCount(REALISTIC) === 2 && declaredFlakyCount("nothing here") === 0);

const EXPECTED = 7;
const total = pass + fail;
console.log();
if (total !== EXPECTED) { console.error(`FAIL: ran ${total} checks, expected ${EXPECTED} — the harness is broken.`); process.exit(1); }
if (fail !== 0) { console.error(`FAIL: ${fail}/${total} wrong.`); process.exit(1); }
console.log(
  `PASS: ${pass}/${total}. The parser counts the flaky tests rather than every test that ran,\n` +
    `      stops at the summary rather than absorbing what follows, and is checked against the\n` +
    `      count the reporter itself printed.`
);
