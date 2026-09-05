#!/usr/bin/env node
/**
 * Proof that assert-required-contexts-match-jobs can FAIL, can PASS, and can REFUSE — and that
 * each of the three happens for the right reason. Do not remove.
 *
 * A checker over two lists is trivially satisfiable by firing on any difference. That version
 * is red the moment the enumerated exceptions are wrong, stays red, and gets ignored — the
 * failure mode the ACCEPT cases below exist to rule out. So the accept side is not decoration
 * here; it is half the proof.
 *
 * Each case builds a workflow tree and puts a stub `gh` on PATH that returns one protection
 * payload, so the cases are exact rather than dependent on whatever the repository looks like
 * today. The one exception is the last case, which runs against the REAL tree on purpose —
 * it is the only way to establish that the run-time matrix resolver actually resolves
 * something, and an empty resolution is precisely the shape that would under-report the job
 * side in silence.
 *
 * THE EXCLUSION LIST IS EXERCISED, NOT STUBBED. The fixtures declare the same three job ids
 * the shipped NOT_REQUIRED names, so these cases fail if that list stops matching the jobs it
 * describes.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(
  ROOT,
  "scripts",
  "assert-required-contexts-match-jobs.mjs"
);
const dirs = [];

/* ---------------- fixtures ---------------- */

const PUSH_ONLY_IF = `    if: >-
      github.event_name == 'push'
      && github.ref == 'refs/heads/main'`;

/** The three jobs the shipped NOT_REQUIRED enumerates, in their justified (push-only) form. */
const EXCLUDED_JOBS = `  e2e-live-transport:
    name: E2E — open-swe live transport (push to main only)
${PUSH_ONLY_IF}
    runs-on: ubuntu-latest
    steps:
      - run: "true"

  llm-key-configured:
    name: Config — a model API key is configured
    if: >-
      github.event_name == 'push'
      && github.ref == 'refs/heads/main'
      && (github.event_name != 'pull_request'
      || github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    steps:
      - run: "true"

  e2e-llm:
    name: E2E — Real LLM (push to main only)
${PUSH_ONLY_IF}
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`;

function job({ id, name, cond, matrix }) {
  const parts = [`  ${id}:`, `    name: ${name}`];
  if (cond) parts.push(`    if: >-\n      ${cond}`);
  parts.push("    runs-on: ubuntu-latest");
  if (matrix) {
    parts.push("    strategy:", "      matrix:");
    for (const [k, v] of Object.entries(matrix))
      parts.push(`        ${k}: ${v}`);
  }
  parts.push("    steps:", '      - run: "true"');
  return parts.join("\n") + "\n";
}

/**
 * @param jobs      YAML for the jobs of e2e.yml, appended after the three excluded ones
 * @param extra     { filename: yaml } for further workflows
 * @param excluded  include the three enumerated exclusions in e2e.yml (default true)
 */
function tree({ jobs = "", extra = {}, excluded = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "reqctx-"));
  dirs.push(d);
  const wf = join(d, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(
    join(wf, "e2e.yml"),
    `name: E2E\non:\n  pull_request:\n  push:\n\njobs:\n${
      excluded ? EXCLUDED_JOBS : ""
    }${jobs}`
  );
  for (const [f, text] of Object.entries(extra))
    writeFileSync(join(wf, f), text);
  return d;
}

