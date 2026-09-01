#!/usr/bin/env node
/**
 * WHICH JOBS RUN ON WHICH EVENTS — E2E-05 AND CI-01, ASSERTED (#E2E-05, #CI-01).
 *
 * A FORK INHERITS THE WORKFLOWS, so a claim about which jobs run on which
 * events is a claim about what a forker gets. Two requirements say so and
 * nothing checked either:
 *
 *   E2E-05  `e2e-django` and `e2e-fastapi` run on every push to main and every
 *           SAME-REPO pull request; they are SKIPPED on fork PRs, which cannot
 *           reach the secrets they need, and `e2e-fork-coverage` reports that
 *           absence rather than leaving two jobs quietly missing from a green
 *           check list.
 *   CI-01   a GitHub Actions job runs `pnpm test:e2e` on pull requests.
 *
 * THE ABSENCE HALF NEEDS THE PRESENCE HALF, OR IT IS SATISFIED BY NOTHING.
 * "these jobs do not run on a fork PR" is true of a workflow where they never
 * run for anyone. So both halves are asserted TOGETHER against the same
 * conditions: the same two jobs must RUN on push-to-main and on a same-repo PR,
 * and must NOT run on a fork PR. Delete the fork condition and the absence
 * fails; delete the jobs and the presence fails. Neither half stands alone.
 *
 * IT EVALUATES THE CONDITION; IT DOES NOT GREP IT. `isPushOnly` in #404's
 * checker documents why the substring reading is wrong — all three of these
 * mention `github.event_name == 'push'` and only two are push-only. This one
 * needs a finer answer than push-only/not (three contexts, not two), so it
 * parses the boolean structure and evaluates the atoms per context.
 *
 * AND IT REFUSES ON AN ATOM IT DOES NOT KNOW, which is where it parts company
 * with #404 deliberately. That checker can default an unreadable condition to
 * "PR-capable" because it makes ONE directional claim: guessing wrong costs a
 * loud false failure. THIS one claims presence AND absence, so there is no safe
 * default — a guess corrupts whichever half it lands on. "I could not read the
 * workflow" must never read as "the workflow is correct".
 *
 * THE SCRIPT NAME IS RESOLVED THROUGH package.json, NOT MATCHED IN THE YAML.
 * ARCHITECT found the other side of this today: nothing in `.github/` names
 * `scripts/assert-build-order.mjs`, because ci.yml runs `pnpm build-order` and
 * package.json maps it — so a checker looking for the file reports a job absent
 * that runs on every push. And the substring reading fails here in the opposite
 * direction, measured: `ci.yml` runs `pnpm test:e2e-registration`, and
 * `/test:e2e\b/` MATCHES IT, because `\b` holds before the hyphen. A CI-01 check
 * written that way is satisfied by a job that has nothing to do with E2E.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import {
  parseJobs,
  topLevelConjuncts,
} from "./assert-required-contexts-match-jobs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

/**
 * The three event contexts these requirements distinguish.
 *
 * `github.ref` on a pull_request is `refs/pull/N/merge`, never a branch ref —
 * that is why the same `github.ref == 'refs/heads/main'` conjunct that admits a
 * push excludes both PR contexts.
 */
export const CONTEXTS = {
  "push to main": {
    event_name: "push",
    ref: "refs/heads/main",
    sameRepo: null, // no pull_request payload exists on a push
  },
  "same-repo PR": {
    event_name: "pull_request",
    ref: "refs/pull/1/merge",
    sameRepo: true,
  },
  "fork PR": {
    event_name: "pull_request",
    ref: "refs/pull/1/merge",
    sameRepo: false,
  },
};

class Unreadable extends Error {}

/** Evaluate one atom, or refuse. Never guesses. */
function atom(text, ctx) {
  const t = text
    .trim()
    .replace(/^\(+|\)+$/g, "")
    .trim();
  if (t === "true") return true;
  if (t === "false") return false;

  let m = t.match(/^github\.event_name\s*(==|!=)\s*'([a-z_]+)'$/);
  if (m)
    return m[1] === "==" ? ctx.event_name === m[2] : ctx.event_name !== m[2];

  m = t.match(/^github\.ref\s*(==|!=)\s*'([^']+)'$/);
  if (m) return m[1] === "==" ? ctx.ref === m[2] : ctx.ref !== m[2];

  m = t.match(
    /^github\.event\.pull_request\.head\.repo\.full_name\s*(==|!=)\s*github\.repository$/
  );
  if (m) {
    if (ctx.sameRepo === null) {
      // On a push there is no pull_request payload; the comparison is
      // undefined == repo, which GitHub evaluates false. Stated rather than
      // assumed, because reading it as `true` would make every fork-guarded job
      // look like it runs on push for the wrong reason.
      return m[1] === "==" ? false : true;
    }
    return m[1] === "==" ? ctx.sameRepo : !ctx.sameRepo;
  }

  throw new Unreadable(t);
}

