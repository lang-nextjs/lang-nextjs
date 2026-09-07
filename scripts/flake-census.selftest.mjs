#!/usr/bin/env node
/**
 * PROOF FOR flake-census.mjs — it names the spec, keeps a SAID zero distinct from an absent
 * reading, and is not fooled by the other producer writing the same words into the same log.
 *
 * THE CASE THAT MATTERS MOST IS THE ANCHORING ONE. `summarise-flaky.mjs` prints
 * `SUBJECT: 1 flaky test(s) …` and Playwright's list reporter prints `  1 flaky` — the same
 * substring, the same log, different producers and different meanings. A pattern of
 * `\d+ flaky` matches both, selects the wrong one, and returns a census with no spec names
 * and no error. That is not hypothetical: it is exactly what happened while this was being
 * built, and it returned an EMPTY result rather than a wrong one, which is the only reason
 * it was noticed.
 *
 * So the negative arm below feeds a `SUBJECT:` line to Playwright's pattern and asserts it
 * does NOT match. Without it, `^\s*\d+ flaky\s*$` looks like a needlessly fussy regex and
 * the next reader simplifies it.
 *
 * THE SECOND CASE THAT MATTERS is a log with no SUBJECT line at all. That must be UNKNOWN,
 * never zero — the census exists because a green run and an unread run were indistinguishable,
 * and a census that reproduced that would be a downgrade from the count it replaces.
 *
 * WHAT THESE ARMS ARE AND ARE NOT. They are fixtures, so they assert the parser handles what
 * its author believes the log looks like — which is exactly the weakness a fixture always has.
 * The parser was ALSO driven over four real captured job logs during development (a zero-flake
 * run, `e4d168f7` naming `:153`, `ee12800b` naming two, `828d6f65` naming `:190`) and
 * reproduced the `:190` -> `:153` transition. That is not asserted here because this suite must
 * not depend on network fixtures; it is recorded so nobody mistakes these arms for evidence
 * about real logs.
 */
import { readFlakeReport, stripLogPrefix } from "./flake-census.mjs";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} — ${JSON.stringify(detail)?.slice(0, 240)}`);
  }
};

const TS = "2026-09-07T17:02:37.0176078Z ";
const PW_SUMMARY_ONE = [
  `${TS}  1 flaky`,
  `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:153:7 › queue — a failed poll`,
  `${TS}  4 skipped`,
  `${TS}  603 passed (7.4m)`,
].join("\n");
const SUBJECT = (n) =>
  `${TS}SUBJECT: ${n} flaky test(s) surfaced from Playwright's own report`;

console.log("\nflake-census.mjs\n");

ok(
  "a SAID zero is a reading — SUBJECT: 0 with no Playwright block is counted, not unknown",
  (() => {
    const r = readFlakeReport(SUBJECT(0));
    return r.state === "counted" && r.count === 0 && r.specs.length === 0;
  })(),
  readFlakeReport(SUBJECT(0))
);

ok(
  "a flake is NAMED, not just counted",
  (() => {
    const r = readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`);
    return (
      r.state === "counted" &&
      r.count === 1 &&
      r.specs.length === 1 &&
      r.specs[0] === "e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:153:7"
    );
  })(),
  readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`)
);

/*
 * THE ONE THE WHOLE CENSUS RESTS ON. No SUBJECT line means the summariser did not run or
 * could not read — which is not the same as it running and finding nothing.
 */
ok(
  "NO SUBJECT line is UNKNOWN, never zero",
  (() => {
    const r = readFlakeReport(`${TS}603 passed (7.4m)`);
    return r.state === "unreadable" && r.count === null;
  })(),
  readFlakeReport(`${TS}603 passed (7.4m)`)
);

/*
 * THE ANCHORING NEGATIVE. `SUBJECT: 1 flaky test(s) …` must not be read as Playwright's
 * summary line, or the parser harvests spec names from the wrong block — or, as happened,
 * from no block at all and reports a count with an empty name list.
 */
ok(
  "a SUBJECT line is NOT mistaken for Playwright's summary — the anchor is load-bearing",
  (() => {
    const decoyed = [
      SUBJECT(1),
      `${TS}    [open-swe] › e2e/DECOY-should-not-be-harvested.spec.ts:1:1 › decoy`,
      `${TS}  603 passed (7.4m)`,
    ].join("\n");
    const r = readFlakeReport(decoyed);
    // The SUBJECT line did not open a Playwright block, so no name is harvested…
    return r.specs.length === 0 && r.disagreement !== null;
  })(),
  readFlakeReport(
    [
      SUBJECT(1),
      `${TS}    [open-swe] › e2e/DECOY-should-not-be-harvested.spec.ts:1:1 › decoy`,
      `${TS}  603 passed (7.4m)`,
    ].join("\n")
  )
);

/*
 * …and when they disagree, that is REPORTED rather than resolved. Picking a winner would
 * hide the run where one of the two producers is broken, which is the run worth seeing.
 */
ok(
  "a count with no matching names is a DISAGREEMENT, not a silent zero",
  (() => {
    const r = readFlakeReport(SUBJECT(2));
    return (
      r.count === 2 &&
      r.specs.length === 0 &&
      /counted 2/.test(r.disagreement ?? "")
    );
  })(),
  readFlakeReport(SUBJECT(2))
);

ok(
  "two flakes are named separately and agree with the count",
  (() => {
    const two = [
      SUBJECT(2),
      `${TS}  2 flaky`,
      `${TS}    [chromium] › e2e/api/keys.spec.ts:120:7 › GET /api/keys`,
      `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:190:7 › queue`,
      `${TS}  601 passed (7.1m)`,
    ].join("\n");
    const r = readFlakeReport(two);
    return r.count === 2 && r.specs.length === 2 && r.disagreement === null;
  })(),
  readFlakeReport(
    [
      SUBJECT(2),
      `${TS}  2 flaky`,
      `${TS}    [chromium] › e2e/api/keys.spec.ts:120:7 › GET /api/keys`,
      `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:190:7 › queue`,
      `${TS}  601 passed (7.1m)`,
    ].join("\n")
  )
);

ok(
  "the GitHub log prefix is stripped, including the job/step columns before the timestamp",
  stripLogPrefix(
    "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-09-07T17:02:37.0Z   1 flaky"
  ) === "  1 flaky",
  stripLogPrefix(
    "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-09-07T17:02:37.0Z   1 flaky"
  )
);

const total = pass + fail;
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. It names the spec, keeps a SAID zero distinct from an absent\n` +
    `      reading, refuses to harvest names from the other producer's line, and reports a\n` +
    `      disagreement between the two rather than choosing one.`
);
