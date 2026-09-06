/**
 * Proves check-visual-baselines.mjs can fail, can pass, and cannot pass vacuously.
 *
 * The last is the one that matters here. This checker's whole job is to report on
 * files that may not exist, and "0 offenders" over an empty tree is
 * indistinguishable from "clean" unless the checker refuses to answer. That is the
 * shape behind `census agrees` with nothing enumerated, and behind a palette check
 * that exited 0 through a symlinked path over 237 findings.
 *
 * Sandboxes are plain temp dirs, not git worktrees: the checker reads the
 * filesystem, so nothing here needs a repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "check-visual-baselines.mjs");
const TMP = mkdtempSync(join(tmpdir(), "visual-baselines-selftest-"));
let pass = 0;
let fail = 0;
let n = 0;

/** A tree with the given baseline filenames under e2e/<spec>-snapshots/. */
function sandbox(names) {
  const dir = join(TMP, `t${n++}`);
  const snaps = join(dir, "e2e", "shared", "visual.spec.ts-snapshots");
  mkdirSync(snaps, { recursive: true });
  for (const name of names) writeFileSync(join(snaps, name), "not-a-real-png");
  return dir;
}

function run(cwd, root = "e2e") {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [SUT, root], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name.padEnd(54)} ${detail}`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(54)} ${detail}`);
    fail++;
  }
}

console.log("check-visual-baselines.mjs self-test\n");

// ACCEPT — without this, a checker that refuses everything scores full marks.
{
  const { rc, out } = run(
    sandbox(["a-visual-linux.png", "b-visual-linux.png"])
  );
  check(
    "a linux-only baseline set passes",
    rc === 0 && out.includes("clean"),
    `(rc=${rc})`
  );
}

// REJECT — the headline case.
{
  const { rc, out } = run(
    sandbox(["a-visual-linux.png", "a-visual-darwin.png"])
  );
  check(
    "a darwin baseline is caught and NAMED",
    rc === 1 && out.includes("a-visual-darwin.png"),
    `(rc=${rc}, named=${out.includes("a-visual-darwin.png")})`
  );
}

// REJECT — a platform nobody has thought of yet must not be exempt by omission.
{
  const { rc, out } = run(
    sandbox(["a-visual-linux.png", "a-visual-win32.png"])
  );
  check(
    "an UNKNOWN platform is caught too, not just darwin",
    rc === 1 && out.includes("win32"),
    `(rc=${rc})`
  );
}

// REJECT — an all-wrong-platform tree must not pass by having no linux file to compare against.
{
  const { rc } = run(sandbox(["a-visual-darwin.png"]));
  check("a tree with ONLY darwin baselines fails", rc === 1, `(rc=${rc})`);
}

// VACUITY — the case this checker most needs.
{
  const dir = join(TMP, `t${n++}`);
  mkdirSync(join(dir, "e2e"), { recursive: true });
  const { rc, out } = run(dir);
  check(
    "no snapshot dir is BAD USAGE, not clean",
    rc === 2 && out.includes("Nothing was examined"),
    `(rc=${rc})`
  );
}

// VACUITY — a missing root must not read as clean either.
{
  const { rc } = run(sandbox(["a-visual-linux.png"]), "no-such-dir");
  check("a missing root is bad usage, not clean", rc === 2, `(rc=${rc})`);
}

// Non-PNG files must not be mistaken for baselines.
{
  const { rc } = run(
    sandbox(["a-visual-linux.png", "README-darwin.md", "notes.txt"])
  );
  check("non-PNG files are ignored, not flagged", rc === 0, `(rc=${rc})`);
}

const EXPECTED_CASES = 7;
const total = pass + fail;
rmSync(TMP, { recursive: true, force: true });
console.log();
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
      `FAIL: ran ${ran} cases, expected ${EXPECTED_CASES} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});
if (fail > 0) {
  console.error(
    `FAIL: ${fail}/${total} cases wrong. check-visual-baselines is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. It catches darwin, catches a platform nobody predicted, refuses\n` +
    `      to answer with no subject, and still accepts a clean linux-only set.`
);
