#!/usr/bin/env node
/**
 * assert-dev-summary-rows-are-gated.mjs — the dev summary box does not advertise a
 * service this run did not start (#878).
 *
 * WHAT WENT WRONG. `dev-all.sh` prints a box of URLs at the end. Two of its rows —
 * the open-swe app and the queue agent — were printed UNCONDITIONALLY, including in
 * the branch that says "no apps/open-swe in this tree — skipping the queue agent and
 * the app". In that branch the services are not merely un-started: the directory is
 * absent, so nothing can be listening. A user spent an evening on an unresponsive
 * port that the tool had just told them about.
 *
 * NOTHING HAD EVER CHECKED THE BOX'S CONTENTS. `dev-hold.selftest.sh` names the app
 * and the queue agent in its header, but its subject is the hold/exit decision, not
 * what gets printed. That is why a row advertising a nonexistent service survived.
 *
 * ONE NAMED COUPLING, NOT A RULE ABOUT ROWS. The general form — "every row is gated
 * on whatever decides its service" — needs a mapping from rows to services that
 * nobody has written down, and would have to model `model backend`, which is
 * deliberately UNGATED: `--no-backend` means "use an already-running :8001 (or
 * none)", so that URL may be live and correct. Same shape, different claim. This
 * asserts the two rows whose service cannot be running when the guard is false.
 *
 * Usage: node scripts/assert-dev-summary-rows-are-gated.mjs
 * Exit: 0 both rows gated · 1 one is not · 2 the box or a row could not be found
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/dev-all.sh";
const GUARD = '[ "$HAS_OPENSWE" = "1" ]';

/** The rows this asserts, and the variable each one advertises. */
export const GATED_ROWS = [
  { label: "open-swe (main app)", ref: "$APP_URL" },
  { label: "queue agent", ref: "$AGENT_PORT" },
  /*
   * THE PORT SUB-ROW IS IN SCOPE BECAUSE IT WAS GATED DELIBERATELY, not because it
   * advertises a dead service — it prints a note about where $PORT came from, which
   * nobody curls. It is here so the domain matches what the fix actually did: a
   * checker whose domain excludes a row someone deliberately guarded will drift, the
   * next person removes the guard, nothing complains, and the reason is gone.
   */
  { label: "  ^ port", ref: "$PORT_SOURCE" },
];

/**
 * The summary box: the lines between the first two full-width rules. Located by the
 * rule characters rather than by line number, because every line citation about this
 * repo has been wrong at least once.
 */
export function boxOf(source) {
  const lines = source.split("\n");
  const rule = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => /^echo "\s*─{20,}"$/.test(x.l.trim()));
  if (rule.length < 2) return null;
  return lines
    .slice(rule[0].i + 1, rule[1].i)
    .map((l, n) => ({ line: rule[0].i + 2 + n, text: l }));
}

export function complaints(box) {
  const bad = [];
  for (const { label, ref } of GATED_ROWS) {
    const row = box.find((r) => r.text.includes(`"${label}"`));
    if (!row) {
      bad.push({
        refuse: true,
        why:
          `no row labelled "${label}" in the summary box of ${SCRIPT}. It may have been ` +
          `renamed or removed, which is legitimate — but this run is NOT evidence that ` +
          `it is gated wherever it went.`,
      });
      continue;
    }
    if (!row.text.includes(GUARD))
      bad.push({
        refuse: false,
        why:
          `line ${row.line} prints "${label}" (${ref}) without ${GUARD}.\n` +
          `    When that guard is false the script has already said it is skipping the app ` +
          `and the queue agent,\n    and apps/open-swe is not in the tree — so this row ` +
          `advertises a URL nothing can be listening on.`,
      });
  }
  return bad;
}

/*
 * EXECUTED ONLY AS A PROGRAM (#885 review). Without this the module ran its check on
 * IMPORT, and the proof imports `boxOf` and `GATED_ROWS` from it — so importing ran the
 * checker against the real repo and could `process.exit` before a single case executed.
 * On a passing tree it falls through and the suite reports 12/12, so it is invisible
 * until the day dev-all.sh actually violates the rule: then the reader sees the
 * checker's complaint and NO case results, and cannot tell a caught regression from a
 * suite that never ran. 53 checkers on main already use this helper; this had none.
 */
function main() {
  const source = readFileSync(join(ROOT, SCRIPT), "utf8");
  const box = boxOf(source);
  if (!box) {
    console.error(
      `COULD NOT COMPUTE: found no summary box in ${SCRIPT} — fewer than two full-width\n` +
        `      rules. This asks what the box prints; with no box there is nothing to ask it of.`
    );
    process.exit(2);
  }

  const problems = complaints(box);
  const refusals = problems.filter((p) => p.refuse);
  if (refusals.length) {
    console.error(
      `COULD NOT COMPUTE: ${refusals.length} row(s) could not be located:`
    );
    refusals.forEach((p) => console.error(`   - ${p.why}`));
    process.exit(2);
  }
  if (problems.length) {
    console.error(`FAIL: ${problems.length} summary row(s) are not gated:`);
    problems.forEach((p) => console.error(`   - ${p.why}`));
    process.exit(1);
  }

  reportSubject(
    GATED_ROWS.length,
    "summary row(s) whose service cannot be running when HAS_OPENSWE is 0"
  );
  console.log(
    `PASS: every row naming an open-swe service is gated on HAS_OPENSWE, so the box does\n` +
      `      not advertise something this run did not start.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
