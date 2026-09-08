#!/usr/bin/env node
/**
 * THE COMMENT THAT SAYS A STEP CANNOT GATE, AND THE LINE THAT MAKES IT TRUE (#995).
 *
 * `.github/workflows/ci.yml`'s `Audit dependencies` step carries a paragraph explaining why a
 * failure there cannot fail the job. The whole explanation rests on one line, fifteen lines
 * below it in the same step:
 *
 *     # It also said the step would "resume gating on its own" once pnpm worked
 *     # again. It cannot: continue-on-error means a failure here never fails the
 *     # job, whatever pnpm does.
 *     ...
 *     continue-on-error: true
 *
 * WHY THIS ONE IS WORSE THAN AN ORDINARY UNASSERTED CLAIM. Delete that line and the paragraph
 * does not merely go stale — it goes false IN THE WORST DIRECTION. A reader who hits a failure
 * there would find a comment explaining why this step cannot be the cause, attached to a step
 * that now is. Prose that is wrong sends the next person away from the answer, which costs more
 * than prose that is missing. Every other claim in that comment is dated or externally
 * re-derivable — `pnpm audit`'s counts, the alerts endpoints, the SBOM and compare probes. This
 * one was neither.
 *
 * WHAT WAS TRUE BEFORE THIS EXISTED, measured rather than assumed: three scripts mention
 * `continue-on-error`, and none read this step. One is prose in a docblock, one a comment about
 * a hypothetical, and the third — `assert-vocabulary-checker-has-its-dependency.mjs` — is a real
 * parser of the attribute that guards a DIFFERENT coupling entirely, the FastAPI install against
 * the approval-vocabulary checker. So the machinery existed and its subject was elsewhere.
 *
 * AND WHY THIS DOES NOT IMPORT THAT MACHINERY, since a reader will ask. Its `stepGuards` is
 * exported and does exactly this parsing, but checker-to-checker imports have one precedent in
 * this repository and it imports a CONSTANT, not behaviour; `scripts/lib/` is where shared code
 * lives and holds no step-attribute reader. Moving `stepGuards` there would refactor a live
 * checker to serve this one. The discipline is copied instead of the code — read attributes at
 * the step's OWN indent, one level in from its `- name:`, so a shell `if` inside a `run:` block
 * is never mistaken for a step attribute — and that file remains the place the general version
 * would go if a third caller ever wants it.
 *
 * DELIBERATELY ONE COUPLING, following the same choice that file made and for the same reason.
 * A general rule — "any step whose comment claims non-gating must carry the key" — would have to
 * recognise the claim in prose, and a prose matcher is exactly the instrument this repository
 * keeps finding wrong. One named step, one asserted line.
 *
 * EXIT VOCABULARY. 0 the line is there; 1 the step exists and the line does not, so the comment
 * is now false; 2 the question could not be asked — no workflow, no such step, or the name is
 * ambiguous. A rename is a REFUSAL rather than a finding: the step may have been legitimately
 * renamed, and reporting "the comment is false" would be a claim about a step this file can no
 * longer identify.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOW = ".github/workflows/ci.yml";
export const STEP_NAME = "Audit dependencies";

/**
 * The lines of one named step: from its `- name:` up to the next sibling step or the end of the
 * block. Located by NAME rather than by line number, because a recorded line number is the thing
 * that has already been measured wrong twice in this repository's own exclusion reasons.
 */
export function stepBlock(lines, stepName) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- name:\s*(.+?)\s*$/.exec(lines[i]);
    if (m && m[2] === stepName) starts.push({ at: i, indent: m[1] });
  }
  if (starts.length !== 1) return { block: null, count: starts.length };
  const { at, indent } = starts[0];
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (new RegExp(`^${indent}- `).test(lines[i])) {
      end = i;
      break;
    }
    if (lines[i].trim() !== "" && !lines[i].startsWith(indent + "  ")) {
      end = i;
      break;
    }
  }
  return { block: lines.slice(at, end), count: 1, at, indent };
}

/**
 * Does the step's own attribute list carry `continue-on-error: true`?
 *
 * Read at the step's OWN indent — one level in from its `- name:` — so the same string appearing
 * inside a `run:` script, or inside the explanatory COMMENT above it, cannot satisfy this. That
 * distinction is the whole point: the comment mentions `continue-on-error` in prose, and a
 * grep for the string would be satisfied by the very paragraph whose truth is in question.
 */
export function carriesContinueOnError(block, indent) {
  const attr = new RegExp(`^${indent}  continue-on-error:\\s*(.*)$`);
  for (const line of block) {
    const m = attr.exec(line);
    if (m) return { present: true, value: m[1].trim() };
  }
  return { present: false, value: null };
}

function main() {
  const path = join(ROOT, WORKFLOW);
  if (!existsSync(path)) {
    process.stderr.write(
      `\nCOULD NOT CHECK: ${WORKFLOW} does not exist, so the step this asserts about ` +
        `cannot be read.\n\n`
    );
    process.exit(2);
  }
  const lines = readFileSync(path, "utf-8").split("\n");
  const { block, count, indent } = stepBlock(lines, STEP_NAME);

  reportSubject(
    count,
    `step(s) named ${JSON.stringify(STEP_NAME)} in ${WORKFLOW}`
  );

  if (block === null) {
    process.stderr.write(
      `\nCOULD NOT CHECK: ${WORKFLOW} contains ${count} step(s) named ` +
        `${JSON.stringify(STEP_NAME)}, not exactly one.\n` +
        `      A rename is not a finding — the step may have been renamed for good reason, and\n` +
        `      "its comment is false" would be a claim about a step this cannot identify. If it\n` +
        `      was renamed, update STEP_NAME here in the same change.\n\n`
    );
    process.exit(2);
  }

  const { present, value } = carriesContinueOnError(block, indent);
  if (present && value === "true") {
    process.stdout.write(
      `PASS: ${JSON.stringify(
        STEP_NAME
      )} still carries \`continue-on-error: true\`, so its\n` +
        `      comment explaining why a failure there cannot gate the job remains true.\n`
    );
    return;
  }

  process.stderr.write(
    `\nFAIL: ${JSON.stringify(STEP_NAME)} in ${WORKFLOW} ` +
      (present
        ? `carries \`continue-on-error: ${value}\`, not \`true\`.\n`
        : `carries no \`continue-on-error\` line.\n`) +
      `\n      That step's comment explains WHY a failure there cannot fail the job, and the\n` +
      `      explanation rests entirely on that line. Without it the paragraph is not stale,\n` +
      `      it is FALSE in the worst direction: it tells whoever hits the failure that this\n` +
      `      step cannot be the cause, while it now is.\n` +
      `\n      REPAIR: restore \`continue-on-error: true\`, or — if the step is meant to gate\n` +
      `      now — rewrite the comment in the same change and update this checker with it.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
