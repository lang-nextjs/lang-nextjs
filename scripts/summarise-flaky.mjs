#!/usr/bin/env node
/**
 * summarise-flaky.mjs — a GREEN run shows the readings its retries discarded (#777).
 *
 * THE DEFECT THIS EXISTS FOR, measured rather than supposed. `E2E — Mocked` retries a
 * failed webkit `hitl.spec.ts` test, the retry passes, the job goes green — and the
 * give-up block that #754 and #772 built, with the full wire reading and the timing
 * verdict, is written into a PASSING job's log where nobody looks. #777 measured the
 * consequence: 43 of 150 passing runs carry a flaky hitl reading, against 8 of 426 that
 * failed on one, so ROUGHLY 84% OF OCCURRENCES ARE DISCARDED. Not unrecorded — discarded.
 * Run 33975847007 is green and its log holds the first firing of #772's discriminator,
 * which sat unread while #770 was written around waiting for the next occurrence.
 *
 * The rate was understated in every discussion of #675, including #615's
 * `P(zero | p=3.5%, n=46)` arithmetic, because every one of them counted job conclusions
 * — an instrument measured DOWNSTREAM of the retry, which structurally cannot report a
 * flake that recovered. ~15x was #777's ESTIMATE, reasoned from the shape of the
 * instrument; 18x is the MEASURED job-level figure. They are kept apart deliberately: an
 * estimate that was later confirmed by measurement is the strongest thing either has, and
 * collapsing them into one number destroys exactly what makes the pair convincing.
 *
 * IT CHANGES NOTHING ABOUT WHAT RUNS. Same tests, same projects, same retries. It reads
 * the report Playwright already produces and writes what it finds to the run summary,
 * where a green run is visible without opening a log. #777's own sketch list is
 * deliberately confined to surfacing readings that already exist, and this is the first
 * of the three.
 *
 * A FLAKE IS NOT A FAILURE AND THIS NEVER EXITS 1. Reporting is the whole job: making a
 * recovered flake fail the run is a different decision, with a different owner, and one
 * this must not take by side effect. Exit 2 is reserved for its own inability to look —
 * a missing or unreadable report is "could not ask", never "nothing was there", because
 * those two produce an identical empty summary and only one of them is good news.
 *
 * WHAT IT CANNOT SEE, AND IT IS THE SAME SHAPE AS THE DEFECT IT FIXES. Playwright's
 * `flaky` status is ATTEMPT-LEVEL: attempt 1 failed, attempt 2 passed. A failure that
 * recovers WITHIN attempt 1 — which is what an auto-retrying `expect` does by design —
 * never becomes a flaky test, reaches neither the flaky list nor the error headers, and
 * this script will never report it.
 *
 * So "Flaky tests: none" is a claim about ENTIRE ATTEMPTS, not a claim that nothing went
 * wrong, and it should be read that way. This is a smaller version of the thing #777 is
 * about — an instrument built because a green run hides an occurrence, with its own
 * narrower band of occurrences it cannot see — and it is written here rather than left to
 * be discovered, because a reader who is not told assumes coverage that does not exist.
 *
 * The bound is DEV1's, measured on #918: the retry does not halve a census, it PARTITIONS
 * it — 11 of 18 specs produced incidents and never once produced a red, and 23 of 24 flake
 * incidents left no red at all. So no multiplier reconstructs a past rate, and what this
 * surfaces is not more of what was already counted but the first instances of a category
 * that was never visible.
 *
 * Usage: node scripts/summarise-flaky.mjs [--report PATH] [--out PATH]
 * Exit:  0 it looked — whether or not it found flakes · 2 it could not look
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPORT = join(ROOT, "test-results", "results.json");

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

class Refusal extends Error {}

/**
 * Every test Playwright marked `flaky`, with the output of the attempts that FAILED.
 *
 * The failed attempt is the one carrying the evidence — the give-up block, the wire
 * reading, the timing verdict. The passing retry says nothing, which is precisely how
 * the reading came to be discarded.
 */
