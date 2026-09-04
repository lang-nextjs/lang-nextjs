#!/usr/bin/env node
/**
 * Self-test — plants each shape the checker claims to catch, and each it must
 * NOT catch.
 *
 * WHY THE REJECT CASES CARRY THE WEIGHT. After #736's site fixes, zero files in
 * this repo import `exec` or `execSync`, so the checker's domain is EMPTY and it
 * passes whether or not it works. That is the #730 lesson verbatim: an ACCEPT
 * case cannot witness a rule, because a checker that examines nothing accepts
 * everything. Only a planted rejection distinguishes them.
 *
 * The accept cases are still load-bearing in the other direction — a checker
 * that refuses every child_process import would score full marks on the rejects
 * and make the argv form unusable.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-child-process-argv-form.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "cpargv-selftest-")));

function tearDown() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on("exit", tearDown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    tearDown();
    process.exit(130);
  });
}

let pass = 0;
let fail = 0;
let n = 0;

/** A sandbox holding `files` as {relative path: contents}. */
function sandbox(files) {
  const dir = join(TMP, `wt-${n++}`);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER, "--cwd", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name.padEnd(62)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL ${name.padEnd(62)} ${detail}`);
  }
}

console.log("assert-child-process-argv-form self-test — plants each shape\n");

// --- REJECT A: R1, the shell form outside e2e/ ------------------------------
{
  const r = run(
    sandbox({
      "scripts/thing.mjs": `import { execSync } from "node:child_process";\nexecSync("docker ps");\n`,
    })
  );
  check(
    "importing execSync outside e2e/ is refused (R1)",
    r.rc === 1 && /\[R1\]/.test(r.out ?? ""),
    r.rc === 1 ? "(refused)" : `(rc=${r.rc} — PASSED, vacuous)`
  );
}

// --- REJECT B: R2 inside e2e/, where R1 does NOT apply ----------------------
{
  // This is the exemption doing work rather than muting: e2e/ may import the
  // shell form, and the property that still holds there — the verdict must
  // survive — is what catches it. This is the shape of the real #736 defect.
  const r = run(
    sandbox({
      "e2e/thing.spec.ts": `import { execSync } from "node:child_process";\nconst ps = execSync(\`docker ps -aq 2>/dev/null || true\`).trim();\n`,
    })
  );
  const r2 = /\[R2\]/.test(r.out ?? "");
  // Bracketed: the remediation footer says "R1 does not apply there", so a
  // bare /R1/ matches the ADVICE, not a finding. A probe answering a broader
  // question than the one asked is the defect this whole file is about.
  const noR1 = !/\[R1\]/.test(r.out ?? "");
  check(
    "in e2e/, `|| true` is refused (R2) while the import itself is not (R1)",
    r.rc === 1 && r2 && noR1,
    `(rc=${r.rc} R2=${r2} R1-absent=${noR1})`
  );
}

// --- ACCEPT A: the exemption is real ---------------------------------------
{
  // Without this, R1 could quietly apply everywhere and every reject case above
  // would still pass — the exemption would be asserted nowhere.
  const r = run(
    sandbox({
      "e2e/thing.spec.ts": `import { execSync } from "node:child_process";\nconst out = execSync("docker ps -aq").trim();\n`,
    })
  );
  check(
    "in e2e/, the shell form WITHOUT a discarded verdict is accepted",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : `(rc=${r.rc} — the exemption does not exist)`
  );
}

// --- ACCEPT B: the argv form, which is what 106 files here already use ------
{
  const r = run(
    sandbox({
      "scripts/a.mjs": `import { execFileSync } from "node:child_process";\nexecFileSync("docker", ["ps", "-aq"]);\n`,
      "scripts/b.mjs": `import { spawnSync, spawn } from "node:child_process";\nspawnSync("docker", ["ps"]);\n`,
      "scripts/c.mjs": `import { execFile } from "node:child_process";\n`,
    })
  );
  check(
    "argv-form imports are accepted, so this is not a ban on child_process",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : `(rc=${r.rc} — over-broad)`
  );
}

// --- ACCEPT C: the over-match cases that defeated a call-site checker -------
{
  /*
   * All three were measured on the real tree as things a call-site grep would
   * report and a human would have to explain away. The import anchor makes them
   * invisible: none of these files imports child_process at all.
   */
  const r = run(
    sandbox({
      "scripts/fixture.mjs": `const job = { container: true, shell: true };\nexport default job;\n`,
      "scripts/opts.mjs": `export const options = { stdio: "pipe" };\n`,
      "scripts/or.mjs": `export const clean = "rm -rf .turbo || true && turbo clean";\n`,
    })
  );
  check(
    "`shell: true`, `stdio: pipe` and `|| true` are invisible without the import",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : `(rc=${r.rc} — the anchor is not holding)`
  );
}

// --- ACCEPT E: fixture TEXT holding an import is data, not an import --------
{
  /*
   * THE REGRESSION THIS EXISTS FOR, and it was found by this file breaking the
   * checker it tests. Self-test fixtures are one-line template literals whose
   * CONTENT is source code, including `import * as cp from "node:child_process"`
   * — so an unanchored import regex reads the fixture as an import and the
   * checker exits 2 on the repo the moment its own self-test lands. Measured
   * before the fix: exit 2. A real import is always the first thing on its
   * line, which is the anchor, and it is preferred to exempting this file by
   * name: a rule that excuses the file testing it is not a rule.
   */
  const r = run(
    sandbox({
      "scripts/harness.mjs": `const fixture = \`import * as cp from "node:child_process";\\ncp.execSync("docker ps || true");\`;\nexport default fixture;\n`,
    })
  );
  check(
    "an import inside a one-line fixture string is data, not a child_process import",
    r.rc === 0,
    r.rc === 0
      ? "(accepted)"
      : `(rc=${r.rc} — the checker cannot read its own self-test)`
  );
}

