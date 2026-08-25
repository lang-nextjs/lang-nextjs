#!/usr/bin/env node
/**
 * Prove the silent-skip gate can fail — and, just as importantly, that it does NOT fire on the
 * conditional skips that are legitimate.
 *
 * The accept cases carry most of the weight here. A gate that flagged `describe.skipIf(!LIVE)`
 * would report nine false positives on day one, and a check that cries wolf gets disabled —
 * worse than the blindness it replaced. The whole design rests on the distinction between "runs
 * nowhere" and "runs when its stated condition holds", so that distinction is what gets tested.
 */
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUT = join(ROOT, "scripts", "assert-no-silent-skips.mjs");
const TMP = mkdtempSync(join(tmpdir(), "skips-selftest-"));
let pass = 0,
  fail = 0,
  n = 0;

/** A tiny git repo with N innocuous test files, plus whatever `extra` adds. */
function fixture(extra = "") {
  const dir = join(TMP, `f${n++}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // 12 files, over the scan's non-vacuity floor of 10.
  for (let i = 0; i < 12; i++) {
    writeFileSync(
      join(dir, "src", `a${i}.test.ts`),
      `it("case ${i}", () => {});\n`
    );
  }
  if (extra) writeFileSync(join(dir, "src", "extra.test.ts"), extra);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}
function run(dir) {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [SUT, "--cwd", dir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const check = (name, want, extra, verify) => {
  const { rc, out } = run(fixture(extra));
  const okRc = want === "accept" ? rc === 0 : rc !== 0;
  if (okRc && (verify ? verify(out) : true)) {
    console.log(`  ok   ${name.padEnd(54)} (${want}ed)`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(54)} rc=${rc}`);
    console.error(`       ${out.split("\n")[0]}`);
    fail++;
  }
};

console.log(
  "assert-no-silent-skips self-test — flags what runs nowhere, spares what states a condition\n"
);

// --- REJECT: unconditional skips, in every form ----------------------------------------------
check("it.skip is flagged", "reject", `it.skip("dead one", () => {});\n`);
check(
  "describe.skip is flagged",
  "reject",
  `describe.skip("dead group", () => {});\n`
);
check("it.todo is flagged", "reject", `it.todo("someday");\n`);
check("test.skip is flagged", "reject", `test.skip("dead one", () => {});\n`);

// --- ACCEPT: conditional skips state their condition in the source ----------------------------
// These carry the design. Flagging them would produce nine false positives on this repo alone.
check(
  "describe.skipIf is NOT flagged",
  "accept",
  `describe.skipIf(!process.env.LIVE)("live", () => {});\n`
);
check(
  "it.runIf is NOT flagged",
  "accept",
  `it.runIf(process.env.LIVE)("live", () => {});\n`
);
check(
  "it.skipIf is NOT flagged",
  "accept",
  `it.skipIf(!process.env.LIVE)("live", () => {});\n`
);

// --- ACCEPT: prose about skipping is not skipping ---------------------------------------------
// Comments are blanked, not dropped, so this must pass AND line numbers elsewhere stay real.
check(
  "a comment mentioning it.skip is not flagged",
  "accept",
  `// we used to it.skip("this") but no longer\n/* describe.skip("nor this") */\nit("real", () => {});\n`
);

// --- REJECT: the scan finding nothing must fail, not pass -------------------------------------
{
  const dir = join(TMP, "empty");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "readme.md"), "no tests here");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const { rc, out } = run(dir);
  if (rc !== 0 && out.includes("scan is broken")) {
    console.log(
      `  ok   ${"a tree with no test files fails, not passes".padEnd(
        54
      )} (rejected)`
    );
    pass++;
  } else {
    console.error(`  FAIL empty tree (rc=${rc})`);
    fail++;
  }
}

// --- ACCEPT: the real repo, which must be clean or the gate is unshippable ---------------------
{
  const { rc } = run(ROOT);
  if (rc === 0) {
    console.log(`  ok   ${"the real repository passes".padEnd(54)} (accepted)`);
    pass++;
  } else {
    console.error(`  FAIL the real repository does not pass`);
    fail++;
  }
}

const EXPECTED_CASES = 10;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total}, expected ${EXPECTED_CASES} — harness broken.`
  );
  process.exit(1);
}
if (fail) {
  console.error(`FAIL: ${fail}/${total} wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. Unconditional skips are caught in every form, conditional ones`
);
console.log(
  `      are spared, and a scan that found nothing fails rather than reporting clean.`
);