export function flakyTests(report) {
  const found = [];
  const walk = (suite, filePath) => {
    const file = suite.file ?? filePath;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status !== "flaky") continue;
        const failed = (t.results ?? []).filter((r) => r.status !== "passed");
        found.push({
          title: spec.title,
          file: spec.file ?? file,
          line: spec.line,
          project: t.projectName || "(default)",
          attempts: (t.results ?? []).length,
          output: failed
            .map((r) =>
              [
                ...(r.stdout ?? []).map((c) => c.text ?? ""),
                ...(r.stderr ?? []).map((c) => c.text ?? ""),
                r.error?.message ?? "",
              ].join("")
            )
            .join("\n")
            .trim(),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  return found;
}

/**
 * THE SCOPE TRAVELS WITH THE SUMMARY, NOT ONLY WITH THE SOURCE.
 *
 * This file's header states what the script cannot see. The header is in the SOURCE, and
 * the audience for this output is by construction someone who is NOT opening a log — so a
 * caveat that lives only in the header is a caveat where its reader never looks. That is
 * #777's own defect, one layer out from #777.
 *
 * Emitted in BOTH branches. "none" without it reads as "nothing went wrong", and a
 * populated table without it reads as "these are all of them"; neither is what the number
 * means.
 */
const SCOPE =
  "This counts whole attempts: a failure that recovered INSIDE a single attempt — " +
  "which is what an auto-retrying `expect` does by design — is not a flaky test and " +
  "does not appear here.";

/** Markdown for the run summary. Empty findings still produce a line — see the header. */
export function render(found) {
  if (found.length === 0)
    return (
      "### Flaky tests: none\n\n" +
      "Playwright reported no test that failed and then passed on retry. " +
      "This line exists so that a run with no flakes is distinguishable from a run " +
      "where the report could not be read (#777).\n\n" +
      SCOPE +
      "\n"
    );
  const lines = [
    `### Flaky tests: ${found.length}`,
    "",
    "These PASSED on retry, so the job is green and nothing else records them. " +
      "The reading below is from the attempt that FAILED (#777).",
    "",
    SCOPE,
    "",
    "| project | test | file |",
    "| --- | --- | --- |",
  ];
  for (const f of found)
    lines.push(
      `| \`${f.project}\` | ${f.title.replace(/\|/g, "\\|")} | \`${f.file}${
        f.line ? `:${f.line}` : ""
      }\` |`
    );
  for (const f of found) {
    if (!f.output) continue;
    lines.push(
      "",
      `<details><summary><code>${f.project}</code> — ${f.title.replace(
        /</g,
        "&lt;"
      )}</summary>`,
      "",
      "```",
      f.output.slice(0, 8000),
      "```",
      "",
      "</details>"
    );
  }
  return lines.join("\n") + "\n";
}

function main() {
  const path = argValue("--report") ?? DEFAULT_REPORT;
  let report;
  try {
    if (!existsSync(path))
      throw new Refusal(
        `no Playwright JSON report at ${path}. The run may have died before the ` +
          `reporter wrote one, or the json reporter is not configured for this job.`
      );
    const text = readFileSync(path, "utf8");
    try {
      report = JSON.parse(text);
    } catch (err) {
      throw new Refusal(
        `the report at ${path} is not parseable JSON (${err.message}), so no flake ` +
          `could be read from it. It exists and it RAN — this is not a missing file.`
      );
    }
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.error(`REFUSE: ${err.message}`);
    console.error(
      `        Nothing was read, which is not the same as nothing being there — and an ` +
        `empty\n        summary would say the second.`
    );
    process.exit(2);
  }

  const found = flakyTests(report);
  const md = render(found);
  const out = argValue("--out") ?? process.env.GITHUB_STEP_SUMMARY;
  if (out) appendFileSync(out, md);
  else process.stdout.write(md);

  reportSubject(
    found.length,
    "flaky test(s) surfaced from Playwright's own report"
  );
}

if (invokedAsProgram(import.meta.url)) main();
