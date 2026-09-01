#!/usr/bin/env node
/**
 * assert-required-contexts-match-jobs.mjs — branch protection's required-context list and the
 * jobs that produce those contexts must be THE SAME SET, in both directions.
 *
 * THE DEFECT, MEASURED (#404). #398 renamed one job — that rename WAS the change:
 *
 *     E2E — open-swe runtime routing (both backends)  ->  (all three runtimes)
 *
 * Branch protection still required the old name. The old name no longer existed on the
 * branch, so nothing could ever report it. The PR sat BLOCKED with 35 checks green and ZERO
 * failures, including the renamed job passing under its new name. It merged by admin
 * override. Third occurrence.
 *
 * The required-context list is a SECOND DECLARATION of a fact already declared in
 * `.github/workflows/*.yml`. Two declarations of one fact, and nothing asserting they agree.
 *
 * BOTH DIRECTIONS, AND THE SECOND IS THE DANGEROUS ONE.
 *
 *   required, but no job produces it   the context can never report. Permanent deadlock.
 *                                      LOUD: nothing merges, someone comes looking.
 *
 *   a job produces it, but not required  the job runs, goes red, and merges anyway. The list
 *                                        still READS like protection and gates nothing.
 *                                        QUIET: no symptom until something ships broken.
 *
 * A checker built only for the first direction would be a checker built for the instance that
 * happened to hurt, which is how a defect class gets fixed one instance at a time forever.
 *
 * WHY THIS IS COMPUTED FROM THE WORKFLOW FILES AND NOT FROM A RECENT RUN. Asking GitHub which
 * contexts recently reported is easier and is the wrong subject: it describes the world BEFORE
 * the pull request. #398's job names were correct in #398's diff and stale everywhere else, so
 * an observed-runs instrument would have agreed with protection and said nothing. The pull
 * request that renames a job is exactly the pull request that has to fail, so the job side of
 * the comparison must come from the branch's own YAML.
 *
 * IT REFUSES RATHER THAN PASSING. Reading branch protection needs repository Administration:
 * READ. The workflow GITHUB_TOKEN cannot be granted that — `administration` is not among the
 * keys a `permissions:` block accepts — so CI needs a PAT or App token in GH_TOKEN, and a fork
 * PR cannot reach a repository secret at all. "Cannot read it" is therefore a path real runs
 * take, not a corner case. An unreadable list scoring as "no disagreements found" would be
 * this repo's house defect committed by the checker written to remove it. Exit 2 — the
 * established code for "could not be checked" — never 0.
 *
 * WHERE IT CAN RUN follows from that and is not a preference: same-repo pull requests and
 * pushes to main, which is exactly where a job rename lands. See the note in the report on
 * #404 for the wiring that decision implies.
 *
 * Exit codes:  0  the two declarations agree
 *              1  they disagree, in either direction
 *              2  the comparison could not be made at all
 *
 * Usage:  node scripts/assert-required-contexts-match-jobs.mjs
 *           [--cwd DIR] [--repo OWNER/REPO] [--branch main]
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || !argv[i + 1] ? fallback : argv[i + 1];
};

/* ------------------------------------------------------------------ *
 * THE ENUMERATED EXCEPTIONS
 * ------------------------------------------------------------------ */

/**
 * Jobs that run on pull-request-triggered workflows and are deliberately NOT required.
 *
 * ENUMERATED, NOT PATTERNED, and the difference is the whole point. A rule like "exclude
 * anything whose name ends in (push to main only)" would have absorbed the third entry below
 * silently — `llm-key-configured` carries no such marker and is push-only all the same. A
 * pattern that quietly adopts the next exclusion recreates the silent direction inside the
 * checker meant to close it. Adding a hole here has to be a deliberate line of code with a
 * reason attached to it.
 *
 * EACH EXCLUSION IS ITSELF CHECKED. `justification` is not prose — it names a predicate that
 * is re-verified against the workflow file on every run. An exclusion whose reason has stopped
 * being true is #378's inert override in another file: it still reads as a considered
 * decision, and it is no longer describing anything. The only justification implemented is:
 *
 *   push-only  the job's `if:` cannot be true for a `pull_request` event, so the job can
 *              never report a context on a PR. Requiring it would block every PR forever —
 *              the same deadlock as direction 1, arrived at from the other side.
 *
 * That predicate is about the INSTRUMENT'S REACH — whether an answer is obtainable in this
 * channel at all — and not about the answer. A condition of the second kind (`if: secrets.X
 * != ''`) hides a verdict and is never a justification for dropping a gate.
 */
