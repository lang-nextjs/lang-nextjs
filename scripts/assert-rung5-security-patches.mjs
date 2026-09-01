#!/usr/bin/env node
/**
 * RUNG 5'S SECURITY PATCHES, ENFORCED CONTINUOUSLY RATHER THAN HISTORICALLY (#86).
 *
 * `rungs/5-software-developer-agent` is a VENDORED, PINNED tree that diverges from upstream in
 * exactly two places, both security fixes (PROVENANCE.md has the manifest):
 *
 *   #84  the GitHub webhook verifies its signature. Upstream reads the header and NEVER
 *        compares it — any request with a non-empty signature was parsed and dispatched.
 *   #82  the AES key is derived with scrypt against a random per-ciphertext salt. Upstream
 *        used a single-pass SHA-256 of an operator env var: no salt, no work factor.
 *
 * `security-patches.test.mjs` proves both, and proves them BEHAVIOURALLY — it imports the built
 * `dist` and exercises the real code paths, so it fails when the property is gone rather than
 * when a file is missing. Those are opposite failure modes and only one of them is worth
 * having. Measured before this gate was written:
 *
 *   patched                          10 pass / 0 fail / 0 skipped
 *   #82 KDF reverted to SHA-256       9 pass / 1 fail  ("the derived key is NOT a bare SHA-256")
 *   #84 verify() reverted             7 pass / 3 fail  (incl. "the forged request never
 *                                                       reaches the dispatcher")
 *
 * So the tests were never the problem. NOTHING RAN THEM. They live under the vendored tree's
 * own yarn toolchain, our vitest cannot import across that dependency graph, and no workflow
 * invoked them — the properties were verified once, when they were written, and never again.
 * A regression in either would have left every gate we have green.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A FEW `run:` LINES. The dangerous outcome here is not a
 * red build, it is a GREEN one that ran nothing. `node --test` exits 0 over zero tests, and
 * during #85's authoring four of the ten silently skipped — both dynamic imports were wrapped
 * in `.catch(() => null)` and the webhook module throws at import time, so the summary read
 * `6 pass / 0 fail` while the entire #84 half was absent. A skipped security test is
 * indistinguishable from a passing one in every summary line that matters. This script's real
 * job is to refuse that summary.
 *
 * WHEN TO DELETE IT: when the patches are upstreamed and the pin moves past them. This gate is
 * only meaningful while the tree is BOTH vendored AND divergent, and PROVENANCE.md's manifest
 * is what tells you that has stopped being true. Leaving it running against a tree that no
 * longer diverges would be a check whose subject no longer exists.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { invokedAsProgram } from "./lib/is-main.mjs";
/**
 * Resolved from THIS FILE, never from cwd. A checker that resolves its root from the working
 * directory reports "could not enumerate" when run from elsewhere, and "the checker could not
 * run" prints almost identically to "the checker ran and found nothing" while meaning the
 * opposite.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNG_DIR = join(ROOT, "rungs", "5-software-developer-agent");
const TEST_FILE = "security-patches.test.mjs";

/**
 * The number of tests that must execute. LITERAL, not derived from the run.
 *
 * Deriving it from the output would make the count agree with itself for any output at all,
 * which is the vacuity this whole script exists to prevent. Adding or removing a security test
 * must be a deliberate edit here, by someone who then has to say why the number moved.
 */
export const EXPECTED_TESTS = 10;

/** TAP summary counters emitted by `node --test`. Absent is NOT zero — see `readCount`. */
const COUNTERS = ["tests", "pass", "fail", "skipped", "todo", "cancelled"];

/**
 * Read one `# <name> <n>` summary line.
 *
 * Returns null when the line is ABSENT, which is deliberately distinct from 0. A truncated or
 * crashed run has no summary at all, and reading that as "0 failures" is exactly how a run that
 * never happened becomes a pass.
 *
 * DO NOT "SIMPLIFY" THIS TO `?? 0`. It reads as tidy-up and it silently deletes the only thing
 * standing between a crashed run and a green build: with `?? 0` a completely empty output has
 * zero failures, zero skips, and zero tests, and every check below is satisfied by a process
 * that died before printing anything. The selftest has a case for it.
 */
function readCount(tap, name) {
  const m = tap.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
}

/**
 * The verdict, as a pure function of the TAP text — separated from running anything so the
 * selftest can plant every failure mode without a three-minute vendored build.
 *
 * @returns {{ok: boolean, problems: string[], counts: Record<string, number|null>}}
 */
