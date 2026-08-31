#!/usr/bin/env node
/**
 * Proof for assert-behavioural-evidence.mjs.
 *
 * The REJECT cases are the two real instances, verbatim. The ACCEPT cases matter as much: this
 * rule runs over every requirements table in .planning, so anything it mistakes for a
 * behavioural claim is a red about nothing, and a rule that cries wolf gets muted.
 *
 * ONE CASE PINS A KNOWN LIMITATION RATHER THAN A CAPABILITY -- the "near-miss" from #453, which
 * this rule ADMITS. It is here so the gap is a fixture someone can see, not a sentence in a
 * header that nobody re-reads.
 *
 * Usage: node scripts/assert-behavioural-evidence.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "assert-behavioural-evidence.mjs");
const TMP = mkdtempSync(join(tmpdir(), "behev-"));
let pass = 0, fail = 0;

/** A tree with one barrel and one requirements table. */
function sandbox(rows, { barrel = ["createApprovalGatingTransform", "createApprovalRoutes", "ApprovalGatingConfig", "createDeepAgentsResumeHandler", "isStreamReconnectEnabled"], baseline = null } = {}) {
  const dir = mkdtempSync(join(TMP, "case-"));
  const pkg = join(dir, "packages", "server", "src");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "index.ts"), barrel.map((s) => `export { ${s} } from "./x";`).join("\n"));
  const plan = join(dir, ".planning", "phases");
  mkdirSync(plan, { recursive: true });
  const table = [
    "| Requirement | Description | Status | Evidence |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.desc} | ✓ SATISFIED | ${r.evid} |`),
  ].join("\n");
  writeFileSync(join(plan, "x-VERIFICATION.md"), `# V\n\n${table}\n`);
  if (baseline) writeFileSync(join(dir, "scripts-baseline.tmp"), "");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "behavioural-evidence-baseline.json"),
    JSON.stringify(baseline ?? { known: [], positiveControls: [] })
  );
  return dir;
}

