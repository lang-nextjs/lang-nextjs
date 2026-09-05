#!/usr/bin/env node
/**
 * assert-format-writes.mjs — `pnpm format` actually WRITES, observed on disk (#816).
 *
 * WHY A CHECK AND NOT A COMMENT. `scripts/format.mjs` had
 *
 *     const passed = args.length ? args : ["--write", "."];
 *
 * so passing paths replaced the whole default pair and `--write` went with it.
 * prettier then printed formatted output to stdout and left every file byte-identical.
 * It still printed its "formatting with prettier 2.8.8" banner, so it looked exactly
 * like a successful run — a commit was made on the strength of it, and only the gate
 * disagreeing afterwards caught it.
 *
 * A REPAIR THAT SILENTLY DOES NOTHING IS WORSE THAN A MISSING ONE, because the person
 * running it stops looking. That is what makes this worth a per-PR check rather than a
 * note in the file: the failure is invisible at the moment it happens and only shows up
 * later, attributed to something else.
 *
 * IT OBSERVES THE TREE, NOT THE OUTPUT, AND THAT IS THE DESIGN. The two invocations are
 * distinguishable from stdout — the broken one prints FILE CONTENTS, the working one
 * prints per-file timings — so the cheap check is to grep stdout for a line ending in
 * "<n>ms". That is a proxy for the thing rather than the thing:
 *
 *   - it passes for a `--write` run over an already-clean tree, where nothing was
 *     written and nothing needed to be;
 *   - it breaks the day prettier changes how it reports, which is a version bump away;
 *   - and it is the command's report ABOUT ITSELF, which is the class of evidence that
 *     produced every silent failure this repo has spent the week on.
 *
 * So: plant a file that needs formatting, run the tool the way a contributor does, and
 * compare the bytes on disk before and after. The only evidence accepted is the file.
 *
 * WHAT IT DOES NOT COVER, said plainly: the bare no-argument invocation, whose subject
 * is the whole branch. Driving that needs a repository, and `format.mjs` resolves its
 * subject from its own location rather than from a `--cwd`, so a check could only run
 * it against THIS tree — formatting the working copy as a side effect of checking it.
 * The bare form's SUBJECT is covered instead by it sharing `analyse()` with the gate,
 * which is a structural guarantee rather than a test.
 *
 * Usage: node scripts/assert-format-writes.mjs
 * Exit: 0 every form writes as declared · 1 a form did not · 2 could not ask
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/*
 * OVERRIDABLE SO THE PROOF CAN DRIVE A MUTANT, and the mutant lives in a temp
 * directory rather than beside this file. A copy under scripts/ would join the
 * subject of assert-formatted and assert-checkers-registered, so the act of proving
 * this checker would fail two others — the trap DEV2 hit on #823, where an inserted
 * mutation made the checker's own file unformatted and the formatting gate fired
 * first, before the assertion under test was ever reached.
 */
const FORMAT = (() => {
  const i = process.argv.indexOf("--format");
  return i !== -1 ? process.argv[i + 1] : join(ROOT, "scripts", "format.mjs");
})();

/** Deliberately ugly under any prettier config: double spaces, no semicolon. */
const UGLY = "export const a  =   1\n";

/**
 * THE INVOCATION FORMS A CONTRIBUTOR ACTUALLY TYPES, each with what it must do to the
 * file. `writes: false` is not a hole — `--check` writing would be its own defect, and
 * a form that must NOT write is what proves the check can tell the two apart rather
 * than passing anything that runs.
 */
const FORMS = [
  { label: "a path argument", args: (f) => [f], writes: true },
  { label: "--write and a path", args: (f) => ["--write", f], writes: true },
  { label: "--check and a path", args: (f) => ["--check", f], writes: false },
];

function run(args, cwd) {
  try {
    execFileSync("node", [FORMAT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return typeof e?.status === "number" ? e.status : 1;
  }
}

const dir = mkdtempSync(join(tmpdir(), "format-writes-"));
const problems = [];
let checked = 0;

try {
  /*
   * THE POSITIVE CONTROL COMES FIRST. If the planted file were already formatted, every
   * `writes: true` case would report "unchanged" and this checker would fail for a
   * reason that has nothing to do with format.mjs. Asking prettier directly whether the
   * plant needs formatting separates "the tool did not write" from "there was nothing
   * to write", which are the two readings of an identical observation.
   */
  const probe = join(dir, "probe.ts");
  writeFileSync(probe, UGLY);
  const before = readFileSync(probe, "utf8");
  const rc = run(["--check", probe], dir);
  if (rc === 0) {
    console.error(
      `REFUSE: the planted file is already considered formatted, so "unchanged after ` +
        `formatting" would prove nothing.\n        Nothing was checked.`
    );
    process.exit(2);
  }
  if (readFileSync(probe, "utf8") !== before) {
    console.error(
      `REFUSE: --check MODIFIED the probe, so the control itself writes and no ` +
        `before/after comparison below can be attributed.\n        Nothing was checked.`
    );
    process.exit(2);
  }

  for (const form of FORMS) {
    const f = join(dir, `case-${checked}.ts`);
    writeFileSync(f, UGLY);
    const was = readFileSync(f, "utf8");
    run(form.args(f), dir);
    const now = readFileSync(f, "utf8");
    const changed = now !== was;
    checked++;

    if (changed !== form.writes)
      problems.push(
        form.writes
          ? `${form.label}: the file is BYTE-IDENTICAL after formatting. prettier was ` +
              `run without --write, so it printed to stdout and wrote nothing — the ` +
              `invocation reports success and does nothing.`
          : `${form.label}: the file CHANGED. This form must not write; a check that ` +
              `rewrites the tree it was asked to inspect is not a check.`
      );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(
    `FAIL: ${problems.length} invocation form(s) did not behave as declared:`
  );
  problems.forEach((p) => console.error(`   - ${p}`));
  console.error(
    `\n  scripts/format.mjs decides this. \`--write\` must be ADDED to the paths a caller\n` +
      `  passes, never defaulted in a branch that arguments replace, or passing a path\n` +
      `  silently removes it.`
  );
  process.exit(1);
}

reportSubject(checked, "invocation form(s) of `pnpm format`, verified on disk");
console.log(
  `PASS: every form writes exactly when it should, measured by comparing file bytes.`
);