export function verdict(tap, { expectedTests = EXPECTED_TESTS } = {}) {
  const counts = Object.fromEntries(
    COUNTERS.map((c) => [c, readCount(tap, c)])
  );
  const problems = [];

  // ABSENT SUMMARY FIRST. Everything below assumes the numbers exist; if the run died before
  // printing them, every later check would compare against null and quietly pass.
  const missing = COUNTERS.filter((c) => counts[c] === null);
  if (missing.length > 0) {
    problems.push(
      `the TAP summary is missing ${missing.join(
        ", "
      )} — the run did not finish, ` +
        `which is not the same as finishing with nothing wrong.`
    );
    return { ok: false, problems, counts };
  }

  // THE VACUITY GUARD, and the reason this file exists. `node --test` exits 0 over zero tests.
  if (counts.tests === 0) {
    problems.push(
      "zero tests executed. node --test exits 0 in that case, so this would otherwise be a " +
        "green build that verified nothing."
    );
  } else if (counts.tests !== expectedTests) {
    problems.push(
      `${counts.tests} tests executed, expected exactly ${expectedTests}. If a security test ` +
        `was added or removed, update EXPECTED_TESTS in this file and say why in the commit.`
    );
  }

  // A SKIP IS NOT A PASS. This is the precise shape that produced `6 pass / 0 fail` while the
  // whole #84 half was absent: the tests did not run, and nothing in the summary said so.
  if (counts.skipped > 0) {
    problems.push(
      `${counts.skipped} test(s) skipped. A skipped security test is indistinguishable from a ` +
        `passing one in every summary line that matters, so it is treated as a failure here.`
    );
  }
  if (counts.todo > 0) {
    problems.push(
      `${counts.todo} test(s) marked todo — same reasoning as skipped.`
    );
  }
  if (counts.cancelled > 0) {
    problems.push(
      `${counts.cancelled} test(s) cancelled — the run was cut short.`
    );
  }

  if (counts.fail > 0) {
    problems.push(
      `${counts.fail} test(s) FAILED. A security patch in the vendored rung-5 tree has ` +
        `regressed — see PROVENANCE.md for what upstream did and what this tree does instead.`
    );
  }

  // The counters must also agree with each other. They disagree when the harness itself is
  // confused, and a self-inconsistent summary is not evidence of anything.
  if (
    counts.pass + counts.fail + counts.skipped + counts.todo !==
    counts.tests
  ) {
    problems.push(
      `the counters do not add up: pass ${counts.pass} + fail ${counts.fail} + skipped ` +
        `${counts.skipped} + todo ${counts.todo} != tests ${counts.tests}.`
    );
  }

  return { ok: problems.length === 0, problems, counts };
}

/**
 * The two patched regions, identified by the banners PROVENANCE.md tells you to grep for.
 *
 * WHY THE GATE CHECKS ITS OWN REASON TO EXIST. This job is only meaningful while the tree is
 * BOTH vendored AND divergent. If the patches are upstreamed and the pin moves past them, the
 * banners go away, the behaviour tests keep passing — because upstream now does the right
 * thing — and this gate would sit green forever guarding a divergence that no longer exists.
 *
 * A gate that goes green because its subject vanished is the exact defect this repository
 * keeps finding, and a "delete me when…" note in a comment is documentation, not enforcement.
 * So the absence of the banners is a FAILURE that tells you to delete the job, rather than a
 * silent pass. This is a marker check, deliberately — not a diff against upstream. Building a
 * provenance differ to answer "are we still divergent" would be a far larger thing than the
 * question deserves.
 */
const PATCH_MARKERS = [
  {
    issue: "#84",
    // REPO-ROOT-RELATIVE, including the rungs/ prefix, and that is load-bearing twice over.
    // Read plainly it says where this file actually is; and since #199 eject anchors its
    // dangling-reference match to repo-root-relative paths, a literal directory prefix is
    // correctly ignored. Written relative to the vendored tree instead, it would read
    // `apps/open-swe/...` — textually identical to this repository's own rung-4 app, and no
    // checker could tell them apart because at that point nothing distinguishes them.
    file: "rungs/5-software-developer-agent/apps/open-swe/src/routes/github/unified-webhook.ts",
    banner: "BEGIN lang-nextjs SECURITY PATCH (issue #84)",
    what: "the GitHub webhook verifies its signature (upstream never compared it)",
  },
  {
    issue: "#82",
    file: "rungs/5-software-developer-agent/packages/shared/src/crypto.ts",
    banner: "BEGIN lang-nextjs SECURITY PATCH (issue #82)",
    what: "the AES key is derived with scrypt and a per-ciphertext salt (upstream: bare SHA-256)",
  },
];

/**
 * Which patch markers are absent, as a pure function of file CONTENT.
 *
 * `read` is injected for the same reason `verdict` takes text: the selftest must be able to
 * plant "the banner is gone" without a vendored checkout. It returns null for a file that does
 * not exist, which is treated identically to one that exists without the banner — both mean the
 * divergence is not there.
 */
