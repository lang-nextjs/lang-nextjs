#!/usr/bin/env node
/**
 * PROOF FOR assert-no-install-blocking-paths.mjs, AND FOR THE .gitignore PATTERN (#585).
 *
 * TWO SUBJECTS, DELIBERATELY, because the fix has two halves that fail differently:
 *
 *   PREVENTION   the .gitignore pattern, which stops the common case and cannot report
 *                anything. Tested by PLANTING: make the symlink, run `git add -A`, and
 *                assert git did not stage it.
 *   EXPLANATION  the checker, which cannot stop anything and names what got through.
 *
 * THE PREVENTION CASES DRIVE THE REPO'S REAL .gitignore — it is copied into each fixture
 * rather than retyped. A fixture with its own hand-written pattern would assert that a string
 * I just wrote behaves the way I think it does, which is true by construction and says
 * nothing about the file that ships. This is the same argument as the conformance suites
 * driving both real implementations rather than a shared copy.
 *
 * WHY PLANTING RATHER THAN READING, in this case specifically: the defect was that
 * `node_modules/` looks like it covers node_modules and does not. Reading the pattern is
 * exactly the operation that produced the wrong answer for everyone who looked at it, twice.
 * Only `git add -A` knows.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-no-install-blocking-paths.mjs");
const REAL_GITIGNORE = resolve(HERE, "..", ".gitignore");

let pass = 0,
  fail = 0;
const rows = [];
const ok = (name, cond, detail) => {
  rows.push({ name, cond, detail });
  cond ? pass++ : fail++;
};

const git = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A repo carrying the REPO'S OWN .gitignore, so the pattern under test is the shipped one. */
function repo({ withGitignore = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "blocking-paths-"));
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "proof@example.com");
  git(d, "config", "user.name", "proof");
  if (withGitignore) copyFileSync(REAL_GITIGNORE, join(d, ".gitignore"));
  writeFileSync(
    join(d, "keep.txt"),
    "a tracked file so the index is never empty\n"
  );
  return d;
}

function run(cwd) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--cwd", cwd], { encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const staged = (d) =>
  git(d, "diff", "--cached", "--name-only").split("\n").filter(Boolean);

console.log(
  "\nassert-no-install-blocking-paths — the pattern prevents, the checker explains\n"
);

/* ── PREVENTION: the real .gitignore, exercised by git itself ─────────────────────────── */
{
  const d = repo();
  symlinkSync("/private/tmp/somewhere/node_modules", join(d, "node_modules"));
  git(d, "add", "-A");
  ok(
    "a SYMLINK named node_modules is not staged by `git add -A`",
    !staged(d).includes("node_modules"),
    staged(d).includes("node_modules")
      ? "STAGED — the pattern still misses symlinks"
      : "ignored"
  );
}
{
  const d = repo();
  mkdirSync(join(d, "node_modules"));
  writeFileSync(join(d, "node_modules", "pkg.js"), "x\n");
  git(d, "add", "-A");
  ok(
    "...and a real node_modules DIRECTORY is still ignored too",
    !staged(d).some((p) => p.startsWith("node_modules")),
    "ignored"
  );
}
{
  /*
   * THE COMPANION FOR BOTH ABOVE. Without it, a fixture where `git add -A` stages nothing at
   * all — a bad path, a broken index — satisfies them while proving nothing. A symlink under
   * a name the pattern does not cover MUST be staged, which shows git is willing to stage
   * symlinks here and that the two passes above are the pattern doing work.
   */
  const d = repo();
  symlinkSync("/private/tmp/somewhere/else", join(d, "vendor-link"));
  git(d, "add", "-A");
  ok(
    "a symlink the pattern does NOT name is staged — so the passes above are the pattern",
    staged(d).includes("vendor-link"),
    staged(d).includes("vendor-link")
      ? "staged, as it must be"
      : "NOT staged — harness is inert"
  );
}
{
  const d = repo({ withGitignore: false });
  symlinkSync("/private/tmp/somewhere/node_modules", join(d, "node_modules"));
  git(d, "add", "-A");
  ok(
    "WITHOUT the .gitignore the same symlink IS staged — the original defect",
    staged(d).includes("node_modules"),
    "reproduced"
  );
}

/* ── EXPLANATION: the checker, over trees that already carry the problem ──────────────── */
{
  const d = repo({ withGitignore: false });
  symlinkSync("/private/tmp/shared/node_modules", join(d, "node_modules"));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "planted");
  const r = run(d);
  ok(
    "a tracked node_modules symlink FAILS, naming the path",
    r.code === 1 && r.out.includes("node_modules") && /ENOTDIR/.test(r.out),
    `exit ${r.code}${
      r.out.includes("ENOTDIR") ? ", explains the install failure" : ""
    }`
  );
}
{
  const d = repo();
  symlinkSync("/Users/someone/elsewhere", join(d, "vendor-link"));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "planted");
  const r = run(d);
  ok(
    "an absolute symlink under ANY name fails — the case the pattern cannot cover",
    r.code === 1 && r.out.includes("vendor-link"),
    `exit ${r.code}`
  );
}
{
  /*
   * THE COMPANION THAT KEEPS THE TWO ABOVE MEANINGFUL. A checker that flagged every symlink
   * would pass them both. A RELATIVE symlink travels with the tree and is correct in every
   * checkout, so it must not be flagged.
   */
  const d = repo();
  mkdirSync(join(d, "pkg"));
  writeFileSync(join(d, "pkg", "real.txt"), "x\n");
  symlinkSync("../pkg/real.txt", join(d, "alias.txt"));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "relative");
  const r = run(d);
  ok(
    "a RELATIVE symlink is NOT flagged — it travels with the tree",
    r.code === 0,
    `exit ${r.code}`
  );
}
{
  const d = repo();
  git(d, "add", "-A");
  git(d, "commit", "-qm", "clean");
  const r = run(d);
  ok(
    "a clean tree passes and says how much it examined",
    r.code === 0 && /tracked path\(s\) examined/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const d = mkdtempSync(join(tmpdir(), "blocking-empty-"));
  git(d, "init", "-q", "-b", "main");
  const r = run(d);
  ok(
    "an EMPTY index is exit 2, not a green over nothing",
    r.code === 2 && /no tracked files/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const d = mkdtempSync(join(tmpdir(), "blocking-nogit-"));
  const r = run(d);
  ok(
    "not a git repository is exit 2, not a green",
    r.code === 2,
    `exit ${r.code}`
  );
}

/* ── REPORT ───────────────────────────────────────────────────────────────────────────── */
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows)
  console.log(
    `  ${r.cond ? "ok  " : "FAIL"} ${r.name.padEnd(w)}  (${r.detail})`
  );
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${rows.length} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${rows.length}. The shipped .gitignore refuses the symlink git would\n` +
    `      otherwise stage, and the checker names what a forced add or a different name\n` +
    `      still gets through.`
);