const NOT_REQUIRED = [
  {
    workflow: "e2e.yml",
    job: "e2e-live-transport",
    justification: "push-only",
    reason:
      "drives a real open-swe transport with repository secrets; gated on push-to-main so a " +
      "fork PR is never asked to produce a context it has no credentials for.",
  },
  {
    workflow: "e2e.yml",
    job: "e2e-llm",
    justification: "push-only",
    reason:
      "spends real model tokens against a live provider; gated on push-to-main for the same " +
      "reason, and additionally on the key being present at all.",
  },
  {
    workflow: "e2e.yml",
    job: "llm-key-configured",
    justification: "push-only",
    reason:
      "its subject is REPO-LEVEL configuration — whether any model API key exists — which no " +
      "pull request diff can move. Reporting it per-PR would file a constant where every " +
      "reader is looking at a diff, and teach contributors to ignore a red they cannot " +
      "resolve. NOTE: its name does not say 'push to main only'; it is push-only by its `if:`.",
  },
];

/**
 * Matrices whose values are not in the YAML.
 *
 * `severability.yml`'s eject job takes `matrix: ${{ fromJson(needs.matrix.outputs.matrix) }}`
 * from a preceding job that runs `scripts/matrix.mjs --github`. The eight `eject …` contexts
 * therefore exist nowhere in the workflow text, and a checker that parsed only YAML would
 * conclude this workflow produces one context instead of nine — under-reporting the job side
 * is exactly the silent direction, so it must not be approximated.
 *
 * Resolving it by running the repo's own generator is what the workflow itself does, so it is
 * a reading of the fact rather than a guess about it. `expression` is matched EXACTLY: if the
 * workflow starts deriving its matrix some other way, this stops applying and the run refuses
 * rather than resolving a matrix it no longer describes.
 */
const MATRIX_RESOLVERS = [
  {
    workflow: "severability.yml",
    job: "eject",
    expression: "${{ fromJson(needs.matrix.outputs.matrix) }}",
    resolve(root) {
      const out = execFileSync(
        process.execPath,
        [join(root, "scripts", "matrix.mjs"), "--github"],
        { encoding: "utf8", cwd: root }
      );
      const line = out.split("\n").find((l) => l.startsWith("matrix="));
      if (!line)
        throw new Error("matrix.mjs --github printed no `matrix=` line");
      const parsed = JSON.parse(line.slice("matrix=".length));
      const include = parsed.include;
      if (!Array.isArray(include) || include.length === 0)
        throw new Error("matrix.mjs --github produced an empty include list");
      return include;
    },
  },
];

/* ------------------------------------------------------------------ *
 * WORKFLOW SIDE
 * ------------------------------------------------------------------ */

/** Strip one layer of YAML quoting from a scalar. */
const unquote = (s) => {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  )
    return t.slice(1, -1);
  return t;
};

/** `[20, 22, 24]` / `["^15.5.0", "^16.0.0"]` -> string[]. Null if not a flow sequence. */
export function parseFlowList(value) {
  const t = value.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => v.trim());
}

/**
 * Does this workflow run on `pull_request` at all?
 *
 * A workflow that does not is not a candidate — its jobs cannot produce a context on a PR, so
 * they are outside the subject rather than exceptions to it. That distinction is derived, not
 * enumerated, because it is a property of the trigger block and needs no human judgement.
 *
 * check-pr-triggers.mjs already guarantees no `pull_request` trigger here carries a `branches`
 * or `paths` filter, which is what lets "declares pull_request" mean "runs on every PR".
 */
