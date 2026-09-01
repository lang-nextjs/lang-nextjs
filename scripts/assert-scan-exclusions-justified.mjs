#!/usr/bin/env node
/**
 * EVERY THING THE SECURITY SCAN DOES NOT LOOK AT MUST SAY WHY (#632).
 *
 * security.yml excluded apps/django-backend and apps/fastapi-backend from semgrep, and nothing
 * anywhere recorded a reason. That is a step past the failure mode this repo keeps finding: not
 * an EXPIRED premise but an ABSENT one. An expired premise can be caught by re-reading the
 * stated reason and noticing it is no longer true; an absent one can only be caught by asking
 * why each entry is there, which nobody does for a list that looks homogeneous — and that list
 * looked homogeneous, because its five other entries were all build artifacts. The surrounding
 * context supplied a reason that was never written and was not true.
 *
 * It is the most expensive place in the repo for that to happen, because the job is GREEN
 * either way. A checker that skips something reports success exactly as loudly as one that
 * examined it.
 *
 * SCOPED TO security.yml ON PURPOSE. An `--exclude` elsewhere narrows a build or a test run,
 * and being wrong there shows up as something not working. Here it narrows what is looked at
 * for vulnerabilities, and being wrong shows up as nothing at all.
 *
 * THE RULE: each `--exclude=X` must be immediately preceded by comment lines that name X.
 * Adjacency is the point — a reason somewhere else in the file is a reason nobody will read
 * next to the line they are editing, and a reason that does not name what it excuses can be
 * left behind when the entry it described is replaced.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "security.yml");

/**
 * @returns {{problems: string[], excluded: string[]}}
 */
export function audit(yaml) {
  const problems = [];
  const excluded = [];
  const lines = yaml.split("\n");

  /*
   * THE SUBJECT HAS TO BE THERE. Zero excludes is a legitimate state — it means nothing is
   * skipped — but it is indistinguishable from "this parse is looking at the wrong file" unless
   * the scan command itself is found. Without that anchor, a renamed job or a moved step would
   * make this report "every exclusion is justified" about a file containing no scan at all.
   */
  if (!lines.some((l) => l.includes("semgrep scan")))
    return {
      problems: [
        "REFUSING: no `semgrep scan` invocation found in security.yml, so there is no scan " +
          "whose exclusions could be audited. The step moved or was renamed; either way this " +
          "check examined nothing, which is not the same as finding nothing wrong.",
      ],
      excluded,
    };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/--exclude=(\S+)/);
    if (!m) continue;
    const value = m[1].replace(/["'\\]/g, "");
    excluded.push(value);

    // The contiguous run of comment lines directly above this one is its reason.
    const reason = [];
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t.startsWith("#")) {
        reason.unshift(t.replace(/^#\s?/, ""));
        continue;
      }
      break;
    }

    if (reason.length === 0) {
      problems.push(
        `--exclude=${value} has no reason above it. An exclusion nobody justified is one nobody ` +
          `can notice has stopped being justified, and this scan stays green whether it looks ` +
          `at ${value} or not.`
      );
      continue;
    }
    if (!reason.some((r) => r.includes(value)))
      problems.push(
        `--exclude=${value} is preceded by a comment that never names ${value}. A reason that ` +
          `does not say what it excuses survives the entry it was written for — the next person ` +
          `to change this list inherits prose about something else and reads it as cover.`
      );
  }

  problems.push(...shellProblems(lines));
  return { problems, excluded };
}

/**
 * A CONTAINER JOB THAT USES BASH SYNTAX MUST SAY SO (#641).
 *
 * The exclusions are an array because that is the only shape in which each one can carry a
 * comment naming it — a backslash-continued command cannot hold comments, since a `#` on a
 * continued line comments out the rest of the command. So the reason this file's exclusions are
 * auditable at all is a bash construct, and that makes the shell part of the same decision.
 *
 * WHY IT IS EASY TO GET WRONG, and it was: NO step in security.yml declares a shell. On a normal
 * runner GitHub defaults to bash, which is why the gitleaks job's `ARGS=(…)` has always worked.
 * A job with `container:` defaults to `sh` instead. Same file, no shell key anywhere, two
 * interpreters — and in the semgrep image /bin/sh is busybox, which has no arrays at all. The
 * step died with `syntax error: unexpected "("` at exit 2, before semgrep ran.
 *
 * SCOPED TO CONTAINER JOBS ON PURPOSE. Requiring `shell:` everywhere would flag the gitleaks
 * job, which correctly relies on the runner default. The rule is only true where the default
 * changes.
 */
export function shellProblems(lines) {
  const problems = [];
  const jobAt = (i) => {
    // Walk back to the enclosing top-level job key (two-space indent).
    for (let j = i; j >= 0; j--)
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) return j;
    return -1;
  };
  const jobEnd = (start) => {
    for (let j = start + 1; j < lines.length; j++)
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) return j;
    return lines.length;
  };

  for (let i = 0; i < lines.length; i++) {
    // An array literal assignment is the construct that needs bash.
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*=\(\s*$/.test(lines[i])) continue;
    const js = jobAt(i);
    if (js < 0) continue;
    const job = lines.slice(js, jobEnd(js));
    const jobName = lines[js].trim().replace(/:$/, "");
    if (!job.some((l) => /^\s{4}container:/.test(l))) continue; // runner default is bash

    /*
     * The step is the run: block this array sits in. Search back from the array for the nearest
     * `- name:` and forward to the end of that step, then require a shell declaration in it.
     */
    let stepStart = js;
    for (let j = i; j > js; j--)
      if (/^\s*- name:/.test(lines[j])) {
        stepStart = j;
        break;
      }
    let stepEnd = lines.length;
    for (let j = stepStart + 1; j < lines.length; j++)
      if (
        /^\s*- name:/.test(lines[j]) ||
        /^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])
      ) {
        stepEnd = j;
        break;
      }
    const step = lines.slice(stepStart, stepEnd);
    if (!step.some((l) => /^\s*shell:\s*bash\s*$/.test(l)))
      problems.push(
        `job "${jobName}" runs in a CONTAINER and a step in it uses a bash array ` +
          `(${lines[
            i
          ].trim()}) without declaring \`shell: bash\`. Container jobs default to ` +
          `sh — busybox here, which has no arrays — so this is a parse error at exit 2 before ` +
          `the command runs, not a finding. Add \`shell: bash\` to that step.`
      );
  }
  return problems;
}

function main() {
  if (!existsSync(WORKFLOW)) {
    console.error(
      `REFUSING TO RUN: ${WORKFLOW} does not exist, so the set of scan exclusions cannot be\n` +
        `read. Exiting 2 — not checked is not the same as nothing excluded.`
    );
    process.exit(2);
  }
  const { problems, excluded } = audit(readFileSync(WORKFLOW, "utf8"));
  if (problems.length) {
    if (problems[0].startsWith("REFUSING")) {
      console.error(`\n${problems[0]}\n`);
      process.exit(2);
    }
    console.error(
      `\nFAIL: ${problems.length} scan exclusion(s) in security.yml carry no usable reason.\n`
    );
    for (const p of problems) console.error(`  · ${p}\n`);
    process.exit(1);
  }
  console.log(
    `PASS: all ${excluded.length} semgrep exclusion(s) in security.yml are named and justified\n` +
      `      on the lines above them (${excluded.join(
        ", "
      )}). The python backends are no\n` +
      `      longer among them, and the container job that reads that array declares bash.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
