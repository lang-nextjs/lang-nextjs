#!/usr/bin/env node
/**
 * check-e2e-registration.selftest.mjs — prove the checker can FAIL, by mutation.
 *
 * The thing being guarded against is a suite that reports green by ABSENCE, so a
 * checker for it that also passes vacuously would be worse than none: it would
 * put a green tick on exactly the state it was built to refuse. Reading the code
 * cannot establish that it fires. Only watching it fire can.
 *
 * Three cases, and the third is not optional:
 *   ORPHAN   plant a spec no project matches   -> must exit non-zero
 *   GHOST    plant a project matching nothing  -> must exit non-zero
 *   HEALTHY  the real repo, unmutated          -> must exit zero
 *
 * Without the healthy case a checker that refuses everything scores 2/2 here and
 * is useless. Without the two failure cases a checker that refuses nothing scores
 * 1/1 and is equally useless. The suite only means something with both halves.
 *
 * Mutations are made to the REAL tree and reverted in `finally`, because the
 * checker shells out to Playwright, which needs a real config, a real testDir and
 * real node_modules. Every mutation is restored from an in-memory copy taken
 * before the first edit — never with `git checkout --`, which reverts to HEAD
 * rather than to "before this ran" and would discard uncommitted work.
 *
 * Usage: node scripts/check-e2e-registration.selftest.mjs
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "check-e2e-registration.mjs");
const CONFIG = join(ROOT, "playwright.config.ts");
const ORPHAN = join(ROOT, "e2e", "__selftest-orphan.spec.ts");

let pass = 0;
let fail = 0;

/** Run the checker; return { code, out }. Never throws. */
function runChecker() {
  try {
    const out = execFileSync("node", [CHECKER], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: String(err.stdout ?? "") + String(err.stderr ?? ""),
    };
  }
}

function expectCaught(name, mutate, revert, expectInOutput) {
  try {
    mutate();
    const { code, out } = runChecker();
    if (code !== 0 && (!expectInOutput || out.includes(expectInOutput))) {
      console.log(`  ok   ${name.padEnd(52)} (caught, exit ${code})`);
      pass++;
    } else {
      console.log(
        `  FAIL ${name.padEnd(52)} (exit ${code}${
          expectInOutput && code !== 0 ? `, but output lacked "${expectInOutput}"` : ""
        })`
      );
      if (code === 0) console.log(`       checker said: ${out.trim().split("\n")[0]}`);
      fail++;
    }
  } finally {
    revert();
  }
}

console.log("check-e2e-registration selftest — each gate watched failing\n");

// ── ORPHAN: a spec file no project's testMatch claims ──────────────────────
expectCaught(
  "an unregistered spec file is caught",
  () => {
    // Deliberately at e2e/ root: every project's testMatch here is scoped to a
    // subdirectory or an exact filename, so nothing claims this.
    writeFileSync(
      ORPHAN,
      [
        "// Planted by check-e2e-registration.selftest.mjs. If you are reading this",
        "// in a normal checkout, the selftest crashed before its finally block —",
        "// delete it.",
        'import { test, expect } from "@playwright/test";',
        'test("selftest placeholder", async () => { expect(1).toBe(1); });',
        "",
      ].join("\n")
    );
  },
  () => rmSync(ORPHAN, { force: true }),
  "matched by NO project"
);

// ── GHOST: a project whose testMatch matches nothing ───────────────────────
const CONFIG_BEFORE = readFileSync(CONFIG, "utf8");
expectCaught(
  "a project whose testMatch matches nothing is caught",
  () => {
    // Appended to the projects array by anchoring on the last project's closing
    // brace is fragile; instead splice a project in right after `projects: [`.
    const marker = "projects: [";
    const at = CONFIG_BEFORE.indexOf(marker);
    if (at < 0) throw new Error("could not find `projects: [` in playwright.config.ts");
    const injected =
      CONFIG_BEFORE.slice(0, at + marker.length) +
      "\n    {\n" +
      "      name: \"__selftest-ghost\",\n" +
      "      testMatch: /__no_such_spec_anywhere__\\.spec\\.ts/,\n" +
      "    },\n" +
      CONFIG_BEFORE.slice(at + marker.length);
    writeFileSync(CONFIG, injected);
  },
  () => writeFileSync(CONFIG, CONFIG_BEFORE),
  "run zero tests"
);

// ── HEALTHY: the real, unmutated repo must PASS ────────────────────────────
// Without this, a checker that refuses everything scores 2/2 above.
{
  const { code, out } = runChecker();
  if (code === 0) {
    console.log(`  ok   ${"the real, unmutated repo".padEnd(52)} (exit 0, correctly accepted)`);
    pass++;
  } else {
    console.log(`  FAIL ${"the real, unmutated repo".padEnd(52)} (exit ${code} — false positive)`);
    console.log(out.trim().split("\n").slice(0, 8).map((l) => `       ${l}`).join("\n"));
    fail++;
  }
}

// ── Leak check: the mutations must not have survived ───────────────────────
{
  const configClean = readFileSync(CONFIG, "utf8") === CONFIG_BEFORE;
  const orphanGone = !existsSync(ORPHAN);
  if (configClean && orphanGone) {
    console.log(`  ok   ${"every mutation was reverted".padEnd(52)} (tree restored)`);
    pass++;
  } else {
    console.log(
      `  FAIL ${"every mutation was reverted".padEnd(52)} ` +
        `(config ${configClean ? "clean" : "DIRTY"}, orphan ${orphanGone ? "gone" : "PRESENT"})`
    );
    fail++;
  }
}

console.log();
if (fail > 0) {
  console.error(`FAIL: ${fail} of ${pass + fail} selftest case(s) failed.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${pass + fail}. Both failure modes were watched failing, the healthy\n` +
    "      repo still passes, and the tree was left as it was found."
);