export function runsOnPullRequest(text) {
  const lines = text.split("\n");
  const top = lines.findIndex((l) => /^on:/.test(l));
  if (top === -1) return { known: false };
  const inline = lines[top].slice(3).trim();
  if (inline !== "")
    return { known: true, value: /\bpull_request\b/.test(inline) };
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (!/^ {2}/.test(l)) break; // dedented out of the `on:` block
    if (/^ {2}pull_request:/.test(l)) return { known: true, value: true };
    if (/^ {2}-\s*pull_request\s*$/.test(l))
      return { known: true, value: true };
  }
  return { known: true, value: false };
}

/**
 * Jobs declared by a workflow, with the fields that decide a context name.
 *
 * Deliberately a line scanner and not a YAML parse: the repo has no YAML dependency and its
 * other workflow checkers are line scanners too. The cost is that unusual shapes are not
 * understood — which is paid for by REFUSING on anything unrecognised rather than skipping it.
 */
export function parseJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return { known: false, jobs: [] };

  const jobs = [];
  let cur = null;
  let section = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (/^\S/.test(l)) break; // dedented out of `jobs:`

    const head = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (head) {
      cur = {
        id: head[1],
        line: i + 1,
        name: null,
        if: "",
        matrixExpr: null,
        matrix: {},
      };
      jobs.push(cur);
      section = null;
      continue;
    }
    if (!cur) continue;

    // Which job-level key are we inside? `matrix:` appears at the same indent under BOTH
    // `strategy:` and `outputs:` — severability.yml has one of each, and reading the wrong one
    // makes a plain job look like a matrix job. The section is the disambiguator.
    const key = l.match(/^ {4}([A-Za-z0-9_-]+):/);
    if (key) section = key[1];

    const name = l.match(/^ {4}name:\s*(.+)$/);
    if (name) {
      cur.name = unquote(name[1]);
      continue;
    }

    // `if:` may be a scalar or a block (`|`, `>-`, …). Fold the block into one line: the
    // predicate below asks about operators and operands, not about layout.
    const cond = l.match(/^ {4}if:\s*(.*)$/);
    if (cond) {
      if (/^[|>][-+]?\d*$/.test(cond[1].trim()) || cond[1].trim() === "") {
        const parts = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*$/.test(lines[j])) continue;
          if (!/^ {6}/.test(lines[j])) break;
          parts.push(lines[j].trim());
        }
        cur.if = parts.join(" ");
      } else {
        cur.if = cond[1].trim();
      }
      continue;
    }

    const mx = section === "strategy" ? l.match(/^ {6}matrix:\s*(.*)$/) : null;
    if (mx) {
      if (mx[1].trim() !== "") {
        cur.matrixExpr = mx[1].trim();
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*(#.*)?$/.test(lines[j])) continue;
          if (!/^ {8}/.test(lines[j])) break;
          const kv = lines[j].match(/^ {8}([A-Za-z0-9_-]+):\s*(.*)$/);
          if (!kv) continue;
          cur.matrix[kv[1]] = kv[2].trim();
        }
      }
      continue;
    }
  }
  return { known: true, jobs };
}

/**
 * Split a GitHub expression on its TOP-LEVEL `&&`, respecting parentheses and quotes.
 *
 * `a && (b || c)` is two conjuncts, not a disjunction. Telling those apart is the whole job of
 * this function, and getting it wrong in either direction is a real defect — see isPushOnly.
 */
