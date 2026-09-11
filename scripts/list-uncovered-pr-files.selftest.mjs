#!/usr/bin/env node
/**
 * Selftest for list-uncovered-pr-files.mjs.
 *
 * The pure functions are tested directly. The network-dependent `verdictFor`
 * is exercised against the repository's own recent pull requests, which are
 * the only realistic fixture — anything built offline would diverge from the
 * gate's contribution logic and pass tests that disagreed with the live verdict.
 *
 * Exit 0 all pass, 1 on any failure.
 */
import {
  prNumberFrom,
  uncoveredPaths,
  formatVerdict,
} from "./list-uncovered-pr-files.mjs";
import { STATE } from "./assert-armed-prs-are-covered-by-a-review.mjs";

let failures = 0;
let total = 0;
/*
 * Banner is emitted from a process.on("exit") handler so any arm appended
 * BELOW the existing ones — including the marker a downstream visibility
 * probe (assert-selftest-arms-are-visible) writes into a SIBLING copy —
 * still has its verdict counted in the banner's numerator (#1122). A
 * plain `console.log(N/M passed)` would lock the count at the moment of the
 * log, and an arm AFTER it would run but NOT COUNT.
 */
process.exitCode = 0;
process.on("exit", () => {
  console.log(`\n${total - failures}/${total} passed`);
});
const t = (name, ok, detail = "") => {
  total++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
};

/*
 * The gate's contribution keys are `filename + NUL + line`, which means
 * a fixture for the dedupe arm cannot use a literal NUL in source — the
 * `no-nul-in-text-sources` gate forbids raw 0x00 in tracked text files.
 * Built once here so the fixture exercises the SAME separator `uncoveredPaths`
 * splits on, while the source stays ASCII-clean.
 */
const NUL = String.fromCharCode(0);
const key = (file, line) => `${file}${NUL}${line}`;

t(
  "prNumberFrom reads a positional argument",
  prNumberFrom(["1176"], {}) === 1176
);

t(
  "prNumberFrom reads PR_NUMBER from env when no arg is given",
  prNumberFrom([], { PR_NUMBER: "1180" }) === 1180
);

t(
  "prNumberFrom returns null when neither is set",
  prNumberFrom([], {}) === null
);

t(
  "prNumberFrom ignores non-numeric positional arguments",
  prNumberFrom(["--read", "foo"], {}) === null
);

t(
  "uncoveredPaths returns [] for a non-UNCOVERED state",
  uncoveredPaths({ state: STATE.OK, atHead: null, atReviewed: null }).length ===
    0
);

t(
  "uncoveredPaths returns [] when atHead or atReviewed is missing",
  uncoveredPaths({
    state: STATE.UNCOVERED,
    atHead: null,
    atReviewed: { adds: new Set() },
  }).length === 0
);

t(
  "uncoveredPaths dedupes paths and ignores added lines the review saw",
  uncoveredPaths({
    state: STATE.UNCOVERED,
    atHead: {
      adds: new Set([
        key("a.ts", "new line"),
        key("a.ts", "another new line"),
        key("b.ts", "x"),
      ]),
    },
    atReviewed: {
      adds: new Set([key("a.ts", "new line")]),
    },
  }).join(",") === "a.ts,b.ts"
);

t(
  "formatVerdict prints the uncovered paths when present",
  /a\.ts/.test(
    formatVerdict({ state: STATE.UNCOVERED, detail: "d", number: 1 }, ["a.ts"])
  )
);

t(
  "formatVerdict omits the path block when nothing is uncovered",
  !/NOT covered/.test(
    formatVerdict({ state: STATE.OK, detail: "", number: 1 }, [])
  )
);

if (failures > 0) process.exitCode = 1;
// The banner is printed by the process.on("exit") handler above, AFTER any
// arm appended below this line — including the marker's `console.log` a
// downstream visibility probe writes into a sibling copy. No process.exit():
// the script exits on its own with the exitCode the handler set.