/** `a || b` over conjunct groups, each split by #404's brace-aware splitter. */
function evalExpr(expr, ctx) {
  const s = String(expr ?? "").trim();
  if (s === "") return true; // no `if:` — the job always runs
  // split on top-level `||` using the same depth/quote discipline
  const parts = [];
  let cur = "",
    depth = 0,
    quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && ch === "|" && s[i + 1] === "|") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const groups = parts.map((p) => p.trim()).filter(Boolean);
  return groups.some((g) => {
    const inner = g.replace(/\s+/g, " ").trim();
    // a parenthesised group that still contains a top-level `||` recurses
    const stripped = inner.replace(/^\((.*)\)$/s, "$1");
    if (stripped !== inner) return evalExpr(stripped, ctx);
    return topLevelConjuncts(inner).every((c) => {
      const cs = c.trim();
      const inner2 = cs.replace(/^\((.*)\)$/s, "$1");
      return inner2 !== cs ? evalExpr(inner2, ctx) : atom(cs, ctx);
    });
  });
}

export function jobRunsOn(job, ctxName) {
  return evalExpr(job.if, CONTEXTS[ctxName]);
}

export function workflowJobs(file) {
  const text = readFileSync(file, "utf8");
  const { known, jobs } = parseJobs(text);
  if (!known) throw new Unreadable(`${file} has no \`jobs:\` block`);
  return jobs;
}

/** `pnpm <script>` invocations in a workflow's `run:` steps, resolved EXACTLY. */
export function pnpmScriptsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/\brun:\s*pnpm\s+([A-Za-z0-9:_-]+)/g))
    out.add(m[1]);
  return out;
}

/**
 * THE DECLARATION. Each row is a requirement's claim in the form the workflow
 * can be asked about, with the requirement id so a failure names what it broke.
 */
export const CLAIMS = [
  {
    req: "E2E-05",
    workflow: "e2e.yml",
    job: "e2e-django",
    runsOn: ["push to main", "same-repo PR"],
    notOn: ["fork PR"],
    why: "E2E-05 requires the Django backend exercised on every same-repo change",
    whyNot: "it needs repository secrets a fork PR cannot reach",
  },
  {
    req: "E2E-05",
    workflow: "e2e.yml",
    job: "e2e-fastapi",
    runsOn: ["push to main", "same-repo PR"],
    notOn: ["fork PR"],
    why: "E2E-05 requires the FastAPI backend exercised on every same-repo change",
    whyNot: "it needs repository secrets a fork PR cannot reach",
  },
  {
    req: "E2E-05",
    workflow: "e2e.yml",
    job: "e2e-fork-coverage",
    runsOn: ["fork PR", "same-repo PR"],
    notOn: [],
    why: "it reports the absence of the two jobs above rather than leaving them silently missing",
    whyNot: "",
  },
];

