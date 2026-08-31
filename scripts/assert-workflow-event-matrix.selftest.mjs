#!/usr/bin/env node
/**
 * Prove the workflow-matrix check can fail, in each direction it claims (#E2E-05, #CI-01).
 *
 * PLANT, DON'T BORROW. Every fixture is a synthetic .github/workflows tree in a
 * temp dir. The real workflow satisfies both requirements today, so borrowing it
 * would give a selftest that is green because the repo is healthy.
 *
 * CASE 6 IS THE PRESENCE COMPANION AND IT IS THE POINT. "these jobs do not run
 * on a fork PR" is TRUE of a workflow where they run for nobody — an absence
 * claim is satisfied by a workflow that does nothing. So a fixture where the two
 * jobs are guarded off for every event must FAIL. Without this case, a checker
 * that only ever asserted the absence half would score full marks.
 *
 * CASE 7 IS THE EXACT-TOKEN TRAP, and it is not hypothetical: ci.yml really runs
 * `pnpm test:e2e-registration`, and `/test:e2e\b/` MATCHES IT because `\b` holds
 * before the hyphen. A CI-01 check written with a substring is satisfied by a job
 * that has nothing to do with E2E. The fixture offers only the registration
 * script and requires a FAIL.
 *
 * CASE 8 is the other half of the same trap, from ARCHITECT's side: the script
 * must be resolved through package.json rather than looked for by file name.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check } from "./assert-workflow-event-matrix.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "assert-workflow-event-matrix.mjs");
let pass = 0,
  fail = 0;

const SAME_REPO_GUARD =
  "github.event_name == 'push' ||\n      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)";

function wf({
  djangoIf = SAME_REPO_GUARD,
  fastapiIf = SAME_REPO_GUARD,
  forkJobId = "e2e-fork-coverage",
  e2eScript = "test:e2e",
  mockedIf = null,
}) {
  return `name: E2E
on:
  pull_request:
  push:
    branches: [main]
jobs:
  e2e-mocked:
    name: E2E — Mocked
    runs-on: ubuntu-latest
${mockedIf ? `    if: |\n      ${mockedIf}\n` : ""}    steps:
      - run: pnpm ${e2eScript}
  e2e-django:
    name: E2E — Django backend
    runs-on: ubuntu-latest
    if: |
      ${djangoIf}
    steps:
      - run: echo django
  e2e-fastapi:
    name: E2E — FastAPI backend
    runs-on: ubuntu-latest
    if: |
      ${fastapiIf}
    steps:
      - run: echo fastapi
  ${forkJobId}:
    name: E2E — backend coverage on this PR
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - run: echo coverage
`;
}

function tree(workflow, scripts = { "test:e2e": "playwright test" }) {
  const root = mkdtempSync(path.join(tmpdir(), "wfmatrix-"));
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".github", "workflows", "e2e.yml"), workflow);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts }, null, 2)
  );
  return root;
}

function run(root) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CHECKER, "--root", root], {
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function expectRun(name, root, wantCode, mustMention) {
  try {
    const { problems } = check({ root });
    const code = problems.some((p) => p.kind === "unreadable")
      ? 2
      : problems.length
      ? 1
      : 0;
    const text = problems.map((p) => p.detail).join("\n");
    const ok =
      code === wantCode && (!mustMention || text.includes(mustMention));
    ok ? pass++ : fail++;
    console.log(
      ok
        ? `  ok   ${name} -> exit ${code}`
        : `  FAIL ${name}\n       want ${wantCode}${
            mustMention ? ` mentioning "${mustMention}"` : ""
          }\n       got  ${code}: ${text.slice(0, 200)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("assert-workflow-event-matrix selftest");

expectRun("0 CONTROL: a workflow satisfying E2E-05 and CI-01", tree(wf({})), 0);

expectRun(
  "1 fork guard REMOVED -> names the job that now runs on a fork PR",
  tree(
    wf({
      djangoIf:
        "github.event_name == 'push' ||\n      github.event_name == 'pull_request'",
    })
  ),
  1,
  "RUNS on fork PR"
);

expectRun(
  "2 job MOVED to push-only -> names the event it stopped running on",
  tree(wf({ fastapiIf: "github.event_name == 'push'" })),
  1,
  "does NOT run on same-repo PR"
);

expectRun(
  "3 job RENAMED -> says the requirement now names a job that does not exist",
  tree(wf({ forkJobId: "e2e-fork-report" })),
  1,
  "declares no job"
);

{
  // 4. no jobs: block
  const root = tree(wf({}).replace("jobs:", "jobz:"));
  const { code, out } = run(root);
  const ok = code === 2 && out.includes("REFUSING");
  ok ? pass++ : fail++;
  console.log(
    ok
      ? "  ok   4 unreadable workflow -> REFUSES (exit 2)"
      : `  FAIL 4 got ${code}: ${out.slice(0, 160)}`
  );
  rmSync(root, { recursive: true, force: true });
}

expectRun(
  "5 an if: this cannot evaluate -> REFUSES rather than guessing either way",
  tree(
    wf({
      djangoIf: "github.actor == 'dependabot[bot]' && vars.SOMETHING == 'x'",
    })
  ),
  2,
  "REFUSING rather than guessing"
);

// 6. THE PRESENCE COMPANION.
expectRun(
  "6 jobs that run for NOBODY still FAIL — absence alone is satisfied by nothing",
  tree(
    wf({
      djangoIf: "github.event_name == 'never'",
      fastapiIf: "github.event_name == 'never'",
    })
  ),
  1,
  "does NOT run on push to main"
);

// 7-8. CI-01, the exact-token trap in both directions.
expectRun(
  "7 only test:e2e-registration exists -> FAILS; a prefix match would pass",
  tree(wf({ e2eScript: "test:e2e-registration" }), {
    "test:e2e": "playwright test",
    "test:e2e-registration": "node x.mjs",
  }),
  1,
  "no workflow job runs it"
);

expectRun(
  "8 package.json declares no test:e2e -> says the SUBJECT does not exist",
  tree(wf({}), { "test:unit": "vitest" }),
  1,
  "declares no `test:e2e` script"
);

expectRun(
  "9 test:e2e runs only on push -> names that it is not on a pull request",
  tree(wf({ mockedIf: "github.event_name == 'push'" })),
  1,
  "does not run on a pull request"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
