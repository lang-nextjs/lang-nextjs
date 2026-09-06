#!/usr/bin/env node
/**
 * assert-hitl-card-budget.mjs — the E2E card budget still covers the proxy's frame
 * release, and the per-test timeout still covers the card budget (#675).
 *
 * WHY THIS EXISTS. `expectApprovalCard` waited 15_000 + 15_000 = 30_000ms for an approval
 * card that, on an engine whose pipeline surfaces a mid-stream data-* part only at stream
 * end, cannot appear before the proxy releases its buffered frames:
 *
 *     upstream close          ~8_590 ms
 *     DEFAULT_DRAIN_GRACE_MS   30_000 ms
 *     frame release            38_590 ms
 *
 * THE BUDGET WAS SMALLER THAN THE GRACE ALONE, before the upstream close was added at all.
 * Five specs failed in one night on branches whose content cannot reach a WebKit HITL test,
 * each needing a manual re-run, and each was read as a browser flake — 38017ms looks like a
 * property of WebKit until you notice it is 8_590 + 30_000 and that both terms are chosen.
 *
 * THE NUMBERS ARE THE PART THAT EXPIRES. Three of them can move independently: the mock's
 * upstream close, the server's default grace, and how long setup takes on a loaded runner.
 * A relationship derived once and left in prose survives exactly until the first of those
 * changes, and nothing notices — the failure reappears wearing its old costume, as an
 * intermittent browser flake. So the derivation is asserted rather than recorded.
 *
 * TWO OF THE THREE ARE READ; THE THIRD IS NOT, AND THAT IS A REAL HOLE. `upstreamClose` and
 * `grace` are read from source, so a change to either moves the comparison. SETUP_ALLOWANCE_MS
 * is hardcoded below and exists nowhere else — if setup slows on a loaded runner, which is
 * exactly the third failure mode named above, inequality 2 keeps passing while the real
 * headroom is gone. The checker cannot detect a change in the one term it invents.
 *
 * IT IS NOT GUARDED HERE BECAUSE THE ALTERNATIVE IS WORSE. There is no declaration to read,
 * and inventing a source to point at would make the gap invisible instead of merely present.
 * The current headroom is 15_600ms, so setup must nearly triple before it bites. Recorded
 * rather than fixed, and recorded HERE rather than in a review comment, because a reader who
 * trusts "the derivation is asserted rather than recorded" will otherwise assume all three
 * terms are. Found by ARCHITECT.
 *
 * IT READS SOURCE TEXT ON PURPOSE. The e2e specs import nothing from packages/, and adding
 * that seam at runtime to relate two integers would be a larger change than the one being
 * guarded. Reading the declarations couples the values without coupling the build.
 *
 * Usage: node scripts/assert-hitl-card-budget.mjs [--root <dir>]
 * Exit: 0 the budget covers the release · 1 it does not · 2 a value could not be read
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = (() => {
  const i = process.argv.indexOf("--root");
  return i !== -1
    ? process.argv[i + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..");
})();

/**
 * Each declared value, with the file it is declared in. A missing one is a REFUSAL and not
 * a failure: a checker that reads 0 for a constant it could not find would compare against
 * a number nobody wrote, and would then pass or fail for reasons unrelated to the property.
 */
const SOURCES = [
  {
    key: "upstreamClose",
    file: "e2e/hitl.spec.ts",
    re: /const CARD_UPSTREAM_CLOSE_MS\s*=\s*([\d_]+)/,
  },
  {
    key: "base",
    file: "e2e/hitl.spec.ts",
    re: /const CARD_BASE_MS\s*=\s*([\d_]+)/,
  },
  {
    key: "extension",
    file: "e2e/hitl.spec.ts",
    re: /const CARD_EXTENSION_MS\s*=\s*([\d_]+)/,
  },
  {
    key: "grace",
    file: "packages/server/src/approval-gating.ts",
    re: /export const DEFAULT_DRAIN_GRACE_MS\s*=\s*([\d_]+)/,
  },
  {
    key: "perTest",
    file: "playwright.config.ts",
    re: /^\s*timeout:\s*([\d_]+),/m,
  },
];

/** Measured: goto + submit + the frames before the card is waited on. */
export const SETUP_ALLOWANCE_MS = 9_000;
/** The release time is measured, so require headroom rather than a bare inequality. */
export const MARGIN = 1.1;

export function readValues(root, read = readFileSync) {
  const out = {};
  const missing = [];
  for (const s of SOURCES) {
    const path = join(root, s.file);
    let text;
    try {
      text = read(path, "utf8");
    } catch {
      missing.push(`${s.file} could not be read`);
      continue;
    }
    const m = s.re.exec(text);
    if (!m) {
      missing.push(`${s.key} not found in ${s.file} (pattern ${s.re})`);
      continue;
    }
    out[s.key] = Number(m[1].replace(/_/g, ""));
  }
  return { values: out, missing };
}

export function complaints(v) {
  const bad = [];
  const release = v.upstreamClose + v.grace;
  const budget = v.base + v.extension;

  if (budget < release * MARGIN)
    bad.push(
      `the card budget is ${budget}ms and the proxy releases frames at ${release}ms ` +
        `(${v.upstreamClose} upstream close + ${v.grace} drain grace). Required: ` +
        `${Math.ceil(
          release * MARGIN
        )}ms, which is ${release}ms plus ${Math.round(
          (MARGIN - 1) * 100
        )}% margin.\n` +
        `     RAISE CARD_EXTENSION_MS, NOT CARD_BASE_MS. The base is what EXTENSION_MARKER ` +
        `fires on, so raising it silences every occurrence between the old and new floor — ` +
        `the fix would work by making the finding invisible.`
    );

  if (v.perTest < (SETUP_ALLOWANCE_MS + budget) * MARGIN)
    bad.push(
      `the per-test timeout is ${v.perTest}ms but a test may spend ` +
        `${SETUP_ALLOWANCE_MS}ms on setup and then ${budget}ms waiting for the card ` +
        `(${SETUP_ALLOWANCE_MS + budget}ms total).\n` +
        `     A test that hits the Playwright timeout reports an OPAQUE expiry. The card ` +
        `helper's give-up message — the wire dump, frame counts and timing block — is the ` +
        `only thing that makes these failures classifiable, and it is never printed.`
    );

  return bad;
}

const { values, missing } = readValues(ROOT);
if (missing.length > 0) {
  console.error(
    `REFUSE: ${missing.length} declared value(s) could not be read, so the budget was ` +
      `compared against nothing.`
  );
  missing.forEach((m) => console.error(`   - ${m}`));
  console.error(
    `\n        A constant that moved or was renamed reads here as absent. Exiting 2: the\n` +
      `        question could not be asked, which is not the same as the answer being yes.`
  );
  process.exit(2);
}

const problems = complaints(values);
if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} budget relationship(s) do not hold:`);
  problems.forEach((p) => console.error(`   - ${p}`));
  process.exit(1);
}

reportSubject(
  SOURCES.length,
  "declared timing constant(s) related across e2e, packages/server and playwright.config"
);
console.log(
  `PASS: card budget ${
    values.base + values.extension
  }ms covers a frame release at ` +
    `${values.upstreamClose + values.grace}ms, and the ${
      values.perTest
    }ms per-test timeout ` +
    `covers setup plus that budget.`
);
