#!/usr/bin/env node
/**
 * assert-verdict-tokens-disjoint.mjs — a fixture's verdict must never be readable as a real one.
 *
 * THE DEFECT (#496). classify-live-failure's selftest fixtures printed verdicts in the SAME
 * FORMAT, on the SAME STREAM, inside the SAME JOB as the real classification, carrying
 * `attempt=first` exactly as a real run does. Grepping the real token over a failing run
 * returned `TRANSPORT_DEFECT defects=2 upstream=2` and read as a real defect on main. It was
 * fixture output, and it was nearly reported while measuring #400.
 *
 * WHY A CHECK RATHER THAN A CONVENTION. The fix is one token, and one token is exactly the kind
 * of thing that is correct on the day it is written and silently wrong three fixtures later.
 * The token a fixture prints is DECLARED by its caller — the selftest sets an env flag — so a
 * new case added without the flag reintroduces the collision with no diff that looks wrong.
 * This asserts the property the token was meant to produce, rather than the token's presence.
 *
 * BOTH DIRECTIONS, AND THE SECOND IS THE ONE THAT ROTS.
 *
 *   DISJOINT  a full selftest run must emit ZERO real-token verdict lines. That is the defect
 *             stated directly.
 *   PRESENT   it must emit at least one FIXTURE-token line, and a real classification must
 *             emit a real one. "No fixture verdicts in the real stream" is trivially true of a
 *             selftest that stopped running, and of a classifier that stopped emitting — both
 *             of which would leave this green over nothing.
 *
 * THE MIRROR CASE IS WHY THIS IS FIXED RATHER THAN DOCUMENTED: a fixture printing PASS in a job
 * whose real classification never ran would read as a clean transport. The dangerous direction
 * is not the false red, it is the false green.
 *
 * Exit codes:  0  the two token sets are disjoint and both are non-empty
 *              1  a fixture emitted a real verdict token, or a side is empty
 *              2  the observation could not be made at all
 *
 * Usage: node scripts/assert-verdict-tokens-disjoint.mjs [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const i = argv.indexOf("--cwd");
const CWD = resolve(i === -1 || !argv[i + 1] ? ROOT : argv[i + 1]);

export const REAL_TOKEN = "LIVE_TRANSPORT_VERDICT";
export const FIXTURE_TOKEN = "LIVE_TRANSPORT_SELFTEST_VERDICT";

/**
 * Verdict lines of each kind, found ANYWHERE IN THE LINE.
 *
 * Not `startsWith`. The first version of this used it and counted zero of both, because the
 * selftest surfaces captured verdicts INSIDE its own report lines — indented, prefixed by a
 * case name. A grep is what a person actually runs against a job log, and a grep does not
 * anchor. Anchoring here would have made this checker green while the collision it exists for
 * was still in the log, which is the defect wearing the fix's clothes.
 *
 * The two tokens are not substrings of one another — `LIVE_TRANSPORT_SELFTEST_VERDICT` does not
 * contain `LIVE_TRANSPORT_VERDICT` — so neither can shadow the other and no ordering is needed.
 * That is a property of the names, so it is asserted rather than assumed, below.
 */
export function tally(text) {
  const real = [];
  const fixture = [];
  const reReal = new RegExp(`(?:^|\\s)${REAL_TOKEN} `);
  const reFixture = new RegExp(`(?:^|\\s)${FIXTURE_TOKEN} `);
  for (const line of String(text).split("\n")) {
    if (reFixture.test(line)) fixture.push(line.trim());
    if (reReal.test(line)) real.push(line.trim());
  }
  return { real, fixture };
}

/**
 * Can a grep for one token avoid matching the other?
 *
 * Exported and pure so it can be PROVED with a shadowing pair. A guard whose failing input
 * cannot be constructed is a guard nobody has watched fail, which is the same complaint this
 * repository makes of every check it deletes.
 */
export function namesAreSeparable(a, b) {
  return a !== b && !a.includes(b) && !b.includes(a);
}

