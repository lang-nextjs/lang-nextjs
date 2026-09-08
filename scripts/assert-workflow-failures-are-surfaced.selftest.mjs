#!/usr/bin/env node
/**
 * PROOF for assert-workflow-failures-are-surfaced.mjs (#1097, #1021, #742).
 *
 * The arms that matter are where a broken checker looks fine: a condition it cannot read must
 * REFUSE rather than pass, two substrings in different steps must not count as a failure channel,
 * and the roster must be derived rather than named — the entries exist to be retired, so an arm
 * that hardcodes one depends on the feature never being used.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  KNOWN_UNSURFACED,
  UNATTENDED,
  VERDICT,
  Refusal,
  triggersOf,
  jobsOf,
  runsOnPullRequest,
  declaresFailureConsumer,
  unreachableJobs,
  staleExemptions,
  classify,
} from "./assert-workflow-failures-are-surfaced.mjs";

let pass = 0,
  fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`);
  }
};
const HERE = dirname(fileURLToPath(import.meta.url));

/* ---- the roster, DERIVED so retiring an entry does not break the proof ------------------- */
const KEYS = Object.keys(KNOWN_UNSURFACED);
const A_KEY = KEYS[0];
const A_FILE = A_KEY?.split("#")[0];
const A_JOB_KEY = KEYS.find((k) => k.includes("#"));

t(
  "THE ROSTER IS NON-EMPTY, so the arms below have a subject — with none they assert nothing, " +
    "and a check that cannot compute must say so rather than pass",
  KEYS.length > 0 && typeof A_KEY === "string"
);
t(
  "every entry names an issue and a repair, never a bare name",
  Object.values(KNOWN_UNSURFACED).every((e) => e.issue && e.reason && e.repair)
);
t(
  "the roster is frozen, so widening it is an edit a reviewer sees",
  Object.isFrozen(KNOWN_UNSURFACED) &&
    Object.values(KNOWN_UNSURFACED).every(Object.isFrozen)
);

/* ---- triggersOf ------------------------------------------------------------------------- */
t(
  "block form, with comments inside the block",
  [
    ...triggersOf(
      "on:\n  # a comment\n  schedule:\n    - cron: x\n  workflow_dispatch:\njobs:\n"
    ),
  ]
    .sort()
    .join(",") === "schedule,workflow_dispatch"
);
t(
  "inline list form",
  [...triggersOf("on: [push, pull_request]\n")].sort().join(",") ===
    "pull_request,push"
);
t("single value form", [...triggersOf("on: push\n")].join(",") === "push");
t(
  'the quoted "on" key, which YAML 1.1 makes people write',
  [...triggersOf('"on":\n  push:\n')].join(",") === "push"
);
t(
  "the block ends at column 0, so `jobs:` is not read as a trigger",
  !triggersOf("on:\n  push:\njobs:\n  build:\n").has("jobs")
);
t(
  "a file with no `on:` REFUSES rather than reporting no triggers",
  (() => {
    try {
      triggersOf("jobs:\n  x:\n");
      return false;
    } catch (e) {
      return e instanceof Refusal;
    }
  })()
);

/* ---- attended vs unattended ------------------------------------------------------------- */
t(
  "workflow_dispatch is NOT unattended — a person pressed the button and is looking",
  !UNATTENDED.includes("workflow_dispatch")
);
t(
  "a dispatch-only workflow is ATTENDED, not exempt and not a finding",
  classify("x.yml", "on:\n  workflow_dispatch:\njobs:\n  a:\n").verdict ===
    VERDICT.ATTENDED
);
t(
  "a scheduled workflow with no pull_request and no consumer is a FINDING",
  classify("x.yml", "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n")
    .verdict === VERDICT.UNSURFACED
);

/* ---- the failure consumer, read as a STEP rather than as two substrings ------------------ */
const SAME_STEP =
  "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n    steps:\n      - name: tell someone\n        if: failure()\n        run: gh issue create --title x\n";
const SPLIT_STEPS =
  "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n    steps:\n      - name: one\n        if: failure()\n        run: echo hi\n      - name: two\n        run: gh issue create --title x\n";
t(
  "a step conditioned on failure() that files an issue IS a consumer",
  declaresFailureConsumer(SAME_STEP)
);
t(
  "TWO SUBSTRINGS IN DIFFERENT STEPS ARE NOT — the second must run BECAUSE of the first",
  !declaresFailureConsumer(SPLIT_STEPS)
);
t(
  "and a workflow declaring a consumer passes without a pull_request trigger",
  classify("x.yml", SAME_STEP).verdict === VERDICT.CONSUMED
);