// --- ACCEPT D / REJECT C: comments are stripped, code is not ---------------
{
  // Paired deliberately. The accept half alone would pass against a checker
  // that had stopped reading the file at all.
  const commented = run(
    sandbox({
      "scripts/doc.mjs": `import { execFileSync } from "node:child_process";\n/**\n * This used to be execSync(\`docker ps 2>/dev/null || true\`), which was wrong.\n */\nexecFileSync("docker", ["ps"]);\n`,
    })
  );
  const live = run(
    sandbox({
      "scripts/doc.mjs": `import { execSync } from "node:child_process";\nexecSync(\`docker ps 2>/dev/null || true\`);\n`,
    })
  );
  check(
    "a comment EXPLAINING the defect is not a defect; the live line still is",
    commented.rc === 0 && live.rc === 1,
    `(commented rc=${commented.rc}, live rc=${live.rc})`
  );
}

// --- REJECT D: the line number is the SOURCE line, not the stripped one -----
{
  /*
   * This checker reported the two real #736 sites at :318 and :487 — offsets
   * into the comment-stripped text — when the source lines are :334 and :503.
   * A finding that points at the wrong line sends the reader to innocent code.
   * The offending line here sits after a 5-line block comment, so a checker
   * that deletes comments rather than blanking them reports 3 instead of 8.
   */
  const r = run(
    sandbox({
      "e2e/x.spec.ts": `import { execSync } from "node:child_process";\n/*\n * one\n * two\n * three\n * four\n */\nconst out = execSync(\`docker ps || true\`);\n`,
    })
  );
  const located = /x\.spec\.ts:8\b/.test(r.out ?? "");
  check(
    "a finding points at the source line, not the comment-stripped offset",
    r.rc === 1 && located,
    located ? "(located at :8)" : `(rc=${r.rc}; no :8 in output)`
  );
}

// --- REJECT E: the require() form is not a way round the rule --------------
{
  const r = run(
    sandbox({
      "scripts/legacy.js": `const { execSync } = require("node:child_process");\nexecSync("docker ps");\n`,
    })
  );
  check(
    "the require() destructuring form is caught too",
    r.rc === 1 && /\[R1\]/.test(r.out ?? ""),
    r.rc === 1
      ? "(refused)"
      : `(rc=${r.rc} — a spelling that bypasses the rule)`
  );
}

// --- REFUSE A: an import this checker cannot resolve ------------------------
{
  // Reporting "no shell-form import" over a file whose bindings were never
  // resolved is a verdict about the wrong subject. Exit 2, not 0.
  const r = run(
    sandbox({
      "scripts/ns.mjs": `import * as cp from "node:child_process";\ncp.execSync("docker ps");\n`,
    })
  );
  check(
    "a namespace import REFUSES (exit 2) rather than reporting clean",
    r.rc === 2 && /REFUSING/.test(r.out ?? ""),
    r.rc === 2
      ? "(refused — could not ask)"
      : `(rc=${r.rc} — unresolved read as clean)`
  );
}

// --- REFUSE C: a capture that spanned something that is not an import -------
{
  /*
   * THE RIGHT ANSWER FROM THE WRONG EVIDENCE.
   *
   * The import patterns are line-anchored at the START, but their inner
   * `[^}]*` crosses newlines — it must, because a multi-line import is
   * ordinary. What bounds it is that `[^}]*` cannot cross a `}`. So the span is
   * BRACE-bounded, not line-bounded, and an adversarial probe showed the
   * difference: a malformed import whose brace stays open across three lines
   * captures them all, yielding a "binding" of `spawnSync\ncon…`. The verdict
   * was correct — that is not `execSync` — and the evidence was junk.
   *
   * DEV1-lang hit the same class in #736 part 2: a whole-file `[^\]]` bracketed
   * a variable across unrelated lines and scored 13/13, the right answer from
   * evidence that was not the evidence. Their rule is the one to keep — "a
   * detector that reads a file as one string is a file-level rule wearing a
   * variable-level costume" — and a total can never reveal it, because the
   * honest and dishonest runs produce the same total. Only a LOCATED match can.
   *
   * So a binding list that is not identifiers refuses rather than passing.
   */
  const r = run(
    sandbox({
      "scripts/f.mjs": `import {\n  spawnSync\nconst decoy = "no closing brace above me"\n} from "node:child_process";\n`,
    })
  );
  const named = /not an identifier/.test(r.out ?? "");
  check(
    "a capture that spanned non-import text REFUSES, and says what it spanned",
    r.rc === 2 && named,
    named
      ? "(refused — names the garbage it captured)"
      : `(rc=${r.rc} — right verdict, unexamined evidence)`
  );
}

// --- REFUSE B: a sweep that examined nothing -------------------------------
{
  const empty = join(TMP, "empty");
  mkdirSync(empty, { recursive: true });
  const r = run(empty);
  check(
    "a sweep that finds no files is refused, not passed",
    r.rc !== 0,
    r.rc !== 0 ? "(refused)" : "(PASSED — a green proving only where it looked)"
  );
}

const total = pass + fail;
if (fail) {
  console.error(
    `\nFAIL: ${fail}/${total} cases wrong. The checker is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Each refused shape was watched being refused, the e2e\n` +
    "      exemption was watched ACCEPTING and its R2 half watched REFUSING, and the\n" +
    "      three call-site false positives were watched staying invisible."
);
