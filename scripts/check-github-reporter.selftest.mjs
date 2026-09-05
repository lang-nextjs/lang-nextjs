#!/usr/bin/env node
/**
 * Proof for scripts/check-github-reporter.mjs — and for the reporter itself.
 *
 * TWO HALVES, because the checker alone would be the weaker kind of gate.
 *
 *   STATIC   the checker refuses a config without the reporter, and accepts the
 *            real one. Standard mutation coverage.
 *   LIVE     playwright with the `github` reporter, on a deliberately failing
 *            spec, actually emits `::error file=…,line=…::`.
 *
 * THE LIVE HALF IS THE POINT, and #362's acceptance bar says why: the fixed and
 * unfixed states are indistinguishable from outside. Both produce a check run
 * whose conclusion is FAILURE and which says nothing else. A reporter that
 * emits nothing — dropped in a refactor, renamed upstream, gated on a variable
 * CI does not set — looks exactly like the config we had. "The line is in the
 * file" is not evidence that an annotation reaches a check run; only watching
 * one appear is.
 *
 * Every case here is a PAIR. A run that produced no annotation because nothing
 * failed proves nothing, so the failing run is asserted to have actually
 * failed; and the control run proves the annotation comes from THIS reporter
 * rather than from something else in the output.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHECKER = join(HERE, "check-github-reporter.mjs");

let failed = 0;
const results = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true;
    if (!ok && typeof r === "string") detail = r;
  } catch (e) {
    detail = `raised ${e.message.split("\n")[0]}`;
  }
  if (!ok) failed++;
  results.push([ok, name, detail]);
}

/** Run the checker against a scratch tree holding `config`. Returns its exit code. */
function checkerOn(config) {
  const dir = join(ROOT, ".tmp-github-reporter-static");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "playwright.config.ts"), config);
    execFileSync("node", [CHECKER, "--cwd", dir], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── STATIC ────────────────────────────────────────────────────────────────
check(
  "REJECT: a config with no github reporter",
  () =>
    checkerOn('export default { reporter: [["list"], ["html", {}]] };\n') === 1
);

check(
  "REJECT: a config with no reporter at all",
  () => checkerOn("export default { testDir: './e2e' };\n") === 1
);

check(
  "REJECT: github present but NOT gated on CI",
  () =>
    checkerOn('export default { reporter: [["list"], ["github"]] };\n') === 1
);

check(
  "ACCEPT: github gated on CI",
  () =>
    checkerOn(
      'export default { reporter: [["list"], ...(process.env.CI ? [["github"]] : [])] };\n'
    ) === 0
);

// The one that stops the rejects above scoring like a checker that refuses
// everything: the REAL config must pass.
check("ACCEPT: this repo's actual playwright.config.ts", () => {
  try {
    execFileSync("node", [CHECKER, "--cwd", ROOT], { stdio: "pipe" });
    return true;
  } catch (e) {
    return `real config rejected: ${String(
      e.stdout ?? e.stderr ?? e.message
    ).slice(0, 200)}`;
  }
});

// ── LIVE ──────────────────────────────────────────────────────────────────
/**
 * Run one deliberately failing spec under `reporter`, inside the repo so
 * `@playwright/test` resolves, and return the combined output.
 *
 * No browser is launched: the spec asserts on a number. A proof that needed
 * `playwright install` would not run in the places this needs to run.
 */
function runFailingSpec(reporter) {
  const dir = join(ROOT, ".tmp-github-reporter-live");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  /*
   * captureGitInfo IS TURNED OFF BECAUSE THIS PROOF MUST NOT MUTATE THE REPOSITORY IT RUNS IN,
   * and by default in CI it does. Playwright's gitCommitInfo plugin defaults `commit` and
   * `diff` to ON whenever it detects CI, and its diff path runs, in
   * playwright/lib/runner/index.js:
   *
   *     git fetch origin ${ci.prBaseHash} --depth=1 --no-auto-maintenance --no-auto-gc ...
   *
   * `prBaseHash` is `pull_request.base.sha` from the GitHub event — main's tip — and
   * `--depth=1` writes `$GIT_DIR/shallow` holding exactly that commit. The config lives under
   * ROOT, so git resolves to THE WORKSPACE REPOSITORY and the boundary lands in the real clone.
   *
   * MEASURED (#427): the clone arrives complete, this phase runs, and 1.6 seconds later
   * assert-no-undeclared-reverts refuses because its base — that same commit — is now grafted
   * parentless and every file in its tree reads as "added there". 41 bytes, one sha, matching
   * the base exactly. Reproduced outside CI by setting GITHUB_ACTIONS and GITHUB_EVENT_PATH:
   * the file appears, the proof still passes 10/10. It never failed; it corrupted the
   * environment for everything after it.
   *
   * Nothing here needs git metadata: the assertion is that the `github` reporter emits an
   * ::error annotation and the `list` reporter does not.
   */
  writeFileSync(
    join(dir, "pw.config.mjs"),
    `export default { testDir: ".", reporter: ${reporter}, ` +
      `captureGitInfo: { commit: false, diff: false } };\n`
  );
  writeFileSync(
    join(dir, "deliberate.spec.mjs"),
    'import { test, expect } from "@playwright/test";\n' +
      'test("deliberately failing, to prove the reporter emits", () => {\n' +
      "  expect(1).toBe(2);\n" +
      "});\n"
  );
  let out = "";
  try {
    out = execFileSync(
      "node",
      [
        join(ROOT, "node_modules", "@playwright", "test", "cli.js"),
        "test",
        "-c",
        "pw.config.mjs",
      ],
      { cwd: dir, encoding: "utf8", stdio: "pipe" }
    );
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const gh = runFailingSpec('[["github"]]');
const plain = runFailingSpec('[["list"]]');

// ANTI-VACUITY FIRST. "No annotation" is meaningless if nothing failed, and a
// run that never started would satisfy every negative assertion below.
check("the deliberate spec really did fail under BOTH reporters", () =>
  /1 failed/.test(gh) && /1 failed/.test(plain)
    ? true
    : `github-run had '1 failed'=${/1 failed/.test(
        gh
      )}, list-run=${/1 failed/.test(plain)}`
);

check("LIVE: the github reporter emits an ::error annotation", () =>
  /::error /.test(gh) ? true : `no ::error line in:\n${gh.slice(-600)}`
);

check("LIVE: the annotation names the FILE", () =>
  /::error file=[^,]*deliberate\.spec\.mjs/.test(gh)
    ? true
    : `no file= naming the spec in:\n${(gh.match(/::error[^\n]*/g) || []).join(
        "\n"
      )}`
);

check("LIVE: the annotation names a LINE", () =>
  /::error file=[^\n]*,line=\d+/.test(gh)
    ? true
    : `no line= in:\n${(gh.match(/::error[^\n]*/g) || []).join("\n")}`
);

// THE CONTROL. Without it, an ::error line coming from anywhere else in the
// output would be credited to the reporter — and the whole claim is that this
// reporter is the only thing in the pipeline that writes those fields.
check("CONTROL: the list reporter emits NO ::error annotation", () =>
  !/::error /.test(plain)
    ? true
    : `the list reporter also emitted one, so the github reporter is not what produces it:\n${(
        plain.match(/::error[^\n]*/g) || []
      ).join("\n")}`
);

for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
}
if (failed) {
  console.log(`\nFAIL: ${failed}/${results.length} case(s).`);
  process.exit(1);
}
console.log(
  `\nPASS: ${results.length}/${results.length}. The checker refuses a config without the ` +
    "reporter and accepts this one, and the reporter was OBSERVED emitting an annotation " +
    "naming a file and a line — which the list reporter does not."
);