function run(dir) {
  try {
    return { rc: 0, out: execFileSync("node", [CHECKER, "--cwd", dir, "--list"], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, rows, opts, mustSay = []) {
  const { rc, out } = run(sandbox(rows, opts));
  const got = rc === 0 ? "accept" : rc === 2 ? "vacuous" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) { console.log(`  ok   ${label.padEnd(62)} (${want})`); pass++; }
  else {
    console.error(`  FAIL ${label} — wanted ${want}, got ${got} (rc=${rc}), named=${said}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

console.log("\nassert-behavioural-evidence — REJECT (the two real instances)\n");

// ADAPT-05, verbatim from v1.5-02-VERIFICATION.md:61.
expect(
  "ADAPT-05's real evidence: exports + handler option + 234 tests",
  "reject",
  [{
    id: "ADAPT-05",
    desc: "Developer can gate tool execution — adapter emits a `data-approval-required` frame; the run pauses until an explicit approval or rejection is sent back by the handler",
    evid: "All three plans executed: v1.5-02-01 (37 RED tests), v1.5-02-02 (GREEN implementation), v1.5-02-03 (route factory + exports). Server package exports `createApprovalGatingTransform`, `createApprovalRoutes`, `ApprovalGatingConfig`. Handler option available. All 234 server tests pass",
  }],
  {},
  ["ADAPT-05", "OBSERVABLE"]
);

// The v1.3 shape: a behavioural reconnect criterion closed by barrel exports.
expect(
  "a reconnect criterion closed by `exports X + Y` (the v1.3 shape)",
  "reject",
  [{
    id: "STR-01",
    desc: "retry() after a mid-stream interruption resumes the stream without duplicating content",
    evid: "L23 exports `createDeepAgentsResumeHandler` and `isStreamReconnectEnabled`",
  }],
  {},
  ["STR-01"]
);

expect("a bare surface verb as the whole evidence", "reject",
  [{ id: "STR-02", desc: "the stream resumes after an interruption without duplication", evid: "EXPORTED" }],
  {}, ["STR-02"]);

console.log("\nassert-behavioural-evidence — ACCEPT (what it must not fire on)\n");

expect(
  "E2E-09's real evidence: an observable, a value, and a control",
  "accept",
  [{
    id: "E2E-09",
    desc: "Stream reconnection: retry() resumes without duplicating",
    evid: "`e2e/reconnect.spec.ts` test E2E-09 asserts requestCount=2, 'continued' visible, 'First part' count=1",
  }],
  {}
);

/*
 * THE TRIGGER MUST NOT FIRE ON A SURFACE CRITERION. "The package exports X" is legitimately
 * satisfied by "X is exported"; a rule that rejected this would be red on every surface
 * requirement in the repo and muted within a week.
 */
expect(
  "a SURFACE criterion closed by surface evidence is not this rule's business",
  "accept",
  [{
    id: "API-01",
    desc: "Server package exports createApprovalGatingTransform and ApprovalGatingConfig",
    evid: "Server package exports `createApprovalGatingTransform`, `ApprovalGatingConfig`",
  }],
  {}
);

/*
 * A KNOWN LIMITATION, PINNED AS A FIXTURE (#453).
 *
 * "the pause frames are emitted" mentions the behaviour and names a frame -- a REPORT, not the
 * observable. It is the MORE dangerous version of ADAPT-05, not a weaker one, and this rule
 * ACCEPTS it. If someone later makes the rule catch this, this case going red is the correct
 * signal to come and read here rather than a regression.
 */
expect(
  "KNOWN GAP: 'pause frames are emitted' passes — a report, not the observable",
  "accept",
  [{
    id: "ADAPT-05",
    desc: "the run pauses until an explicit approval or rejection",
    evid: "approval-gating.test.ts asserts the pause frames are emitted for the gated call",
  }],
  {}
);

console.log("\nassert-behavioural-evidence — THE CHECK'S OWN GUARDS\n");

{
  const dir = sandbox([{ id: "E2E-09", desc: "retry() resumes without duplicating", evid: "asserts requestCount=2, 'First part' count=1" }], {
    baseline: { known: [], positiveControls: [{ row: ".planning/phases/NOPE-VERIFICATION.md:E2E-99", why: "a control that does not exist" }] },
  });
  const { rc, out } = run(dir);
  const label = "a positive control that does not parse fails loudly";
  if (rc === 1 && out.includes("NOT PARSED")) { console.log(`  ok   ${label.padEnd(62)} (reject)`); pass++; }
  else { console.error(`  FAIL ${label} — rc=${rc}`); console.error(out); fail++; }
}

{
  const dir = sandbox([{ id: "E2E-09", desc: "retry() resumes without duplicating", evid: "asserts requestCount=2, 'First part' count=1" }], {
    baseline: { known: [{ row: ".planning/phases/x-VERIFICATION.md:E2E-09", issue: "#0", why: "already fixed" }], positiveControls: [] },
  });
  const { rc, out } = run(dir);
  const label = "a baseline entry that now passes is a failure, not a pass";
  if (rc === 1 && out.includes("stale baseline entry")) { console.log(`  ok   ${label.padEnd(62)} (reject)`); pass++; }
  else { console.error(`  FAIL ${label} — rc=${rc}`); console.error(out); fail++; }
}

{
  const dir = mkdtempSync(join(TMP, "empty-"));
  mkdirSync(join(dir, ".planning"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "behavioural-evidence-baseline.json"), JSON.stringify({ known: [], positiveControls: [] }));
  const { rc, out } = run(dir);
  const label = "a tree with no requirement rows is exit 2, not a green";
  if (rc === 2 && out.includes("COULD NOT COMPUTE")) { console.log(`  ok   ${label.padEnd(62)} (vacuous)`); pass++; }
  else { console.error(`  FAIL ${label} — rc=${rc}`); fail++; }
}

const EXPECTED = 9;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) { console.error(`FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`); process.exit(1); }
if (fail !== 0) { console.error(`FAIL: ${fail}/${total} cases wrong.`); process.exit(1); }
console.log(
  `PASS: ${pass}/${total}. Both real instances are rejected, a surface criterion is left alone,\n` +
    `      the check's own guards (positive control, stale baseline, vacuity) fire, and the\n` +
    `      known gap is pinned as a fixture rather than described in a comment.`
);
