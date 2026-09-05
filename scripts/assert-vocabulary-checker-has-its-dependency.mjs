#!/usr/bin/env node
/**
 * assert-vocabulary-checker-has-its-dependency.mjs — one coupling, asserted (#779).
 *
 * THE COUPLING. `assert-approval-vocabulary-agrees.mjs` asks an INSTALLED langchain what
 * `interrupt_on={t: True}` expands to. It can only answer where the backend's requirements are
 * installed, and ci.yml puts that install in a DIFFERENT STEP, under a different
 * working-directory, whose name says it is about something else:
 *
 *     - name: FastAPI backend tests          <- the install lives here
 *         working-directory: apps/fastapi-backend
 *         pip install -r requirements.txt
 *     - name: The approval vocabulary we offer is one the parser accepts (#669)
 *         working-directory: .
 *         node scripts/assert-approval-vocabulary-agrees.mjs --python "$(command -v python)"
 *
 * Nothing connected them. Rename that step, reorder it, move its install, or split the job, and
 * the checker exits 2 forever — CORRECTLY and LOUDLY, and permanently, which is the shape a
 * recorded-but-unasserted dependency always fails into. #778 wrote the reason down; a record is
 * not an assertion, and the exclusion reason in checks.json was itself measured wrong twice
 * because it cited a line number rather than a name.
 *
 * WHY WORKING-DIRECTORY IS NOT PART OF THE PROPERTY. `pip install` puts packages in the JOB'S
 * python environment, not in a directory, so the checker at `working-directory: .` sees them
 * regardless. The install's directory decides WHICH requirements.txt is read, which is why it
 * is reported — but it is not what the coupling depends on. Asserting it would fail on a
 * correct rearrangement.
 *
 * DELIBERATELY ONE COUPLING, NOT A RULE ABOUT STEP ORDER. A general mechanism would need a
 * population nobody has established and a YAML parser this repo does not have. This names the
 * two steps it is about.
 *
 * NON-VACUITY, AND IT IS THE PART THAT COULD GO WRONG SILENTLY. "Same job" is trivially true of
 * a workflow the scanner sees as ONE job, so a job detector that under-finds turns this check
 * into a tautology that passes forever. It therefore REFUSES unless it finds at least two jobs —
 * the positive control DEV3-lang used when establishing there is no boundary between these two
 * steps, kept as a runtime guard rather than as a one-off measurement.
 *
 * Exit 0 the coupling holds · 1 it is broken · 2 could not ask.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/ci.yml";
const CHECKER = "assert-approval-vocabulary-agrees.mjs";
const REQUIREMENTS = "requirements.txt";

/** Top-level job keys, which start after the `jobs:` line — `on:` has keys of the same shape. */
export function jobsIn(lines) {
  const at = lines.findIndex((l) => l === "jobs:");
  if (at === -1) return [];
  const out = [];
  for (let i = at + 1; i < lines.length; i++)
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i]))
      out.push({ line: i + 1, name: lines[i].trim().slice(0, -1) });
  return out;
}

/** Every `- name:` step, so a line can be reported by the step a reader would look for. */
export function stepsIn(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\s*- name: (.+)$/.exec(l);
    if (m) out.push({ line: i + 1, name: m[1].trim() });
  });
  return out;
}

const owner = (list, line) =>
  list.filter((x) => x.line <= line).slice(-1)[0] ?? null;

/**
 * Where the checker is invoked and where its dependency is installed, with the job and step
 * each belongs to. Lines are found by NAME, never by number: every line citation about this
 * file has been wrong at least once today.
 */
export function locate(source) {
  const lines = source.split("\n");
  const jobs = jobsIn(lines);
  const steps = stepsIn(lines);
  const find = (pred) =>
    lines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter((x) => !/^\s*#/.test(x.text) && pred(x.text));
  return {
    jobs,
    checker: find((t) => t.includes(CHECKER) && /\bnode\b/.test(t)).map(
      (x) => ({
        ...x,
        job: owner(jobs, x.line),
        step: owner(steps, x.line),
      })
    ),
    installs: find(
      (t) => /\bpip install\b/.test(t) && t.includes(REQUIREMENTS)
    ).map((x) => ({
      ...x,
      job: owner(jobs, x.line),
      step: owner(steps, x.line),
    })),
  };
}

function main() {
  let source;
  try {
    source = readFileSync(join(ROOT, WORKFLOW), "utf8");
  } catch (e) {
    console.error(
      `COULD NOT COMPUTE: ${WORKFLOW} is unreadable — ${e.message}\n` +
        `      This asks where two steps sit relative to each other; with no workflow there\n` +
        `      is nothing to ask it of.`
    );
    process.exit(2);
  }

  const { jobs, checker, installs } = locate(source);

  if (jobs.length < 2) {
    console.error(
      `COULD NOT COMPUTE: found ${jobs.length} job(s) in ${WORKFLOW}. "the same job" is\n` +
        `      trivially true of a workflow with one, so a green here would mean the job\n` +
        `      scanner stopped working rather than that the coupling holds.`
    );
    process.exit(2);
  }
  if (checker.length === 0) {
    console.error(
      `COULD NOT COMPUTE: no step in ${WORKFLOW} invokes ${CHECKER}.\n` +
        `      It may have moved to another workflow, which is legitimate — but this run is\n` +
        `      NOT evidence that its dependency is still satisfied wherever it went.`
    );
    process.exit(2);
  }

  const problems = [];
  for (const c of checker) {
    const before = installs.filter(
      (i) => i.job?.name === c.job?.name && i.line < c.line
    );
    if (before.length === 0)
      problems.push(
        `  · ${CHECKER} runs in job "${c.job?.name}" at step "${c.step?.name}"\n` +
          `    and NO step installs ${REQUIREMENTS} earlier in that job.\n` +
          `    Installs found: ${
            installs.length === 0
              ? "none anywhere in this workflow"
              : installs
                  .map((i) => `job "${i.job?.name}" step "${i.step?.name}"`)
                  .join("; ")
          }`
      );
  }

  if (problems.length) {
    console.error(
      `THE VOCABULARY CHECKER HAS LOST ITS DEPENDENCY.\n\n${problems.join(
        "\n\n"
      )}\n\n` +
        `  It asks an INSTALLED langchain what interrupt_on expands to, so without that\n` +
        `  install it exits 2 — correctly, loudly, and forever. A permanent correct refusal\n` +
        `  is not a working check; it is furniture (#778).\n`
    );
    process.exit(1);
  }

  reportSubject(checker.length, "checker invocation(s) paired with an install");
  for (const c of checker) {
    const i = installs.filter(
      (x) => x.job?.name === c.job?.name && x.line < c.line
    )[0];
    console.log(
      `PASS: "${c.step?.name}" is preceded in job "${c.job?.name}" by "${i.step?.name}",\n` +
        `      which installs ${REQUIREMENTS}. Same job, and before — so the interpreter the\n` +
        `      checker asks has the package whose vocabulary it is checking.`
    );
  }
}

if (invokedAsProgram(import.meta.url)) main();