const refuse = (msg) => {
  console.error(`REFUSING TO REPORT: ${msg}`);
  console.error(
    `      Exit 2, not 0 — nothing was observed, which is a different answer from "the two\n` +
      `      token sets are disjoint".`
  );
  process.exit(2);
};

function main() {
  /*
   * THE NAMES MUST NOT SHADOW EACH OTHER, and this is cheap to assert rather than assume. If a
   * future rename made one token a substring of the other, every fixture line would also match
   * a grep for the real one and this checker would go on reporting them as disjoint.
   */
  if (!namesAreSeparable(REAL_TOKEN, FIXTURE_TOKEN))
    refuse(
      `"${FIXTURE_TOKEN}" and "${REAL_TOKEN}" are substrings of one another, so no grep can ` +
        `separate them and this comparison cannot mean anything.`
    );

  // --- the fixture stream: a real run of the selftest, watched ----------------------------
  let selftestOut;
  try {
    selftestOut = execFileSync(
      process.execPath,
      [join(CWD, "scripts", "classify-live-failure.selftest.mjs")],
      { cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    // A FAILING selftest still emits its fixture verdicts, and its output is exactly the
    // subject here — so a non-zero exit is not a reason to refuse. An absent one is.
    selftestOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (!selftestOut.trim())
      refuse(
        `the classifier selftest produced no output at all (exit ${e.status}), so the fixture ` +
          `stream could not be observed.`
      );
  }

  // --- the real stream: one genuine classification, with no fixture flag -------------------
  const dir = mkdtempSync(join(tmpdir(), "verdict-tokens-"));
  let realOut;
  try {
    const log = join(dir, "run.log");
    writeFileSync(log, "1 passed\n");
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
    delete env.LIVE_TRANSPORT_SELFTEST;
    try {
      realOut = execFileSync(
        process.execPath,
        [join(CWD, "scripts", "classify-live-failure.mjs"), log, "0"],
        { cwd: CWD, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      realOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const fx = tally(selftestOut);
  const rl = tally(realOut);

  console.log(
    `selftest stream : ${fx.fixture.length} fixture verdict(s), ${fx.real.length} real verdict(s)\n` +
      `real stream     : ${rl.real.length} real verdict(s), ${rl.fixture.length} fixture verdict(s)`
  );

  const failures = [];
  if (fx.real.length > 0) {
    failures.push(
      `${fx.real.length} FIXTURE verdict(s) printed with the REAL token, so a grep for a real ` +
        `defect matches them:`
    );
    for (const l of fx.real.slice(0, 4))
      failures.push(`    ${l.slice(0, 120)}`);
    failures.push(
      `    A case that does not declare itself a fixture reintroduces #496 with no diff that`,
      `    looks wrong. Set LIVE_TRANSPORT_SELFTEST=1 on the invocation.`
    );
  }
  // PRESENCE, BOTH SIDES. Either being empty makes the disjointness above vacuous.
  if (fx.fixture.length === 0)
    failures.push(
      `the selftest emitted ZERO fixture verdicts, so "no real tokens among them" is true of ` +
        `nothing. Either the fixtures stopped classifying or the token changed.`
    );
  if (rl.real.length === 0)
    failures.push(
      `a real classification emitted ZERO real verdicts, so nothing would ever match a grep ` +
        `for one — the aggregate record #400 depends on would be empty and look quiet.`
    );

  if (failures.length === 0) {
    const withSubject = rl.real.filter((l) =>
      / log=[0-9a-f]{8,}/.test(l)
    ).length;
    reportSubject(rl.real.length, "real verdict token(s)");
    console.log(
      `\nOK — the two token sets are disjoint and neither is empty. A grep for ` +
        `${REAL_TOKEN}\n     cannot match a fixture, by construction rather than by ` +
        `proximity to another line.\n` +
        `     ${withSubject}/${rl.real.length} real verdict(s) carry log=<sha>, so a verdict ` +
        `names the input it read\n     rather than depending on an adjacent line surviving.`
    );
    return;
  }
  console.error(`\nFAIL:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
