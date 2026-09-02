#!/usr/bin/env node
/**
 * Proof for assert-error-frame-contract.mjs.
 *
 * THE DEFECT THIS CHECKER EXISTS FOR IS INVISIBLE, which is why the proof matters more than
 * usual. If the emitter and the classifier drift, every live failure classifies as
 * FAILED_UNCLASSIFIED — and that is the SAME WORD the classifier correctly prints for a job
 * that failed before producing any frame, which is main's actual state for 18 of its last 24
 * runs. A broken classifier and a bad week are spelled identically. So a checker that could not
 * fail would be indistinguishable from one reporting good news, and nobody would look.
 *
 * Every case below PLANTS the drift in a fixture emitter and requires the checker to catch it.
 * Adding this file without planting defects would be the thing CONTRIBUTING.md's house rule
 * forbids.
 *
 * Usage: node scripts/assert-error-frame-contract.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-error-frame-contract.mjs");

let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label}${
        got !== undefined ? ` — got ${JSON.stringify(got)}` : ""
      }`
    );
    fail++;
  }
};

/** A fixture emitter with a chosen marker and template. */
function emitter({
  marker = "LIVE_TRANSPORT_ERROR_FRAME",
  template = '${ERROR_FRAME_MARKER} ${cell} :: ${frame ?? ""}',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "error-frame-fixture-"));
  const f = join(dir, "error-frame.ts");
  writeFileSync(
    f,
    `export const ERROR_FRAME_MARKER = "${marker}";\n` +
      `export function errorFrameEvidence(cell: string, frame: string | null): string {\n` +
      `  return \`${template}\`;\n` +
      `}\n`
  );
  return f;
}

const run = (src) =>
  spawnSync(process.execPath, [CHECKER, "--source", src], { encoding: "utf8" });

console.log("\nthe contract holds when both sides agree\n");

let r = run(emitter());
ok("an unmodified emitter is attributed both ways", r.status === 0, r.status);
ok(
  "...and says so rather than passing silently",
  /attributed both ways/.test(r.stdout)
);

console.log(
  "\nPLANTED DRIFT — each must be caught, and caught as 1 rather than 2\n"
);

/*
 * THE SEPARATOR. The classifier matches ` :: ` between cell and frame. An emitter that switched
 * to `|` would still print a line containing the marker and the frame, and a checker comparing
 * only the marker would pass it. The frame would then be invisible to attribution.
 */
r = run(
  emitter({ template: '${ERROR_FRAME_MARKER} ${cell} | ${frame ?? ""}' })
);
ok("a changed SEPARATOR is caught", r.status === 1, r.status);
ok(
  "...and is named as drift, not as a could-not-compute",
  /DRIFTED/.test(r.stderr),
  r.stderr.slice(0, 80)
);

/*
 * THE MARKER. A rename on the emitting side alone silently ends all attribution.
 */
r = run(emitter({ marker: "LIVE_TRANSPORT_ERROR_EVENT" }));
ok("a renamed MARKER is caught", r.status === 1, r.status);

/*
 * A frame the classifier cannot find at all, because the template dropped it.
 */
r = run(emitter({ template: "${ERROR_FRAME_MARKER} ${cell} :: (redacted)" }));
ok("a template that drops the frame is caught", r.status === 1, r.status);

console.log(
  "\nREFUSAL — 'I could not ask' must never be spelled like 'I asked and it was fine'\n"
);

/*
 * 1 MEANS VIOLATED AND 2 MEANS UNANSWERABLE, the split 37 scripts in this directory use. A
 * checker that returned 1 for an unreadable source would send someone hunting a drift that is
 * not there; one that returned 0 would report a contract it never tested.
 */
const noMarker = mkdtempSync(join(tmpdir(), "error-frame-fixture-"));
const bare = join(noMarker, "error-frame.ts");
writeFileSync(bare, "export const SOMETHING_ELSE = 1;\n");
r = run(bare);
ok("a source with no marker is exit 2, not 1", r.status === 2, r.status);
ok("...and says COULD NOT COMPUTE", /COULD NOT COMPUTE/.test(r.stderr));

r = run(join(noMarker, "does-not-exist.ts"));
ok("an unreadable source is exit 2, not 1", r.status === 2, r.status);

/*
 * AND THE REAL EMITTER IS ONE OF THE CASES. Every assertion above runs against fixtures, so all
 * of them would stay green if e2e/error-frame.ts were deleted tomorrow.
 */
r = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
ok("the REAL emitter in the tree satisfies the contract", r.status === 0, {
  status: r.status,
  stderr: r.stderr.slice(0, 200),
});

const EXPECTED = 10;
const total = pass + fail;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail ? 1 : 0);