/* ---- job conditions --------------------------------------------------------------------- */
t(
  "a job with no condition inherits the workflow's triggers",
  runsOnPullRequest(null) === true
);
t(
  "`event_name == 'pull_request'` reaches pull requests",
  runsOnPullRequest("github.event_name == 'pull_request'") === true
);
t(
  "a conjunction requiring push does NOT — this is #742's shape",
  runsOnPullRequest(
    "needs.x.outputs.y == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main'"
  ) === false
);
t(
  "a push||pull_request disjunction DOES reach pull requests",
  runsOnPullRequest(
    "github.event_name == 'push' || (github.event_name == 'pull_request' && x)"
  ) === true
);
t(
  "AN UNRECOGNISED CONDITION IS null — not true, because guessing costs most exactly here",
  runsOnPullRequest("github.actor != 'dependabot[bot]'") === null
);

/*
 * BOTH TRIGGERS, because that is e2e.yml's real shape and the only shape where this matters. A
 * pull_request-ONLY workflow with a push-conditioned job is ATTENDED and the job never runs at
 * all — a different defect, and the first draft of this fixture had it, which is why two arms
 * failed against a correct checker.
 */
const BLOCK_SCALAR =
  "on:\n  push:\n  pull_request:\njobs:\n  a:\n    if: >-\n      github.event_name == 'push'\n      && github.ref == 'refs/heads/main'\n    steps: []\n";
t(
  "jobsOf reads a `>-` block scalar condition, not just an inline one",
  jobsOf(BLOCK_SCALAR)[0].condition.includes("event_name == 'push'")
);
t(
  "A JOB NO PULL REQUEST REACHES FAILS ITS WORKFLOW, even though the workflow declares pull_request",
  classify("x.yml", BLOCK_SCALAR).verdict === VERDICT.UNSURFACED
);
t(
  "and the failure names the job and the repair",
  (() => {
    const d = classify("x.yml", BLOCK_SCALAR).detail;
    return d.includes("a") && d.includes("REPAIR");
  })()
);
t(
  "an unclassifiable job condition REFUSES rather than passing",
  (() => {
    try {
      unreachableJobs(
        "x.yml",
        "on:\n  pull_request:\njobs:\n  a:\n    if: github.actor != 'x'\n    steps: []\n"
      );
      return false;
    } catch (e) {
      return e instanceof Refusal && /cannot classify/.test(e.message);
    }
  })()
);

/* ---- staleness, derived from the roster ------------------------------------------------- */
t(
  "an exemption naming a file that is gone IS stale",
  staleExemptions(new Set(), KNOWN_UNSURFACED, new Map()).length === KEYS.length
);
t(
  "an exemption naming a JOB that is gone is stale too — a rename orphans it silently",
  A_JOB_KEY === undefined ||
    staleExemptions(
      new Set([A_JOB_KEY.split("#")[0]]),
      { [A_JOB_KEY]: KNOWN_UNSURFACED[A_JOB_KEY] },
      new Map([[A_JOB_KEY.split("#")[0], new Set(["something-else"])]])
    ).length === 1
);
t(
  "and nothing is stale when the file and job are both present",
  A_JOB_KEY === undefined ||
    staleExemptions(
      new Set([A_JOB_KEY.split("#")[0]]),
      { [A_JOB_KEY]: KNOWN_UNSURFACED[A_JOB_KEY] },
      new Map([[A_JOB_KEY.split("#")[0], new Set([A_JOB_KEY.split("#")[1]])]])
    ).length === 0
);
t(
  "AN EMPTY ROSTER IS NOT AN ERROR — nothing is stale over nothing",
  staleExemptions(new Set(["a.yml"]), {}, new Map()).length === 0
);
t(
  "and an exempt workflow is only exempt while its entry exists",
  A_FILE === undefined ||
    classify(A_FILE, "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n", {})
      .verdict === VERDICT.UNSURFACED
);

/* ---- end to end -------------------------------------------------------------------------- */
{
  const r = spawnSync(
    process.execPath,
    [join(HERE, "assert-workflow-failures-are-surfaced.mjs")],
    { encoding: "utf8" }
  );
  t(
    "CONTROL: the checker RUNS against this repository and exits 0",
    r.status === 0,
    `${r.stdout}${r.stderr}`
  );
  t(
    "and it EMITS ITS SUBJECT, so a pass over nothing is refusable",
    /SUBJECT: \d+ workflow\(s\)/.test(r.stdout)
  );
  t(
    "and it announces every exemption, job-level ones included — a roster nobody sees is the defect it exists to prevent",
    KEYS.every((k) => r.stdout.includes(k)),
    r.stdout
  );
  t(
    "and it states that surfaced is NOT enforced, rather than implying a guarantee branch protection does not give",
    /SURFACED IS NOT ENFORCED/.test(r.stdout)
  );
}

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The checker refuses on a job condition it cannot classify rather than\n` +
    `      assuming a pull request reaches it, reads a failure channel as a STEP rather than as two\n` +
    `      substrings, treats dispatch-only as attended rather than rostering a workflow that needs\n` +
    `      no repair, and catches a job no pull request reaches inside a workflow that declares one\n` +
    `      — which is #742's shape and the case a workflow-level check passes.`
);
