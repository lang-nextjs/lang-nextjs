#!/usr/bin/env node
/**
 * THE CLASSIFIER'S INPUT IS PRESERVED, AND THE PATH IT IS WRITTEN TO IS THE PATH
 * THAT GETS COLLECTED (#440).
 *
 * WHY THIS EXISTS. `E2E — open-swe live transport` publishes a verdict that is a
 * pure function of one file on the runner. At 7e46fa6 that job reported
 * `TRANSPORT_DEFECT defects=2 upstream=2`, and the same classifier at the same
 * commit, fed the published job log, returned `UPSTREAM_UNAVAILABLE defects=0
 * upstream=4` — the opposite verdict AND the opposite retry advice. The file was
 * gone, only `cat "$log"` had ever reached the job log, and a job log is a
 * rendering rather than the file. Neither answer could be checked. That is not a
 * bug in the classifier; it is a property of the pipeline, and it makes every
 * future disagreement unresolvable by construction — including any claim that a
 * fix worked.
 *
 * WHAT IT ASSERTS, and all of it is one shape: TWO FACTS THAT MUST AGREE WITH
 * NOTHING OTHERWISE MAKING THEM AGREE. The wrapper writes to a directory; the
 * workflow collects a directory; a reviewer reads them in different files, weeks
 * apart. A change to either alone fails as a working pipeline that silently
 * preserves nothing, and an empty artifact looks exactly like a clean run.
 *
 *   1. At least one step actually invokes the wrapper. WITHOUT THIS THE WHOLE
 *      CHECK IS VACUOUS: every per-step assertion below passes trivially over an
 *      empty set, so a rename of the step or the script would leave this file
 *      green while it no longer examines anything.
 *   2. Every invoking step sets LIVE_TRANSPORT_LOG_DIR, and to a DISTINCT value.
 *      Both runtimes call the same wrapper, whose default is /tmp, so sharing a
 *      directory means the second run overwrites the first and the artifact does
 *      not say which runtime it came from.
 *   3. An upload step exists whose glob covers every one of those directories.
 *   4. That step is `if: always()`. Not symmetry — a verdict of PASS is exactly
 *      as unauditable as a verdict of DEFECT, and a classifier that wrongly
 *      passes is the failure this job exists to prevent.
 *   5. The wrapper writes its logs under $LOG_DIR and fingerprints each one, so
 *      the job log records whether the uploaded bytes are the bytes that ran.
 *
 * Exported as a pure function of the two file texts so the selftest can drive
 * every failure mode by mutating strings, including the vacuous one, rather than
 * by rewriting the repo's real workflow.
 */

import { readFileSync } from "node:fs";

import { invokedAsProgram } from "./lib/is-main.mjs";
const WRAPPER = "scripts/live-transport-with-retry.sh";
const WORKFLOW = ".github/workflows/e2e.yml";
const JOB = "e2e-live-transport";
const LOG_DIR_VAR = "LIVE_TRANSPORT_LOG_DIR";

/** Lines of the named job block, by indentation. */
function jobBlock(workflowText, job) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `  ${job}:`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    // A line at the job's own indent (2 spaces, non-space at col 3) ends it.
    if (/^ {2}\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** Split a job's lines into steps at `- name:` boundaries. */
function steps(jobLines) {
  const out = [];
  let cur = null;
  for (const l of jobLines) {
    const m = l.match(/^\s*- name: (.*)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1].trim(), lines: [l] };
    } else if (cur) cur.lines.push(l);
  }
  if (cur) out.push(cur);
  return out;
}

const value = (stepLines, key) => {
  const m = stepLines
    .join("\n")
    .match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
};

/** `a/live-transport-*\/` covers `a/live-transport-django`. */
function globCovers(glob, dir) {
  const norm = (s) => s.replace(/\/+$/, "");
  const rx = new RegExp(
    "^" +
      norm(glob)
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*") +
      "$"
  );
  return rx.test(norm(dir));
}

export function checkLiveLogArtifact({ workflowText, wrapperText }) {
  const problems = [];
  const jobLines = jobBlock(workflowText, JOB);
  if (!jobLines) return [`job \`${JOB}\` not found in ${WORKFLOW}`];

  const all = steps(jobLines);
  const invoking = all.filter((s) => s.lines.join("\n").includes(WRAPPER));

  /*
   * THE SUBJECT CHECK, FIRST AND LOUDEST. Everything below iterates `invoking`,
   * so an empty set makes this file report success while examining nothing —
   * the exact failure mode it was written to prevent elsewhere.
   */
  if (invoking.length === 0) {
    return [
      `no step in \`${JOB}\` invokes ${WRAPPER} — this check has lost its ` +
        `subject and every assertion below it would pass vacuously. If the ` +
        `script or the job was renamed, update this checker in the same commit.`,
    ];
  }

  const dirs = [];
  for (const s of invoking) {
    const dir = value(s.lines, LOG_DIR_VAR);
    if (!dir) {
      problems.push(
        `step "${s.name}" invokes the wrapper without setting ${LOG_DIR_VAR}, ` +
          `so it writes to the wrapper's /tmp default and is not collected`
      );
      continue;
    }
    if (dirs.includes(dir)) {
      problems.push(
        `step "${s.name}" reuses ${LOG_DIR_VAR}=${dir}; two invocations sharing ` +
          `a directory overwrite each other and the artifact cannot say which ` +
          `runtime produced the log`
      );
    }
    dirs.push(dir);
  }

  const uploads = all.filter((s) =>
    s.lines.join("\n").includes("actions/upload-artifact")
  );
  for (const dir of dirs) {
    const covering = uploads.filter((u) => {
      const p = value(u.lines, "path");
      return p && globCovers(p, dir);
    });
    if (covering.length === 0) {
      problems.push(
        `${LOG_DIR_VAR}=${dir} is written but no upload-artifact step collects ` +
          `it — the classifier's input would not survive the run`
      );
      continue;
    }
    for (const u of covering) {
      const cond = value(u.lines, "if");
      if (cond !== "always()") {
        problems.push(
          `upload step "${u.name}" collects ${dir} with \`if: ${cond}\` — a PASS ` +
            `is as unauditable as a failure, so this must be \`if: always()\``
        );
      }
    }
  }

  // The other half of the pair: the wrapper must write where the workflow looks.
  if (!/\$LOG_DIR\/live-transport\.log/.test(wrapperText)) {
    problems.push(
      `${WRAPPER} no longer writes its first-attempt log under $LOG_DIR, so the ` +
        `directory the workflow collects would be empty`
    );
  }
  if (!/LIVE_TRANSPORT_LOG_FINGERPRINT/.test(wrapperText)) {
    problems.push(
      `${WRAPPER} no longer prints LIVE_TRANSPORT_LOG_FINGERPRINT — without it ` +
        `the job log cannot say whether the uploaded bytes are the ones classified`
    );
  }
  return problems;
}

if (invokedAsProgram(import.meta.url)) {
  const problems = checkLiveLogArtifact({
    workflowText: readFileSync(WORKFLOW, "utf-8"),
    wrapperText: readFileSync(WRAPPER, "utf-8"),
  });
  if (problems.length) {
    console.error(
      "FAIL: the live-transport classifier input is not preserved.\n"
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    "ok: every live-transport invocation writes to a distinct collected " +
      "directory, uploaded unconditionally and fingerprinted in the job log."
  );
}
