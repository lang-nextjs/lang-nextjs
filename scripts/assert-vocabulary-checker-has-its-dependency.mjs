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
 * AND THE MARGIN IS ZERO, WHICH IS WORTH KNOWING BEFORE IT FIRES (DEV3-lang). ci.yml has
 * EXACTLY TWO jobs, and the threshold is `< 2` — so consolidating `ci` and `python` into one
 * job flips this checker to a PERMANENT REFUSAL. That is correct behaviour and it is one edit
 * away, and a refusal nobody expects reads as a defect in the checker rather than as the
 * property it is reporting. The threshold cannot be lowered without making the guard vacuous,
 * so the note is the mitigation.
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
/**
 * The step-level attributes that decide whether a DECLARED step actually RUNS (#879).
 *
 * "Same job, and before" is a fact about the FILE. The property the coupling needs is a
 * fact about the RUN, and two attributes break the inference between them:
 *
 *   continue-on-error: true   the install may FAIL and the job carries on, so the checker
 *                             runs against an interpreter with nothing installed
 *   if: <anything>            the install may be SKIPPED, with the same result
 *
 * Read at the step's OWN attribute indent — one level in from its `- name:` — so a shell
 * `if` inside a `run:` block is not mistaken for a step condition. That distinction is why
 * this scans by indent rather than by keyword.
 *
 * `continue-on-error: false` is the default spelled out and does not break anything, so it
 * is not reported. Anything else, INCLUDING an expression, is unanswerable from the file.
 */
export function stepGuards(lines, stepLine, nextStepLine) {
  const indent = /^(\s*)- /.exec(lines[stepLine - 1] ?? "")?.[1] ?? "";
  const attr = new RegExp(`^${indent}  (if|continue-on-error):\\s*(.*)$`);
  const end = nextStepLine ? nextStepLine - 1 : lines.length;
  const out = [];
  for (let i = stepLine; i < end; i++) {
    const m = attr.exec(lines[i] ?? "");
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === "continue-on-error" && value === "false") continue;
    out.push({ key: m[1], value, line: i + 1 });
  }
  return out;
}

export function stepsIn(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\s*- name: (.+)$/.exec(l);
    if (m) out.push({ line: i + 1, name: m[1].trim() });
  });
  return out;
}

/**
 * Every line that is SHELL a step actually runs, with its command text isolated (#813 review).
 *
 * WHY BLOCK MEMBERSHIP AND NOT A `run:` LINE. DEV3-lang drove the comment arm directly and found
 * it accepts `run: echo hi  # pip install -r requirements.txt` — the old filter dropped lines
 * that START with `#`, so a TRAILING comment survived and the predicate matched the prose inside
 * it. A rejection arm with a hole in the category it rejects.
 *
 * Their repair is to require the match to be in a `run:` directive rather than to strip comments,
 * and the second half of that is right while the first needs care: ci.yml's real install is at
 * :904, FOUR LINES INSIDE a `run: |` block. A rule keyed on the `run:` line itself would miss it
 * and break the acceptance case — so membership is the block, not the line.
 *
 * WITHIN A RUN BLOCK WE ARE READING SHELL, NOT YAML, and a shell comment begins at a
 * line-initial `#` or a whitespace-preceded ` #`. Cutting there is reading shell correctly rather
 * than guessing at prose — the distinction that matters, because "strip anything after a hash"
 * would also cut a `#` inside a quoted string. Stated rather than hidden: a `#` inside single or
 * double quotes is NOT handled, and an install written after one would be missed. No such line
 * exists in this workflow and the failure direction is a false FAIL, not a false pass.
 */
export function commandLines(lines) {
  const out = [];
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const indent = text.search(/\S/);
    if (indent === -1) continue;
    if (blockIndent !== null && indent <= blockIndent) blockIndent = null;
    const run = /^(\s*)run:\s*(.*)$/.exec(text);
    if (run) {
      blockIndent = run[1].length;
      if (run[2] && !/^[|>]/.test(run[2]))
        out.push({ line: i + 1, text, command: shellCommand(run[2]) });
      continue;
    }
    if (blockIndent !== null)
      out.push({ line: i + 1, text, command: shellCommand(text) });
  }
  return out;
}

/** The command half of a shell line: everything before a line-initial or ` #` comment. */
export function shellCommand(text) {
  if (/^\s*#/.test(text)) return "";
  const at = text.search(/\s#/);
  return at === -1 ? text : text.slice(0, at);
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
  const find = (pred) => commandLines(lines).filter((x) => pred(x.command));
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
      `FAIL: THE VOCABULARY CHECKER HAS LOST ITS DEPENDENCY.\n\n${problems.join(
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
    /*
     * REFUSE, NOT FAIL, WHEN THE INSTALL CAN BE SKIPPED OR CAN FAIL (#879). The coupling
     * may well still hold at runtime — `if:` can be true and the install can succeed — so
     * this is not a violation. It is the file no longer being able to answer the question,
     * which is the category the three refusals above already occupy.
     */
    const lines = source.split("\n");
    const steps = stepsIn(lines);
    const next = steps.find((x) => x.line > (i?.step?.line ?? 0));
    const guards = i?.step ? stepGuards(lines, i.step.line, next?.line) : [];
    if (guards.length) {
      console.error(
        `COULD NOT COMPUTE: "${i.step?.name}" installs ${REQUIREMENTS} before the checker,\n` +
          `      but carries ${guards
            .map((g) => `\`${g.key}: ${g.value}\`` + ` (line ${g.line})`)
            .join(" and ")}.\n` +
          `      Declaration order no longer implies execution: the install may be SKIPPED or\n` +
          `      may FAIL while the job carries on, and the checker would then ask an\n` +
          `      interpreter that has nothing. The coupling may still hold — this says the\n` +
          `      WORKFLOW can no longer be read to decide it.`
      );
      process.exit(2);
    }
    console.log(
      `PASS: "${c.step?.name}" is preceded in job "${c.job?.name}" by "${i.step?.name}",\n` +
        `      which installs ${REQUIREMENTS}. Same job, and before — TWO of the four\n` +
        `      conditions this coupling needs. NOT ASSERTED: that the install SUCCEEDED,\n` +
        `      since \`continue-on-error: true\` on it leaves this line green while the\n` +
        `      interpreter has nothing; and that it RAN, since an \`if:\` skip does the same.\n` +
        `      This says the two steps are COUPLED IN THE WORKFLOW. It does not say the\n` +
        `      package is present.`
    );
  }
}

if (invokedAsProgram(import.meta.url)) main();
