#!/usr/bin/env node
/**
 * PROOF THAT THE RUNG-5 GATE CAN FAIL (#86).
 *
 * WHAT THIS PLANTS, and why it is the right defect to plant. The gate's subject is not "is the
 * crypto correct" — `security-patches.test.mjs` is what asserts that, behaviourally, and it was
 * measured both ways before the gate was written (10/0 patched; 9/1 with the #82 KDF reverted
 * to SHA-256; 7/3 with #84's verify() reverted). Those numbers are in the gate's header.
 *
 * The gate's subject is THE SUMMARY. Its whole reason to exist is that `node --test` exits 0
 * over zero tests, and that during #85's authoring four of ten tests silently skipped while the
 * run reported `6 pass / 0 fail`. So the defect worth planting is a RUN THAT DID NOT HAPPEN
 * WEARING THE COSTUME OF ONE THAT DID — and that is planted here in every form it takes.
 *
 * Deliberately does NOT shell out to yarn. A selftest that needed a three-minute vendored
 * install to prove a parser rejects `# tests 0` would be skipped by whoever is in a hurry, and
 * an unrun proof proves nothing. The expensive real run is the CI job; this is the verdict.
 */
import {
  verdict,
  missingMarkers,
  EXPECTED_TESTS,
} from "./assert-rung5-security-patches.mjs";

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    pass++;
  } else {
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

/** A well-formed summary for `n` tests, all passing. */
const cleanTap = (n = EXPECTED_TESTS) =>
  [
    "TAP version 13",
    `1..${n}`,
    `# tests ${n}`,
    `# suites 0`,
    `# pass ${n}`,
    `# fail 0`,
    `# cancelled 0`,
    `# skipped 0`,
    `# todo 0`,
    "# duration_ms 1081",
  ].join("\n");

/** The same, with individual counters overridden. */
const tapWith = (over) => {
  const base = {
    tests: EXPECTED_TESTS,
    pass: EXPECTED_TESTS,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...over,
  };
  return [
    "TAP version 13",
    `# tests ${base.tests}`,
    `# pass ${base.pass}`,
    `# fail ${base.fail}`,
    `# cancelled ${base.cancelled}`,
    `# skipped ${base.skipped}`,
    `# todo ${base.todo}`,
  ].join("\n");
};

console.log(
  "assert-rung5-security-patches — the gate must refuse a run that did not happen\n"
);

// THE CONTROL. Without it every assertion below could pass by the gate refusing everything,
// which is a gate that cannot go green and therefore cannot report a regression either.
{
  const v = verdict(cleanTap());
  check(
    "a clean full run PASSES",
    v.ok,
    v.problems.join("; ")
  );
}

// THE DEFECT THIS GATE EXISTS FOR. `node --test` exits 0 here.
{
  const v = verdict(tapWith({ tests: 0, pass: 0 }));
  check(
    "zero tests executed is REFUSED",
    !v.ok && v.problems.some((p) => /zero tests/i.test(p))
  );
}

// The exact historical shape from #85: the #84 half absent, summary reading 6 pass / 0 fail.
{
  const v = verdict(tapWith({ tests: 6, pass: 6 }));
  check(
    "a short run (6 of 10, the #85 shape) is REFUSED",
    !v.ok && v.problems.some((p) => /expected exactly/.test(p))
  );
}

{
  const v = verdict(tapWith({ pass: 6, skipped: 4 }));
  check(
    "skipped tests are REFUSED, not counted as passes",
    !v.ok && v.problems.some((p) => /skipped/i.test(p))
  );
}

{
  const v = verdict(tapWith({ pass: 9, todo: 1 }));
  check("todo tests are REFUSED", !v.ok && v.problems.some((p) => /todo/i.test(p)));
}

{
  const v = verdict(tapWith({ pass: 8, cancelled: 2, tests: 10 }));
  check(
    "cancelled tests are REFUSED",
    !v.ok && v.problems.some((p) => /cancelled/i.test(p))
  );
}

// A REAL REGRESSION. This is what a reverted patch looks like once it reaches the summary:
// measured at 9/1 for #82 and 7/3 for #84.
{
  const v = verdict(tapWith({ pass: 9, fail: 1 }));
  check(
    "a failing test is REFUSED (the #82-reverted shape: 9 pass / 1 fail)",
    !v.ok && v.problems.some((p) => /FAILED/.test(p))
  );
}
{
  const v = verdict(tapWith({ pass: 7, fail: 3 }));
  check(
    "the #84-reverted shape (7 pass / 3 fail) is REFUSED",
    !v.ok && v.problems.some((p) => /FAILED/.test(p))
  );
}

// ABSENCE IS NOT ZERO. A crashed or truncated run prints no summary; reading that as "0
// failures" is how a run that never finished becomes a pass. This is the case that would
// survive a naive rewrite of readCount to `?? 0`.
{
  const v = verdict("TAP version 13\n1..10\nok 1 - something\n");
  check(
    "a truncated run with NO summary is REFUSED",
    !v.ok && v.problems.some((p) => /did not finish/.test(p))
  );
}
{
  const v = verdict("");
  check(
    "empty output is REFUSED",
    !v.ok && v.problems.some((p) => /did not finish/.test(p))
  );
}

// Self-inconsistent counters mean the harness is confused, and a summary that disagrees with
// itself is not evidence either way.
{
  const v = verdict(tapWith({ tests: 10, pass: 3, fail: 0 }));
  check(
    "counters that do not add up are REFUSED",
    !v.ok && v.problems.some((p) => /do not add up/.test(p))
  );
}

// ── the gate also checks its own reason to exist ──────────────────────────────
// If the patches are upstreamed and the pin moves past them, the banners go away, the
// behaviour tests keep passing because upstream now does the right thing, and the gate would
// sit green forever guarding a divergence that no longer exists. A "delete me when…" comment
// is documentation; this is enforcement.
{
  const bothPresent = () =>
    "BEGIN lang-nextjs SECURITY PATCH (issue #84)\n" +
    "BEGIN lang-nextjs SECURITY PATCH (issue #82)";
  check(
    "both banners present -> nothing missing",
    missingMarkers(bothPresent).length === 0
  );
}
{
  // One patch upstreamed: the tests would still pass, so only this catches it.
  const only82 = (rel) =>
    rel.includes("crypto")
      ? "BEGIN lang-nextjs SECURITY PATCH (issue #82)"
      : "// upstream now verifies signatures itself";
  const gone = missingMarkers(only82);
  check(
    "a removed banner is REFUSED even though the tests would still pass",
    gone.length === 1 && gone[0].issue === "#84"
  );
}
{
  // A deleted file is the same verdict as a file without the banner: absent either way.
  const gone = missingMarkers(() => null);
  check("a missing patched file is REFUSED", gone.length === 2);
}

// NON-VACUITY OF THIS FILE. If the suite ever stops running its own cases, the count guard
// below fails rather than reporting a cheerful 0/0 — the same defect it was written to catch,
// in the mechanism that catches it.
const EXPECTED_CASES = 14;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — this selftest is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong. The rung-5 gate is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The gate refuses zero tests, a short run, skips, todos,\n` +
    `      cancellations, real failures, and a missing summary — so its green means a run\n` +
    `      actually happened — and it refuses a vanished divergence, so its green also\n` +
    `      means there is still something here to guard.`
);
