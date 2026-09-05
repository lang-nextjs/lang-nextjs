#!/usr/bin/env node
/**
 * assert-error-frame-contract.mjs — THE EMITTER AND THE CLASSIFIER STILL AGREE (#664).
 *
 * `classify-live-failure.mjs` decides whether a red job is a provider outage or a defect here.
 * It does that by scanning the job log for
 *
 *     LIVE_TRANSPORT_ERROR_FRAME <cell> :: <frame JSON>
 *
 * and reading `origin` from the frame. The line is PRODUCED in `e2e/error-frame.ts` and
 * CONSUMED by a regex three directories away. Two halves of a wire format, and until this file
 * nothing asserted they still described the same string.
 *
 * WHY THE DRIFT WOULD BE INVISIBLE. If the emitter changed and the parser did not, every
 * failure would classify as FAILED_UNCLASSIFIED: red, unattributed, "someone must look". That
 * is EXACTLY the honest verdict for a job that genuinely failed before producing a frame —
 * which is the state main is in for 18 of its last 24 runs. The broken case and the working
 * case print the same word. Nobody would investigate a classifier that had stopped classifying,
 * because its output would look like a correct answer about a bad week.
 *
 * HOW IT CHECKS. Not by comparing two regexes for textual equality, which would pass on two
 * patterns that agree about nothing. It renders a line from the ACTUAL template in the emitter,
 * feeds it to the ACTUAL classifier as a log, and asserts the verdict that line should produce.
 * Both directions are exercised, because a parser that answered UPSTREAM_UNAVAILABLE to
 * everything would satisfy a one-sided test while destroying the only distinction that matters.
 *
 * FIXTURE TOKENS, NOT REAL ONES (#496). The classifier is invoked with
 * LIVE_TRANSPORT_SELFTEST=1 so it emits LIVE_TRANSPORT_SELFTEST_VERDICT. Without that this
 * checker would print real verdict lines into a job log, and `verdict-streak.mjs` — which reads
 * job logs for exactly that token — would count a checker's fixtures as run history.
 *
 * Exit codes:  0  the emitter's line is attributed correctly, both ways
 *              1  they have drifted
 *              2  the observation could not be made (a side could not be read)
 *
 * Usage: node scripts/assert-error-frame-contract.mjs [--source e2e/error-frame.ts]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The marker constant, read from the emitter rather than restated here. */
export function extractMarker(src) {
  const m = src.match(/ERROR_FRAME_MARKER\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Render the emitter's own template with concrete values.
 *
 * Extracting the template rather than hardcoding the separator is the point: if someone changes
 * ` :: ` to `|`, the line this builds changes with it and the classifier stops attributing it,
 * which is the drift being tested for. A hardcoded separator here would keep passing.
 */
export function renderEvidence(src, { marker, cell, frame }) {
  const m = src.match(/return\s+`([^`]*)`;/);
  if (!m) return null;
  return m[1]
    .replace("${ERROR_FRAME_MARKER}", marker)
    .replace("${cell}", cell)
    .replace('${frame ?? ""}', frame);
}

const FRAME = (origin) =>
  `data: {"type":"error","errorText":"boom","origin":"${origin}"}`;

/** Run the real classifier over a one-line log and return its verdict. */
export function classify(line) {
  const dir = mkdtempSync(join(tmpdir(), "error-frame-contract-"));
  const log = join(dir, "run.log");
  // Playwright prints assertion messages indented under an Error: heading; the classifier is
  // documented as matching anywhere in the line, and feeding it the bare line would test a
  // shape the real log never contains.
  writeFileSync(log, `  1) some test failed\n    Error: ${line}\n`);
  /*
   * THE CLASSIFIER EXITS NON-ZERO FOR EVERY FAILING VERDICT — 1 for a defect, 3 for
   * upstream-only — which is its contract rather than an error here. execFileSync THROWS on
   * that, and the verdict we came for is on the stdout hanging off the thrown object. Reading
   * it from the error is the normal path in this checker, not the exceptional one.
   */
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/classify-live-failure.mjs"), log, "1"],
      {
        encoding: "utf8",
        env: { ...process.env, LIVE_TRANSPORT_SELFTEST: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (e) {
    // A classifier that could not run at all yields no stdout, which falls through to a null
    // verdict below and is reported as drift rather than mistaken for an answer.
    out = e.stdout ? String(e.stdout) : "";
  }
  const m = out.match(/LIVE_TRANSPORT_SELFTEST_VERDICT verdict=([A-Z_]+)/);
  return m ? m[1] : null;
}

function main() {
  const i = process.argv.indexOf("--source");
  const sourcePath =
    i !== -1 && process.argv[i + 1]
      ? resolve(process.argv[i + 1])
      : join(ROOT, "e2e/error-frame.ts");

  let src;
  try {
    src = readFileSync(sourcePath, "utf8");
  } catch (e) {
    console.error(
      `COULD NOT COMPUTE: ${sourcePath} is unreadable — ${e.message}`
    );
    process.exit(2);
  }

  const marker = extractMarker(src);
  if (!marker) {
    console.error(
      `COULD NOT COMPUTE: no ERROR_FRAME_MARKER literal in ${sourcePath}.\n` +
        `      This checker compares the emitter against the classifier; without the emitter's\n` +
        `      own marker it would be comparing the classifier to a copy of itself.`
    );
    process.exit(2);
  }

  const cases = [
    { origin: "provider", expect: "UPSTREAM_UNAVAILABLE" },
    { origin: "backend", expect: "TRANSPORT_DEFECT" },
  ];

  let failed = 0;
  for (const c of cases) {
    const line = renderEvidence(src, {
      marker,
      cell: "contract/probe",
      frame: FRAME(c.origin),
    });
    if (line === null) {
      console.error(
        `COULD NOT COMPUTE: no template literal found in ${sourcePath}'s emitter.`
      );
      process.exit(2);
    }
    const got = classify(line);
    if (got === c.expect) {
      console.log(`  ok   origin=${c.origin} is attributed ${c.expect}`);
    } else {
      failed++;
      console.error(
        `  FAIL origin=${c.origin}: the classifier answered ${got}, expected ${c.expect}\n` +
          `       line as the emitter renders it: ${line}`
      );
    }
  }

  if (failed) {
    console.error(
      `\nFAIL: the error-frame emitter and classify-live-failure.mjs have DRIFTED.\n` +
        `      Every live failure now classifies as FAILED_UNCLASSIFIED, which is\n` +
        `      indistinguishable from the honest verdict on a job that failed before\n` +
        `      producing a frame. Nothing else would report this.`
    );
    process.exit(1);
  }
  reportSubject(
    cases.length,
    "error-frame origin case(s) put through the classifier"
  );
  console.log(
    `\nok: ${marker} as rendered by the emitter is attributed both ways by the classifier.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