export function topLevelConjuncts(expr) {
  const parts = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
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
    if (depth === 0 && ch === "&" && expr[i + 1] === "&") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Can this job's `if:` ever be true for a `pull_request` event?
 *
 * The answer turns on the OPERATOR, not on the substring. All three of these mention the same
 * equality and only two of them are push-only:
 *
 *   github.event_name == 'push' && github.ref == 'refs/heads/main'
 *       -> never on a PR. A conjunction with a conjunct that demands `push` is false when the
 *          event is `pull_request`, whatever the other conjuncts say.
 *
 *   github.event_name == 'push' && (github.event_name != 'pull_request' || …)
 *       -> also never on a PR, and the `||` is INSIDE a conjunct. A rule of "contains `||`,
 *          therefore PR-capable" calls this one wrong — measured: it is `llm-key-configured`,
 *          and that misreading is what this function was rewritten to fix.
 *
 *   github.event_name == 'push' || (github.event_name == 'pull_request' && …)
 *       -> RUNS on a PR. This is `E2E — Django backend`, a live required gate. A grep for
 *          `github.event_name == 'push'` would excuse it from being required — silently
 *          dropping a real gate, which is the direction with no symptom.
 *
 * Anything this cannot recognise as push-only is reported as PR-capable, which demands that
 * the job be required and fails LOUDLY. Being wrong that way costs one line to correct; being
 * wrong the other way quietly removes a gate.
 */
export function isPushOnly(condition) {
  const c = String(condition ?? "").trim();
  if (c === "") return false;
  return topLevelConjuncts(c).some((part) =>
    /^\(*\s*github\.event_name\s*==\s*'push'\s*\)*$/.test(part.trim())
  );
}

/** The context name(s) a job reports under, or a stated reason it cannot be determined. */
export function contextsForJob(job, { workflow, root }) {
  const template = job.name ?? job.id;
  const refs = [...template.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) =>
    m[1].trim()
  );

  if (refs.length === 0) {
    // A matrix job with a literal name reports that one name for every leg — they collide in
    // the checks list. Not present here; refuse rather than model a shape nobody uses.
    if (job.matrixExpr !== null || Object.keys(job.matrix).length > 0)
      return {
        error:
          `job \`${job.id}\` has a matrix but a constant name "${template}", so every leg ` +
          `reports the same context. This checker does not model that shape.`,
      };
    return { contexts: [template] };
  }

  if (job.name === null)
    return {
      error:
        `job \`${job.id}\` has no \`name:\`, so GitHub derives its context from the job id ` +
        `and its matrix values. This checker does not model that shape.`,
    };

  const matrixKeys = refs.map(
    (r) => r.match(/^matrix\.([A-Za-z0-9_-]+)$/)?.[1] ?? null
  );
  if (matrixKeys.some((k) => k === null))
    return {
      error:
        `job \`${job.id}\` names itself with ${refs
          .map((r) => `\${{ ${r} }}`)
          .join(", ")}, ` +
        `which is not a matrix value. Its context name is not derivable from this file.`,
    };

  // Where do the matrix values come from?
  let legs;
  if (job.matrixExpr !== null) {
    const r = MATRIX_RESOLVERS.find(
      (x) => x.workflow === workflow && x.job === job.id
    );
    if (!r)
      return {
        error:
          `job \`${job.id}\` derives its matrix at run time (\`${job.matrixExpr}\`) and no ` +
          `resolver is registered for it, so its contexts cannot be enumerated here.`,
      };
    if (r.expression !== job.matrixExpr)
      return {
        error:
          `job \`${job.id}\` now derives its matrix as \`${job.matrixExpr}\`, but the ` +
          `registered resolver describes \`${r.expression}\`. The resolver no longer ` +
          `describes the matrix it claims to resolve.`,
      };
    try {
      legs = r.resolve(root);
    } catch (e) {
      return {
        error: `resolving \`${job.id}\`'s matrix failed: ${
          e.message.split("\n")[0]
        }`,
      };
    }
  } else {
    legs = [{}];
    for (const key of new Set(matrixKeys)) {
      const raw = job.matrix[key];
      if (raw === undefined)
        return {
          error: `job \`${job.id}\` interpolates \`matrix.${key}\`, which its matrix does not declare.`,
        };
      const values = parseFlowList(raw);
      if (values === null)
        return {
          error:
            `job \`${job.id}\`'s \`matrix.${key}\` is \`${raw}\`, which this checker cannot ` +
            `read as a list of values.`,
        };
      if (values.length === 0)
        return {
          error: `job \`${job.id}\`'s \`matrix.${key}\` is empty, so it produces no legs.`,
        };
      legs = legs.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
    }
  }

  if (!legs || legs.length === 0)
    return {
      error: `job \`${job.id}\` expands to zero matrix legs, so it produces no contexts.`,
    };

  const contexts = legs.map((leg) =>
    template.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => {
      const key = expr.trim().match(/^matrix\.([A-Za-z0-9_-]+)$/)[1];
      return String(leg[key]);
    })
  );
  return { contexts };
}