export function check({ root = ROOT } = {}) {
  const wfDir = join(root, ".github", "workflows");
  const problems = [];
  const observed = [];

  for (const claim of CLAIMS) {
    const file = join(wfDir, claim.workflow);
    let jobs;
    try {
      jobs = workflowJobs(file);
    } catch (e) {
      problems.push({ kind: "unreadable", req: claim.req, detail: e.message });
      continue;
    }
    const job = jobs.find((j) => j.id === claim.job);
    if (!job) {
      problems.push({
        kind: "missing-job",
        req: claim.req,
        detail:
          `${claim.workflow} declares no job \`${claim.job}\`. It was renamed or removed; ` +
          `${claim.req} names it, so the requirement is now about a job that does not exist.`,
      });
      continue;
    }
    for (const ctx of [...claim.runsOn, ...claim.notOn]) {
      let runs;
      try {
        runs = jobRunsOn(job, ctx);
      } catch (e) {
        problems.push({
          kind: "unreadable",
          req: claim.req,
          detail:
            `${claim.workflow}:${job.line} \`${claim.job}\` has a condition this cannot ` +
            `evaluate: ${e.message}. REFUSING rather than guessing — this check asserts both ` +
            `presence and absence, so a guess corrupts one of them.`,
        });
        runs = null;
      }
      if (runs === null) continue;
      observed.push({ job: claim.job, ctx, runs });
      const wanted = claim.runsOn.includes(ctx);
      if (runs !== wanted) {
        problems.push({
          kind: wanted ? "missing-on-event" : "runs-on-forbidden-event",
          req: claim.req,
          detail: wanted
            ? `\`${claim.job}\` does NOT run on ${ctx}, but ${claim.req} says it must — ${claim.why}.`
            : `\`${claim.job}\` RUNS on ${ctx}, but ${claim.req} says it must not — ${claim.whyNot}. ` +
              `The fork guard on its \`if:\` was weakened or removed.`,
        });
      }
    }
  }

  // CI-01 — resolved through package.json, matched exactly.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const ci01 = {
    script: "test:e2e",
    declared: Boolean(pkg.scripts?.["test:e2e"]),
    job: null,
    onPr: null,
  };
  if (!ci01.declared) {
    problems.push({
      kind: "missing-script",
      req: "CI-01",
      detail: `package.json declares no \`test:e2e\` script, so CI-01's subject does not exist.`,
    });
  } else {
    for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(wfDir, f), "utf8");
      /*
       * ONE exact check, not two. A file-level pre-filter used to sit here as
       * well, and the mutation matrix showed the pair was REDUNDANT: mutating
       * either to a prefix match left the other enforcing exactness, so neither
       * could be turned red and the selftest could not tell which line carried
       * the property. Redundancy that reads as defence-in-depth is a hole in the
       * calibration. The per-job check below is now the single owner.
       */
      for (const job of parseJobs(text).jobs) {
        // FROM job.line, NOT job.line - 1: `parseJobs` records the 1-based line OF
        // the job header, so slicing at `line - 1` re-includes that header, which
        // immediately matches the next-job splitter and yields an empty body. The
        // first run of this checker reported CI-01 unrun against a workflow that
        // plainly runs it, which is how the off-by-one surfaced.
        const body = text
          .split("\n")
          .slice(job.line)
          .join("\n")
          .split(/^  [A-Za-z0-9_-]+:\s*$/m)[0];
        if (!pnpmScriptsIn(body).has("test:e2e")) continue;
        ci01.job = `${f}:${job.id}`;
        try {
          ci01.onPr = jobRunsOn(job, "same-repo PR");
        } catch {
          ci01.onPr = null;
        }
      }
    }
    if (!ci01.job) {
      problems.push({
        kind: "script-unrun",
        req: "CI-01",
        detail:
          `\`pnpm test:e2e\` is declared in package.json but no workflow job runs it. ` +
          `NOTE: \`test:e2e-registration\` is a DIFFERENT script and does not satisfy this.`,
      });
    } else if (ci01.onPr === false) {
      problems.push({
        kind: "script-not-on-pr",
        req: "CI-01",
        detail: `\`pnpm test:e2e\` runs in ${ci01.job}, but that job does not run on a pull request.`,
      });
    } else if (ci01.onPr === null) {
      problems.push({
        kind: "unreadable",
        req: "CI-01",
        detail: `\`pnpm test:e2e\` runs in ${ci01.job}, whose condition this cannot evaluate.`,
      });
    }
  }
  return { problems, observed, ci01 };
}

/**
 * `--root DIR` — the tree to check, ABSOLUTE PATHS RESOLVED.
 *
 * Without this the CLI checked the repository the SCRIPT lives in and ignored
 * cwd entirely, so pointing it at a fixture tree silently examined the real
 * workflows instead. The selftest caught it by asserting a REFUSAL on a fixture
 * with no `jobs:` block and getting a PASS — a verdict about a subject the run
 * never looked at, which is the defect this repo names most often. #328 found
 * the identical bug in the vacuity sweep's `--dir`; this one is fixed before it
 * shipped rather than after.
 */
function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  const rootArg = i === -1 ? undefined : argv[i + 1];
  const root = rootArg ? resolve(rootArg) : ROOT;
  let r;
  try {
    r = check({ root });
  } catch (e) {
    console.error(`REFUSING: could not read the workflows — ${e.message}`);
    process.exit(2);
  }
  const { problems, observed, ci01 } = r;
  if (problems.some((p) => p.kind === "unreadable")) {
    for (const p of problems.filter((x) => x.kind === "unreadable")) {
      console.error(`REFUSING [${p.req}]: ${p.detail}`);
    }
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} workflow claim(s) do not hold:\n`);
    for (const p of problems) console.error(`    [${p.req}] ${p.detail}`);
    console.error(
      `\n  A fork inherits these workflows, so this is a claim about what a forker gets.`
    );
    process.exit(1);
  }
  console.log(
    `PASS: E2E-05 and CI-01 hold against .github/workflows.\n` +
      observed
        .map(
          (o) =>
            `    ${o.runs ? "runs    " : "skipped "} ${o.job.padEnd(20)} on ${
              o.ctx
            }`
        )
        .join("\n") +
      `\n    pnpm test:e2e runs in ${ci01.job} (exact script match, resolved through package.json)`
  );
}

if (invokedAsProgram(import.meta.url)) main();
