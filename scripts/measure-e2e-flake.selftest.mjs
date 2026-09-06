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
import {
  parseFlakyBlock,
  declaredFlakyCount,
  parseExtensionMarkers,
  defaultBaseFrom,
  partitionByBase,
  absorbedSummary,
} from "./measure-e2e-flake.mjs";

let pass = 0,
  fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    fail++;
  }
};

const P =
  "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-08-31T20:57:39Z";

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
ok(
  "a log naming many tests yields ONLY the flaky ones",
  found.length === 2,
  `got ${found.length}`
);
ok(
  "and they are the right two",
  found.map((f) => f.test).join(",") ===
    "e2e/hitl.spec.ts:157,e2e/hitl.spec.ts:654",
  JSON.stringify(found)
);
ok(
  "the project is captured, since the partition turns on it",
  found.every((f) => f.project === "webkit")
);
ok(
  "the parse agrees with the count the log declares",
  found.length === declaredFlakyCount(REALISTIC)
);

console.log("\nmeasure-e2e-flake — boundaries\n");

ok(
  "a run with no flaky block yields nothing, not everything",
  parseFlakyBlock(`${P}   553 passed (7.0m)`).length === 0
);

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
ok(
  "reading stops at the summary line, not at end of log",
  parseFlakyBlock(TRAILING).length === 1,
  JSON.stringify(parseFlakyBlock(TRAILING))
);

ok(
  "declaredFlakyCount reads the number the reporter printed",
  declaredFlakyCount(REALISTIC) === 2 &&
    declaredFlakyCount("nothing here") === 0
);

/*
 * ── THE ABSORBED PARTITION (#675) ─────────────────────────────────────────────
 *
 * `expectApprovalCard` now extends its wait once when the stream is still in
 * flight at the base deadline. That turns an occurrence into a PASS, so it
 * leaves the flaky block entirely — and the rate this whole issue rests on would
 * quietly go to zero and read as a cure.
 *
 * These cases are the reason the remedy is not a mute button. If they go, the
 * measurement goes with them.
 */
const ABSORBED = [
  `${P}   Running 553 tests using 4 workers`,
  `${P}   [chromium] › e2e/hitl.spec.ts:157:7 › ran fine, must NOT be counted`,
  `${P}   [#675-EXTENSION] [webkit] › e2e/hitl.spec.ts:635 base=15000ms status="Status: streaming" ai-msg=1 tool-call-msg=0`,
  `${P}   [#675-EXTENSION] [webkit] › e2e/hitl.spec.ts:635 card appeared during the extension (total <= 30000ms) — occurrence absorbed, still counted`,
  `${P}   573 passed (6.9m)`,
].join("\n");

ok(
  "an absorbed occurrence is counted",
  parseExtensionMarkers(ABSORBED).length === 1,
  JSON.stringify(parseExtensionMarkers(ABSORBED))
);
ok(
  "and it carries the project and test, so it partitions like the flaky rows",
  parseExtensionMarkers(ABSORBED)[0]?.project === "webkit" &&
    parseExtensionMarkers(ABSORBED)[0]?.test === "e2e/hitl.spec.ts:635"
);
/*
 * THE PAIRED LINE IS THE TRAP. The helper logs twice per occurrence — once on
 * giving up on the base deadline, once when the card lands. Counting both would
 * report exactly double, which is the kind of wrong that looks plausible.
 */
ok(
  "the closing line does not double the count",
  parseExtensionMarkers(ABSORBED).filter(
    (r) => r.test === "e2e/hitl.spec.ts:635"
  ).length === 1
);
/*
 * The two partitions must not contaminate each other: a log with only flaky
 * rows has no absorbed occurrences, and a log with only markers has no flaky.
 * Each assertion is paired with the positive control that proves the parser was
 * looking at that log at all.
 */
ok(
  "the two partitions are disjoint, and neither is vacuous",
  parseExtensionMarkers(REALISTIC).length === 0 &&
    parseFlakyBlock(REALISTIC).length === 2 &&
    parseFlakyBlock(ABSORBED).length === 0 &&
    parseExtensionMarkers(ABSORBED).length === 1
);

/*
 * #818 — THE MARKER DOES NOT SAY WHICH POPULATION IT BELONGS TO UNTIL `base=` IS READ.
 *
 * Two tests in hitl.spec.ts call the helper with an explicit 2000ms base and so
 * emit this marker DETERMINISTICALLY as part of passing: :794 (a completed stream
 * with no approval frame — the card can never arrive, and it runs on all three
 * projects matching the spec) and :858 (a route held past the base, chromium only).
 * Four opening markers per full run, none of them an occurrence of #675.
 *
 * The parser used to discard `base=`, so both populations arrived at the reporter
 * already summed and every rate derived from the total was inflated by that
 * constant — which dominates exactly when the live rate is low.
 */