/** Every context a pull request is expected to see, and why the rest are absent. */
export function expectedContexts(root) {
  const dir = join(root, ".github", "workflows");
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
  } catch (e) {
    return { refuse: `cannot read ${dir} — ${e.message}` };
  }
  if (files.length === 0)
    return { refuse: `no workflow files in ${dir}; nothing to compare.` };

  const produced = []; // {context, workflow, job}
  const excused = []; // {context, workflow, job, reason}
  const staleExclusions = [];
  let prWorkflows = 0;

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const trig = runsOnPullRequest(text);
    if (!trig.known)
      return { refuse: `${file} has no recognisable \`on:\` block.` };
    if (!trig.value) continue;
    prWorkflows++;

    const { known, jobs } = parseJobs(text);
    if (!known)
      return {
        refuse: `${file} declares \`pull_request\` but has no \`jobs:\` block.`,
      };
    if (jobs.length === 0)
      return {
        refuse: `${file} has a \`jobs:\` block this checker read as empty.`,
      };

    for (const job of jobs) {
      const excl = NOT_REQUIRED.find(
        (e) => e.workflow === file && e.job === job.id
      );
      if (excl) {
        // The exclusion's stated reason is re-derived from the file, every run.
        if (excl.justification === "push-only" && !isPushOnly(job.if)) {
          // Report the stale exclusion and stop: listing it ALSO as an ungated context would
          // count one defect twice and bury the root, which is the entry that has to change.
          staleExclusions.push({
            workflow: file,
            job: job.id,
            line: job.line,
            was: "push-only",
            now: job.if === "" ? "(no `if:` at all)" : job.if,
          });
          continue;
        } else {
          excused.push({ workflow: file, job: job.id, reason: excl.reason });
          continue;
        }
      }
      const r = contextsForJob(job, { workflow: file, root });
      if (r.error) return { refuse: `${file}: ${r.error}` };
      for (const c of r.contexts)
        produced.push({ context: c, workflow: file, job: job.id });
    }
  }

  if (prWorkflows === 0)
    return {
      refuse: `${files.length} workflow(s) found, none declaring \`pull_request:\`.`,
    };
  if (produced.length === 0 && staleExclusions.length === 0)
    return {
      refuse: `${prWorkflows} pull-request workflow(s) yielded zero contexts.`,
    };

  // Dead exclusions: a hole left open for a job that is no longer a pull-request job in that
  // workflow reads as a considered decision about something that is gone.
  const dead = NOT_REQUIRED.filter(
    (e) =>
      !excused.some((x) => x.workflow === e.workflow && x.job === e.job) &&
      !staleExclusions.some((x) => x.workflow === e.workflow && x.job === e.job)
  );

  return {
    produced,
    excused,
    staleExclusions,
    dead,
    prWorkflows,
    files: files.length,
  };
}

/* ------------------------------------------------------------------ *
 * PROTECTION SIDE
 * ------------------------------------------------------------------ */

export function readRequiredContexts({ repo, branch }) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/branches/${branch}/protection`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (e) {
    const detail =
      `${e.stderr ?? ""}${e.stdout ?? ""}`.split("\n").filter(Boolean)[0] ??
      e.message;
    return {
      refuse:
        `could not read branch protection for ${repo}@${branch} — ${detail}\n` +
        `      Reading it needs a token with repository Administration: READ. The workflow\n` +
        `      GITHUB_TOKEN cannot carry that scope — \`administration\` is not one of the keys\n` +
        `      a \`permissions:\` block accepts — so in CI this needs a PAT or App token in\n` +
        `      GH_TOKEN, and a fork PR cannot reach one at all. That is why this exits 2.`,
    };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      refuse: `branch protection for ${repo}@${branch} did not parse as JSON.`,
    };
  }
  const rsc = json.required_status_checks;
  if (!rsc)
    return {
      refuse: `${repo}@${branch} declares no \`required_status_checks\` at all.`,
    };
  const contexts = rsc.contexts ?? (rsc.checks ?? []).map((c) => c.context);
  if (!Array.isArray(contexts) || contexts.length === 0)
    return {
      refuse:
        `${repo}@${branch} returned an EMPTY required-context list. An empty list scores as ` +
        `"no disagreements found", which is the vacuous green this check exists to prevent.`,
    };
  return { contexts };
}

function defaultRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      cwd: resolve(arg("cwd", ROOT)),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
    if (m) return m[1];
  } catch {
    /* fall through to the refusal below */
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * MAIN
 * ------------------------------------------------------------------ */

const refuse = (msg) => {
  console.error(`REFUSING TO REPORT: ${msg}`);
  console.error(
    `      Exit 2, not 0 — this check made no comparison, which is a different answer\n` +
      `      from "the two declarations agree".`
  );
  process.exit(2);
};

function main() {
  const root = resolve(arg("cwd", ROOT));
  const branch = arg("branch", "main");
  const repo = arg("repo", null) ?? defaultRepo();
  if (!repo)
    refuse("no repository — pass --repo OWNER/REPO or set GITHUB_REPOSITORY.");

  const jobs = expectedContexts(root);
  if (jobs.refuse) refuse(jobs.refuse);

  const prot = readRequiredContexts({ repo, branch });
  if (prot.refuse) refuse(prot.refuse);

  const required = new Set(prot.contexts);
  const producedNames = new Set(jobs.produced.map((p) => p.context));

  const phantom = [...required].filter((c) => !producedNames.has(c));
  const ungated = jobs.produced.filter((p) => !required.has(p.context));
  const { staleExclusions, dead } = jobs;

  const failures =
    phantom.length + ungated.length + staleExclusions.length + dead.length;

  if (failures === 0) {
    console.log(
      `PASS: ${required.size} required context(s) and ${producedNames.size} job context(s) ` +
        `from ${jobs.prWorkflows} of ${jobs.files} workflow(s) are the same set.\n` +
        `      ${jobs.excused.length} job(s) deliberately not required, each still push-only:\n` +
        jobs.excused.map((e) => `        ${e.workflow}  ${e.job}`).join("\n") +
        `\n      Compared against ${repo}@${branch}.`
    );
    return;
  }

  console.error(
    `FAIL: ${required.size} required context(s) vs ${producedNames.size} job context(s) from ` +
      `${jobs.prWorkflows} of ${jobs.files} workflow(s) — ${failures} disagreement(s).\n`
  );

  if (phantom.length) {
    console.error(
      `  REQUIRED BUT NOT PRODUCED (${phantom.length}) — these can never report, so every pull\n` +
        `  request is blocked forever with no failure to point at:`
    );
    for (const c of phantom) console.error(`      "${c}"`);
    console.error(
      `\n      Either a job was renamed or deleted without updating branch protection, or the\n` +
        `      context was typed by hand. Update the required-context list on ${branch}.\n`
    );
  }

  if (ungated.length) {
    console.error(
      `  PRODUCED BUT NOT REQUIRED (${ungated.length}) — these run and can go red without\n` +
        `  blocking anything. The list still reads like protection and is not gating them:`
    );
    for (const p of ungated)
      console.error(`      "${p.context}"   ${p.workflow} → ${p.job}`);
    console.error(
      `\n      Add each to branch protection, or add it to NOT_REQUIRED in this file with a\n` +
        `      reason and a justification that this checker can re-verify.\n`
    );
  }

  if (staleExclusions.length) {
    console.error(
      `  EXCLUSION NO LONGER JUSTIFIED (${staleExclusions.length}) — the hole is still declared,\n` +
        `  the reason for it has stopped being true:`
    );
    for (const s of staleExclusions)
      console.error(
        `      ${s.workflow}:${s.line}  ${s.job}\n` +
          `          declared as: ${s.was}\n` +
          `          its \`if:\` is now: ${s.now}\n` +
          `          it can report on a pull request now, so it must be required or re-justified.`
      );
    console.error("");
  }

  if (dead.length) {
    console.error(
      `  EXCLUSION FOR A JOB NO LONGER FOUND (${dead.length}) — the workflow no longer declares\n` +
        `  it as a pull-request job:`
    );
    for (const d of dead) console.error(`      ${d.workflow}  ${d.job}`);
    console.error(
      `\n      Delete the entry from NOT_REQUIRED. A hole held open for something that is gone\n` +
        `      reads as a considered decision and describes nothing.\n`
    );
  }

  process.exit(1);
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