/** Runs the checker with a stub `gh` that answers the protection query however we choose. */
function run(cwd, { contexts, ghFails = false, body = null } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "reqctx-bin-"));
  dirs.push(bin);
  const payload =
    body ??
    JSON.stringify({ required_status_checks: { contexts: contexts ?? [] } });
  writeFileSync(
    join(bin, "gh"),
    ghFails
      ? "#!/bin/sh\necho 'gh: HTTP 403: Resource not accessible by integration' >&2\nexit 1\n"
      : `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`
  );
  chmodSync(join(bin, "gh"), 0o755);
  const args = [
    CHECKER,
    "--cwd",
    cwd,
    "--repo",
    "acme/widget",
    "--branch",
    "main",
  ];
  try {
    return {
      code: 0,
      out: execFileSync("node", args, {
        encoding: "utf8",
        // stderr is INHERITED by default, so a captured case still printed the checker's own
        // failure text into this report — noise that reads like the selftest failing.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
    };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/* ---------------- harness ---------------- */

let pass = 0,
  fail = 0;
const watched = [];
const check = (name, ok, watch, r) => {
  if (ok) {
    console.log(`  ok      ${name}`);
    watched.push(watch);
    pass++;
  } else {
    console.error(`  FAIL    ${name}   exit=${r.code}`);
    console.error(
      String(r.out)
        .split("\n")
        .map((l) => `          | ${l}`)
        .join("\n")
    );
    fail++;
  }
};

const ROUTING = job({
  id: "e2e-open-swe-routing",
  name: "E2E — open-swe runtime routing (all three runtimes)",
});

/* ---------------- REJECT ---------------- */

{
  // #398 itself: protection names the pre-rename context, the branch produces the new one.
  const r = run(tree({ jobs: ROUTING }), {
    contexts: ["E2E — open-swe runtime routing (both backends)"],
  });
  check(
    "REJECT  a required context NO job produces — the #398 deadlock",
    r.code === 1 &&
      /REQUIRED BUT NOT PRODUCED \(1\)/.test(r.out) &&
      /both backends/.test(r.out) &&
      /PRODUCED BUT NOT REQUIRED \(1\)/.test(r.out) &&
      /all three runtimes/.test(r.out),
    "a rename reported from BOTH sides: the dead requirement and the ungated job",
    r
  );
}
{
  // The quiet direction. The job runs, goes red, and blocks nothing.
  const r = run(
    tree({
      jobs:
        ROUTING + job({ id: "gitleaks", name: "Secret scanning — Gitleaks" }),
    }),
    { contexts: ["E2E — open-swe runtime routing (all three runtimes)"] }
  );
  check(
    "REJECT  a job that LOOKS required and is not — the silent direction",
    r.code === 1 &&
      /PRODUCED BUT NOT REQUIRED \(1\)/.test(r.out) &&
      /Secret scanning — Gitleaks/.test(r.out) &&
      !/REQUIRED BUT NOT PRODUCED/.test(r.out),
    "an unrequired job named, with no phantom context invented alongside it",
    r
  );
}
{
  // THE PIN THAT KEEPS THE OPERATOR HONEST. `E2E — Django backend` mentions `push` inside a
  // DISJUNCTION and still runs on pull requests. A substring rule would excuse it here.
  const r = run(
    tree({
      jobs:
        ROUTING +
        job({
          id: "e2e-django",
          name: "E2E — Django backend",
          cond:
            "github.event_name == 'push' || (github.event_name == 'pull_request' && " +
            "github.event.pull_request.head.repo.full_name == github.repository)",
        }),
    }),
    { contexts: ["E2E — open-swe runtime routing (all three runtimes)"] }
  );
  // WHAT THIS PINS, precisely: an `if:` mentioning `push` does NOT excuse a job. Only being
  // enumerated in NOT_REQUIRED does. If excusal were ever derived from the condition alone,
  // this live gate would drop out of the required set the moment its `if:` was written this
  // way — a pattern silently absorbing an exclusion, which is the thing being prevented.
  check(
    "REJECT  a `push` mention in `if:` does not excuse a job — only the enumerated list does",
    r.code === 1 &&
      /PRODUCED BUT NOT REQUIRED \(1\)/.test(r.out) &&
      /Django backend/.test(r.out),
    "a live gate still demanded, its `push` mention excusing nothing on its own",
    r
  );
}
{
  // An enumerated hole whose stated reason has stopped being true. The entry still reads as a
  // considered decision; the job now reports on pull requests.
  const widened = EXCLUDED_JOBS.replace(
    /    if: >-\n      github\.event_name == 'push'\n      && github\.ref[\s\S]*?github\.repository\)\n/,
    "    if: >-\n      github.event_name == 'push' || github.event_name == 'pull_request'\n"
  );
  if (widened === EXCLUDED_JOBS) {
    console.error("FAIL  the stale-exclusion fixture did not widen anything.");
    process.exit(1);
  }
  const d = tree({ excluded: false, jobs: widened + ROUTING });
  const r = run(d, {
    contexts: ["E2E — open-swe runtime routing (all three runtimes)"],
  });
  check(
    "REJECT  an exclusion whose stated reason no longer holds",
    r.code === 1 &&
      /EXCLUSION NO LONGER JUSTIFIED \(1\)/.test(r.out) &&
      /llm-key-configured/.test(r.out) &&
      /declared as: push-only/.test(r.out),
    "a hole that stopped being justified, reported as the stale entry rather than as a bare diff",
    r
  );
}
{
  // A hole held open for a job that is gone.
  const withoutOne = EXCLUDED_JOBS.slice(
    0,
    EXCLUDED_JOBS.indexOf("  e2e-llm:")
  );
  const d = tree({ excluded: false, jobs: withoutOne + ROUTING });
  const r = run(d, {
    contexts: ["E2E — open-swe runtime routing (all three runtimes)"],
  });
  check(
    "REJECT  an exclusion for a job the workflow no longer declares",
    r.code === 1 &&
      /EXCLUSION FOR A JOB NO LONGER FOUND \(1\)/.test(r.out) &&
      /e2e-llm/.test(r.out),
    "a dead exclusion refusing to rot quietly",
    r
  );
}

/* ---------------- ACCEPT ---------------- */

{
  const r = run(tree({ jobs: ROUTING }), {
    contexts: ["E2E — open-swe runtime routing (all three runtimes)"],
  });
  // The second half of the title is the mutation-sensitive part: llm-key-configured's real
  // `if:` nests a `||` INSIDE a conjunct. A checker reading "contains ||" as "runs on PRs"
  // calls this exclusion stale and sits red on a correct repository — the false red that gets
  // a gate switched off. That misreading was live in this file's first draft.
  check(
    "ACCEPT  agreement passes, and a `push && (a || b)` exclusion is still read as push-only",
    r.code === 0 &&
      /PASS: 1 required context\(s\) and 1 job context\(s\)/.test(r.out) &&
      /3 job\(s\) deliberately not required/.test(r.out) &&
      /e2e-live-transport/.test(r.out) &&
      /llm-key-configured/.test(r.out) &&
      /e2e-llm/.test(r.out),
    "the shipped exclusion list passing on a tree it correctly describes",
    r
  );
}
{
  // A matrix job reports one context per leg. Counting it as one is the silent direction with
  // extra steps: two of the three would stop being gated and nothing would say so.
  const r = run(
    tree({
      extra: {
        "cross-version.yml":
          "name: Cross-Version\non:\n  pull_request:\n  push:\n\njobs:\n" +
          job({
            id: "node-matrix",
            name: "Node ${{ matrix.node }} — full build + test",
            matrix: { node: "[20, 22, 24]" },
          }),
      },
      jobs: ROUTING,
    }),
    {
      contexts: [
        "E2E — open-swe runtime routing (all three runtimes)",
        "Node 20 — full build + test",
        "Node 22 — full build + test",
        "Node 24 — full build + test",
      ],
    }
  );
  check(
    "ACCEPT  a static matrix expands to ONE context per leg, not one per job",
    r.code === 0 &&
      /4 required context\(s\) and 4 job context\(s\)/.test(r.out),
    "three legs counted as three contexts",
    r
  );
}
{
  // Scheduled and dispatch-only workflows cannot report on a pull request. They are outside
  // the subject, not exceptions to it — so they are derived away rather than enumerated.
  const r = run(
    tree({
      extra: {
        "mutation.yml":
          "name: Mutation\non:\n  schedule:\n    - cron: '0 3 * * 1'\n  workflow_dispatch:\n\njobs:\n" +
          job({ id: "stryker", name: "Stryker — server" }),
      },
      jobs: ROUTING,
    }),
    { contexts: ["E2E — open-swe runtime routing (all three runtimes)"] }
  );
  check(
    "ACCEPT  a workflow with no `pull_request` trigger contributes no contexts",
    r.code === 0 &&
      /from 1 of 2 workflow\(s\)/.test(r.out) &&
      !/Stryker/.test(r.out),
    "one of two workflows counted, and the count said so",
    r
  );
}

/* ---------------- REFUSE ---------------- */

{
  // The fork-PR path, which real runs take: the token cannot read repo settings.
  const r = run(tree({ jobs: ROUTING }), { ghFails: true });
  check(
    "REFUSE  unreadable branch protection exits 2, never 0",
    r.code === 2 && /REFUSING TO REPORT/.test(r.out) && /403/.test(r.out),
    "the fork-PR path refusing instead of reporting agreement it never computed",
    r
  );
}
{
  const r = run(tree({ jobs: ROUTING }), { contexts: [] });
  check(
    "REFUSE  an EMPTY required-context list exits 2 — it is not `no disagreements found`",
    r.code === 2 && /EMPTY required-context list/.test(r.out),
    "zero contexts refusing to score as agreement",
    r
  );
}
{
  const r = run(
    tree({
      jobs: job({ id: "odd", name: "Build on ${{ github.event_name }}" }),
    }),
    { contexts: ["anything"] }
  );
  check(
    "REFUSE  a name this checker cannot resolve exits 2 rather than comparing a guess",
    r.code === 2 && /not a matrix value/.test(r.out),
    "an unresolvable name template refusing rather than being dropped from the job side",
    r
  );
}
{
  const r = run(
    tree({
      extra: {
        "severability.yml":
          "name: Sev\non:\n  pull_request:\n  push:\n\njobs:\n" +
          "  eject:\n    name: eject ${{ matrix.name }}\n    runs-on: ubuntu-latest\n" +
          "    strategy:\n      matrix: ${{ fromJson(needs.other.outputs.matrix) }}\n" +
          '    steps:\n      - run: "true"\n',
      },
      jobs: ROUTING,
    }),
    { contexts: ["anything"] }
  );
  check(
    "REFUSE  a run-time matrix whose resolver does not describe it exits 2",
    r.code === 2 && /registered resolver describes/.test(r.out),
    "a resolver that stopped matching refusing rather than expanding a matrix it no longer describes",
    r
  );
}

/* ---------------- the real tree ---------------- */

{
  // NON-VACUITY OF THE RESOLVER. Every case above uses a synthetic tree, so none of them
  // establishes that severability.yml's run-time matrix resolves to anything at all. An empty
  // resolution would under-report the job side in silence — the exact shape being checked for.
  // Fed a deliberately wrong list, the real tree must name real `eject …` contexts.
  const r = run(ROOT, { contexts: ["Build, Test, Validate"] });
  const ejects = [...String(r.out).matchAll(/"eject [^"]+"/g)].length;
  check(
    "RESOLVER  the real run-time severability matrix expands to real contexts, not to nothing",
    r.code === 1 && ejects > 0,
    `${ejects} \`eject …\` context(s) resolved by running the repo's own matrix generator`,
    r
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

const total = pass + fail;
if (total !== 13) {
  console.error(
    `FAIL: ran ${total} cases, expected 13 — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(`\nFAIL: ${fail}/${total}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(`\nPASS: ${pass}/${total}. Watched, in order:`);
for (const w of watched) console.log(`      - ${w}`);