const P818 = "2026-01-01T00:00:00.0000000Z";
const LIVE_LINE =
  `${P818} [#675-EXTENSION] [webkit] › e2e/hitl.spec.ts:635 ` +
  `base=15000ms status="Status: streaming" ai-msg=1 tool-call-msg=0`;
const FIXTURE_LINE =
  `${P818} [#675-EXTENSION] [chromium] › e2e/hitl.spec.ts:858 ` +
  `base=2000ms status="Status: streaming" ai-msg=0 tool-call-msg=0`;

ok(
  "a live occurrence and a fixture occurrence land in DIFFERENT buckets",
  (() => {
    const got = parseExtensionMarkers([LIVE_LINE, FIXTURE_LINE].join("\n"));
    const { live, instrumented } = partitionByBase(got, 15000);
    return (
      live.length === 1 &&
      live[0].base === 15000 &&
      instrumented.length === 1 &&
      instrumented[0].base === 2000
    );
  })(),
  JSON.stringify(parseExtensionMarkers([LIVE_LINE, FIXTURE_LINE].join("\n")))
);

/*
 * A MARKER WITH NO `base=` IS THE CASE THIS CANNOT ANSWER, and bucketing it either
 * way manufactures a number — into live it inflates the rate the issue exists to
 * measure, into fixture it hides a real occurrence. It must refuse, not default.
 */
ok(
  "a marker line with no `base=` field is REFUSED rather than bucketed",
  (() => {
    try {
      parseExtensionMarkers(
        `${P818} [#675-EXTENSION] [webkit] › e2e/hitl.spec.ts:635 status="idle"`
      );
      return false;
    } catch (e) {
      /*
       * THE MESSAGE, NOT MERELY THAT IT THREW. Removing the guard does not make
       * this pass silently — it makes `b[1]` dereference null and throw a
       * TypeError, which a bare `catch { return true }` accepts as success. So the
       * arm proved the code CRASHES, not that it REFUSES, and a mutation deleting
       * the refusal survived it. Asserting the sentence pins the deliberate one.
       */
      return (
        e instanceof Error &&
        !(e instanceof TypeError) &&
        /carries no .?base=/.test(e.message)
      );
    }
  })()
);

ok(
  "COMPANION: a well-formed line does NOT refuse — the guard is not refusing everything",
  parseExtensionMarkers(LIVE_LINE).length === 1,
  JSON.stringify(parseExtensionMarkers(LIVE_LINE))
);

/*
 * THE DEFAULT BASE IS READ FROM ITS DECLARATION rather than copied here. A literal
 * 15000 in the counter is a second declaration of a fact owned by the spec, and the
 * copy that rots is the one nothing checks: tune CARD_BASE_MS and every live
 * occurrence starts arriving with an unrecognised base, silently reclassifying the
 * whole live population as fixture noise. That failure inverts the finding.
 */
ok(
  "the default base is parsed from the spec, underscores and all",
  defaultBaseFrom("const CARD_BASE_MS = 15_000;") === 15000,
  String(defaultBaseFrom("const CARD_BASE_MS = 15_000;"))
);

ok(
  "and a spec with no CARD_BASE_MS declaration is REFUSED, not defaulted to 15000",
  (() => {
    try {
      defaultBaseFrom("const SOMETHING_ELSE = 1;");
      return false;
    } catch {
      return true;
    }
  })()
);

ok(
  "a log of nothing but fixture markers reports ZERO live occurrences",
  (() => {
    const got = parseExtensionMarkers([FIXTURE_LINE, FIXTURE_LINE].join("\n"));
    return partitionByBase(got, 15000).live.length === 0 && got.length === 2;
  })()
);
/*
 * THE REPORTER IS THE THING THAT GETS QUOTED, so the proof has to reach it. A
 * correct parser does not stop the summary adding the two populations back
 * together, and built inline inside main() that line was unreachable from here.
 */
const S818 = absorbedSummary({
  live: [{ run: 1 }, { run: 1 }, { run: 2 }],
  instrumented: [{ run: 1 }, { run: 2 }, { run: 3 }, { run: 4 }],
  defaultBase: 15000,
  concluded: 12,
});

ok(
  "the summary prints the two counts SEPARATELY, each with its own run denominator",
  /LIVE\s+: 3 in 2\/12/.test(S818) && /FIXTURE\s+: 4 in 4\/12/.test(S818),
  S818
);

ok(
  "and it never prints their SUM — the single figure every inflated rate came from",
  !/\b7\b/.test(S818),
  S818
);
const EXPECTED = 19; // 11 + 8 for #818
const total = pass + fail;
console.log();
/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `FAIL: ran ${ran} checks, expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The parser counts the flaky tests rather than every test that ran,\n` +
    `      stops at the summary rather than absorbing what follows, and is checked against the\n` +
    `      count the reporter itself printed. The #675 absorbed partition is counted once per\n` +
    `      occurrence and stays disjoint from the flaky one.`
);