export function missingMarkers(read, markers = PATCH_MARKERS) {
  return markers.filter((m) => {
    const content = read(m.file);
    return content === null || !content.includes(m.banner);
  });
}

/** Fails when the divergence this gate protects is gone — see PATCH_MARKERS. */
function assertStillDivergent() {
  const gone = missingMarkers((rel) => {
    const p = join(ROOT, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  });
  if (gone.length === 0) return;

  console.error(
    `\nFAIL: the security patch banner is missing for ${gone
      .map((m) => m.issue)
      .join(" and ")}.\n`
  );
  for (const m of gone) {
    console.error(
      `  · ${m.issue} — ${m.file}\n      expected: ${m.banner}\n      protects: ${m.what}`
    );
  }
  console.error(
    `\nEITHER a patch was removed — in which case the tests below would also fail and this is a\n` +
      `real regression — OR the fix was upstreamed and the pin moved past it, in which case this\n` +
      `tree no longer diverges and THIS ENTIRE JOB SHOULD BE DELETED rather than left running\n` +
      `against code that no longer differs from upstream.\n\n` +
      `PROVENANCE.md's patch manifest is what tells you which. This is a hard failure instead of\n` +
      `a quiet pass because a gate that goes green when its subject disappears is worse than no\n` +
      `gate: it reports safety it is no longer measuring.\n`
  );
  process.exit(1);
}

/** Run a command in the vendored tree; a non-zero exit is a hard failure, never "nothing to do". */
function runVendored(cmd, args, label) {
  try {
    return execFileSync(cmd, args, {
      cwd: RUNG_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
  } catch (err) {
    // ABSENT TOOLCHAIN IS A FAILURE, NOT A CLEAN PASS — same rule as
    // assert-resolved-version.sh and await-http-json.sh. "yarn is not installed" must not
    // read as "there was nothing to verify".
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    console.error(`\nFAIL: ${label} failed in the vendored tree.\n`);
    if (out) console.error(out.split("\n").slice(-30).join("\n"));
    console.error(
      `\nThis is a hard failure on purpose. A missing or broken vendored toolchain means the ` +
        `security patches were NOT verified on this commit, which is not the same as their ` +
        `being intact.\n`
    );
    process.exit(1);
  }
}

function main() {
  if (!existsSync(RUNG_DIR)) {
    console.error(
      `\nFAIL: ${RUNG_DIR} does not exist.\n\n` +
        `This gate was invoked, so something expected the rung-5 tree to be here. A fork that ` +
        `legitimately has no rung 5 should not reach this script at all — the workflow guards ` +
        `it on scripts/has-rung.mjs. Reaching it with the tree absent means the guard and the ` +
        `gate disagree, and that is worth failing over rather than skipping past.\n`
    );
    process.exit(1);
  }

  // Before anything expensive: is the divergence this gate protects still here?
  assertStillDivergent();

  console.log(
    "rung-5 security patches — enforcing #82 and #84 behaviourally\n"
  );
  console.log("  installing vendored dependencies (yarn, immutable)…");
  runVendored("corepack", ["yarn", "install", "--immutable"], "yarn install");
  console.log("  building the vendored tree…");
  runVendored("corepack", ["yarn", "build"], "yarn build");
  console.log("  running security-patches.test.mjs…\n");

  // node --test exits non-zero when tests fail, but we do NOT branch on that: the verdict is
  // computed from the summary either way, because the exit code cannot tell us that zero tests
  // ran or that four of them skipped.
  let tap;
  try {
    tap = execFileSync("node", ["--test", TEST_FILE], {
      cwd: RUNG_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    tap = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  const { ok, problems, counts } = verdict(tap);

  const summary = COUNTERS.map((c) => `${c} ${counts[c] ?? "ABSENT"}`).join(
    " · "
  );
  console.log(`  ${summary}\n`);

  if (!ok) {
    console.error(
      "FAIL: rung-5 security patches are not verified on this commit.\n"
    );
    for (const p of problems) console.error(`  · ${p}`);
    console.error("\nFull output:\n");
    console.error(tap.split("\n").slice(-60).join("\n"));
    process.exit(1);
  }

  console.log(
    `PASS: ${counts.pass}/${EXPECTED_TESTS} security assertions executed and passed, none\n` +
      `      skipped. #84 (webhook signature verification) and #82 (scrypt KDF with a\n` +
      `      per-ciphertext salt) still hold in the vendored tree.`
  );
}

// Importable for the selftest; only runs when invoked directly.
if (invokedAsProgram(import.meta.url)) {
  main();
}
