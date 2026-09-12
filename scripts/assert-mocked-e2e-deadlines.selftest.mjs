#!/usr/bin/env node

import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/e2e.yml", "utf8");

function jobBlock(source, jobName) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}\S/.test(line)
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

function stepBlock(job, stepName) {
  const lines = job.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`
  );
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^ {6}- name: /.test(line)
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

function audit(source) {
  const problems = [];
  const job = jobBlock(source, "e2e-mocked");
  if (!job) return ["the e2e-mocked job is absent"];

  if (!/^ {4}timeout-minutes: 25$/m.test(job)) {
    problems.push("the mocked job lacks its 25-minute final deadline");
  }

  const testStep = stepBlock(
    job,
    "Run mocked E2E tests (SPEC-01 through SPEC-11, CI-01)"
  );
  if (!testStep) {
    problems.push("the mocked Playwright step is absent");
  } else {
    if (!/^ {8}timeout-minutes: 17$/m.test(testStep)) {
      problems.push("the mocked Playwright step lacks its 17-minute backstop");
    }
    if (
      !testStep.includes(
        "run: timeout --signal=INT --kill-after=30s 15m pnpm test:e2e"
      )
    ) {
      problems.push(
        "the mocked Playwright command lacks its graceful 15-minute deadline"
      );
    }
  }

  const upload = stepBlock(job, "Upload Playwright report");
  if (!upload) {
    problems.push("the mocked Playwright artifact upload is absent");
  } else {
    if (!/^ {8}if: always\(\)$/m.test(upload)) {
      problems.push("the mocked Playwright artifact is not uploaded always");
    }
    if (!/^ {12}playwright-report\/$/m.test(upload)) {
      problems.push("the mocked artifact omits the HTML report");
    }
    if (!/^ {12}test-results\/$/m.test(upload)) {
      problems.push("the mocked artifact omits partial test results");
    }
  }

  return problems;
}

let passed = 0;
let failed = 0;
const EXPECTED = 7;

process.on("exit", () => {
  const total = passed + failed;
  if (failed !== 0 || total !== EXPECTED) process.exitCode = 1;
  console.log(
    failed === 0 && total === EXPECTED
      ? `\nPASS: ${passed}/${total}. The healthy workflow passes and every removed deadline or diagnostic is caught.`
      : `\nFAIL: ${failed}/${total} deadline proof(s) failed; expected ${EXPECTED} cases.`
  );
});

function expect(label, source, pattern = null) {
  const problems = audit(source);
  const accepted = pattern
    ? problems.some((problem) => pattern.test(problem))
    : problems.length === 0;
  if (accepted) passed++;
  else failed++;
  console.log(
    `  ${accepted ? "ok  " : "FAIL"} ${label}${
      accepted ? "" : ` (${problems.join(" | ") || "unexpectedly accepted"})`
    }`
  );
}

expect("the real workflow satisfies every deadline layer", workflow);
expect(
  "removing the job deadline is caught",
  workflow.replace("    timeout-minutes: 25\n", ""),
  /final deadline/
);
expect(
  "removing the step backstop is caught",
  workflow.replace("        timeout-minutes: 17\n", ""),
  /step lacks its 17-minute backstop/
);
expect(
  "removing the graceful command deadline is caught",
  workflow.replace(
    "timeout --signal=INT --kill-after=30s 15m pnpm test:e2e",
    "pnpm test:e2e"
  ),
  /graceful 15-minute deadline/
);
expect(
  "failure-only artifacts are caught",
  workflow.replace(
    "      - name: Upload Playwright report\n        if: always()",
    "      - name: Upload Playwright report\n        if: failure()"
  ),
  /not uploaded always/
);
expect(
  "dropping the HTML report is caught",
  workflow.replace("            playwright-report/\n", ""),
  /omits the HTML report/
);
expect(
  "dropping partial results is caught",
  workflow.replace("            test-results/\n", ""),
  /omits partial test results/
);
