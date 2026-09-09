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

/*
 * THE GLOB THAT OPENS A FALSE COMMENT (#1134). The checker used to read the file as TEXT and
 * blank block comments with a regex; a glob in a string literal opened a comment that closed at
 * the next real `*\/`, and everything between vanished. It reported a CLEAN FILE with a skipped
 * test inside — and this checker gates.
 *
 * DEV1'S SECOND ARM IS NOT A DUPLICATE, AND IT IS THE MORE INSTRUCTIVE ONE. They first drove
 * this construct and reported it did NOT reproduce. That was correct and under-specified: their
 * sample had the glob but NO CLOSING `*\/`, so the non-greedy match never completed and nothing
 * was blanked. The two fixtures differ by one ordinary comment.
 *
 * A NEGATIVE RESULT FROM A HAND-MADE FIXTURE IS A STATEMENT ABOUT THE FIXTURE until you can name
 * which ingredient was missing. Both forms are pinned here so the next person does not have to
 * rediscover which one carries the defect.
 */
check(
  "a glob opening a false comment cannot hide a skip",
  "reject",
  'const alias = "@/*";\n' +
    'it.skip("hidden inside the false comment", () => {});\n' +
    "/* an ordinary block comment supplies the closing delimiter */\n" +
    'it.skip("after the closing delimiter", () => {});\n',
  (out) =>
    /hidden inside the false comment/.test(out) &&
    /after the closing delimiter/.test(out)
);

check(
  "the same glob with NO closing delimiter — the form that does not reproduce",
  "reject",
  'const alias = "@/*";\nit.skip("nothing closes the false comment", () => {});\n',
  (out) => /nothing closes the false comment/.test(out)
);

const EXPECTED_CASES = 12;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED_CASES) {
    console.error(
      `FAIL: ran ${ran}, expected ${EXPECTED_CASES} — harness broken.`
    );
    process.exitCode = 1;
  }
});
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
