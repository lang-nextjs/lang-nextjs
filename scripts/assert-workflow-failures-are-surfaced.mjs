#!/usr/bin/env node
/**
 * NO WORKFLOW MAY FAIL WHERE NOBODY LOOKS (#1097, #1021, #742).
 *
 * A workflow without a `pull_request` trigger cannot fail anywhere a person is looking. It is
 * not a required context, no pull request shows its state, and nothing announces it. Three
 * instances were live on this repository at once, each found by accident and none by a gate:
 *
 *     mutation.yml         red from 2026-08-30, found by a reader asking which green covered
 *                          a version bump
 *     ci-measurement.yml   red from 2026-09-07, found while investigating the first
 *     E2E live transport   red for 40+ runs, push-to-main only, found while checking whether
 *                          a merge had broken main (#742)
 *
 * THE EVIDENCE EXPIRES, WHICH IS WHY THIS IS URGENT RATHER THAN TIDY. Re-running
 * ci-measurement.yml's failing step today exits 0: its subject is a moving window of recent
 * runs, so the condition that failed no longer exists. Its retained log holds only checkout and
 * cleanup — every step reads `UNKNOWN STEP` and the script's own output is gone. This class does
 * not merely fail unseen; by the time someone looks there is nothing left to see, and each week
 * that passes destroys another week of it.
 *
 * SURFACED IS NOT ENFORCED, AND THIS CHECK ONLY CLAIMS THE FIRST. Measured on this repository:
 * `enforce_admins: false` with 32 required contexts declared, and PR #130 merged carrying
 * `check-runs total_count = 0`. So a failing required check does not stop a merge for us. What
 * a pull-request trigger buys is a person SEEING the failure, not the failure blocking anything
 * — and that is the property this asserts. A gate claiming enforcement would be claiming
 * something the branch protection does not deliver.
 *
 * THE TWO WAYS TO SATISFY IT
 *
 *   surfaces on a pull request   `on:` includes `pull_request`. Someone sees the red.
 *   declares a consumer          a step conditioned on `failure()` that files or updates an
 *                                issue. For a 10-30 minute job a required context is the wrong
 *                                shape at one-merge-per-CI-cycle, so this is the honest channel.
 *
 * There is currently NO notification path in this repository — measured: zero workflows invoke
 * `gh issue create` or `gh issue comment` — so the second option describes a channel that has to
 * be BUILT, not configured. Every entry in the roster below is waiting on that.
 *
 * EXIT CODES
 *   0  every workflow is surfaced, declares a consumer, or is exempt with a named repair
 *   1  a workflow can fail where nobody looks
 *   2  a refusal: something could not be read, so no verdict is available
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";

export class Refusal extends Error {}

/**
 * THE WORKFLOWS THAT CANNOT YET SATISFY THIS, EACH NAMING ITS OWN REPAIR.
 *
 * A reason per entry and a repair per entry, never a bare list: a set of names with one shared
 * implicit reason is the shape that outlives the situation that justified it. Retire an entry by
 * making its workflow satisfy the property, not by editing this list.
 *
 * NO COUNT IS WRITTEN IN THIS SENTENCE. The entries below are the count.
 */
export const KNOWN_UNSURFACED = Object.freeze({
  "mutation.yml": Object.freeze({
    issue: "#1021",
    reason:
      "a 10-30 minute mutation run per package, so a pull_request trigger is the wrong shape at " +
      "one-merge-per-CI-cycle. Red since 2026-08-30 and unseen for a week",
    repair:
      "file-or-update an issue on failure using the ambient GITHUB_TOKEN, then delete this entry",
  }),
  "e2e.yml#e2e-live-transport": Object.freeze({
    issue: "#742",
    reason:
      "live transport needs a real LLM key and a real socket, so it is push-to-main only by " +
      "design (#153 asked for per-PR feedback and this was the chosen cost). Red for 40+ runs",
    repair:
      "file-or-update an issue on failure — the job already runs verdict-streak.mjs, which knows " +
      "the streak; give it a channel. Then delete this entry",
  }),
  "e2e.yml#llm-key-configured": Object.freeze({
    issue: "#742",
    reason:
      "gates the two live-LLM jobs; push-to-main only for the same reason they are",
    repair:
      "covered by the same failure channel as e2e-live-transport; delete both together",
  }),
  "e2e.yml#e2e-llm": Object.freeze({
    issue: "#742",
    reason: "a real-LLM end-to-end run, push-to-main only for the same reason",
    repair:
      "covered by the same failure channel as e2e-live-transport; delete both together",
  }),
  "ci-measurement.yml": Object.freeze({
    issue: "#1097",
    reason:
      "measures the last N runs on main, which is meaningless on a pull request branch — and its " +
      "verdict does not reproduce after the fact, so a failure unseen is a failure unknowable",
    repair:
      "file-or-update an issue on failure, and capture the report as an artifact so a later " +
      "reader has something to read; then delete this entry",
  }),
});

/** Triggers declared by a workflow, from the `on:` block, comments and inline lists included. */
export function triggersOf(text) {
  const lines = text.split("\n");
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:on|"on"|'on'):(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline && !inline.startsWith("#")) {
      // `on: push` or `on: [push, pull_request]`
      for (const t of inline.replace(/[[\]]/g, "").split(","))
        if (t.trim()) out.add(t.trim());
      return out;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) break; // dedented to column 0: the block ended
      const key = /^\s{2}([A-Za-z_]+):/.exec(line);
      if (key) out.add(key[1]);
    }
    return out;
  }
  throw new Refusal("no `on:` block found");
}

/**
 * Does a step file or update an issue when the workflow fails?
 *
 * READ AS A STEP BLOCK RATHER THAN AS TWO SUBSTRINGS. A file containing `failure()` somewhere and
 * `gh issue` somewhere else satisfies a naive search while announcing nothing — the two have to be
 * in the same step for the second to run because of the first.
 */
export function declaresFailureConsumer(text) {
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++)
    if (/^\s*-\s+(name|uses|run|if):/.test(lines[i])) starts.push(i);
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(from, to).join("\n");
    const conditioned = /if:.*\b(failure|always)\s*\(\s*\)/.test(block);
    const files = /gh\s+issue\s+(create|comment|edit)/.test(block);
    if (conditioned && files) return true;
  }
  return false;
}

/**
 * THE JOBS OF A WORKFLOW, WITH THEIR `if:` CONDITIONS — because #742's subject is a JOB.
 *
 * A workflow-level check passes e2e.yml: it declares `pull_request`. But its
 * `e2e-live-transport` job is conditioned on `github.event_name == 'push'`, so it NEVER runs on a
 * pull request and has been red for 40+ runs where nobody looks. **A trigger on the workflow says
 * nothing about which jobs that trigger reaches.** Checking only the workflow would have passed
 * the exact case this gate was built to catch.
 */
export function jobsOf(text) {
  const lines = text.split("\n");
  const out = [];
  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^[a-zA-Z_"']/.test(lines[i])) inJobs = false;
    if (!inJobs) continue;
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!m) continue;
    let cond = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) break;
      const c = /^    if:\s*(.*)$/.exec(lines[j]);
      if (!c) continue;
      // block scalars (| and >-) carry the condition on the following indented lines
      if (/^[|>]/.test(c[1].trim()) || c[1].trim() === "") {
        const parts = [];
        for (let k = j + 1; k < lines.length && /^      /.test(lines[k]); k++)
          parts.push(lines[k].trim());
        cond = parts.join(" ");
      } else cond = c[1].trim();
      break;
    }
    out.push({ job: m[1], condition: cond });
  }
  return out;
}

/**
 * Can this job run on a pull request? `null` means the condition is a shape this cannot read,
 * which REFUSES rather than passing — an unrecognised guard is the case where a silent wrong
 * answer costs the most, and the closed set below covers every condition in this repository.
 */
export function runsOnPullRequest(condition) {
  if (condition === null) return true; // no condition: the workflow's triggers reach it
  const c = condition.replace(/\s+/g, " ");
  if (/github\.event_name\s*==\s*'pull_request'/.test(c)) return true;
  if (/github\.event_name\s*==\s*'push'/.test(c)) return false;
  return null;
}

export const VERDICT = {
  ATTENDED: "fires only when a person asks, so it cannot fail unseen",
  SURFACED: "surfaces on a pull request",
  CONSUMED: "declares a consumer for its failures",
  EXEMPT: "exempt, with a named repair",
  UNSURFACED: "CAN FAIL WHERE NOBODY LOOKS",
};

/**
 * A trigger that fires WITHOUT a person asking. `workflow_dispatch` is not one of them: somebody
 * pressed the button and is looking at the result, so a dispatch-only workflow cannot fail unseen
 * by construction. `schedule` and `push` can and do.
 *
 * THIS IS THE DISTINCTION THE CLASS TURNS ON, and getting it wrong in the other direction would
 * put visual-baselines.yml on a roster waiting for a repair it does not need.
 */
export const UNATTENDED = Object.freeze([
  "schedule",
  "push",
  "repository_dispatch",
  "workflow_run",
]);

/**
 * A job that its workflow's pull_request trigger cannot reach, so a workflow-level pass says
 * nothing about it. Returns one row per unreachable job.
 */
export function unreachableJobs(name, text, known = KNOWN_UNSURFACED) {
  const rows = [];
  for (const { job, condition } of jobsOf(text)) {
    const onPR = runsOnPullRequest(condition);
    if (onPR === null)
      throw new Refusal(
        `${name}: job \`${job}\` has an \`if:\` this cannot classify — ` +
          `${JSON.stringify(
            condition
          )}. Refusing rather than guessing whether a pull request ` +
          `reaches it; teach runsOnPullRequest the shape or simplify the condition`
      );
    if (onPR) continue;
    const key = `${name}#${job}`;
    rows.push({
      key,
      job,
      exempt: Boolean(known[key]),
      entry: known[key] ?? null,
    });
  }
  return rows;
}

export function classify(name, text, known = KNOWN_UNSURFACED) {
  const triggers = triggersOf(text);
  if (!UNATTENDED.some((t) => triggers.has(t)))
    return {
      verdict: VERDICT.ATTENDED,
      detail: `${[...triggers]
        .sort()
        .join(", ")} — fires only when a person asks`,
    };
  if (triggers.has("pull_request") || triggers.has("pull_request_target")) {
    const unreachable = unreachableJobs(name, text, known).filter(
      (j) => !j.exempt
    );
    if (unreachable.length)
      return {
        verdict: VERDICT.UNSURFACED,
        detail:
          `declares pull_request, but job(s) ${unreachable
            .map((j) => j.job)
            .join(", ")} are ` +
          `conditioned on push and no pull request reaches them. A trigger on the workflow says ` +
          `nothing about which jobs it reaches. REPAIR: give the job a failure channel, or add ` +
          `${unreachable
            .map((j) => j.key)
            .join(", ")} to KNOWN_UNSURFACED with a reason`,
      };
    return {
      verdict: VERDICT.SURFACED,
      detail: [...triggers].sort().join(", "),
    };
  }
  if (declaresFailureConsumer(text))
    return {
      verdict: VERDICT.CONSUMED,
      detail: [...triggers].sort().join(", "),
    };
  const entry = known[name];
  if (entry)
    return {
      verdict: VERDICT.EXEMPT,
      detail: `${entry.issue} — ${entry.repair}`,
    };
  return {
    verdict: VERDICT.UNSURFACED,
    detail:
      `triggers are ${
        [...triggers].sort().join(", ") || "(none)"
      } — no pull_request, and no step ` +
      `conditioned on failure() files or updates an issue. REPAIR: add a pull_request trigger if ` +
      `the job is short enough to be one, or add a failure step that files-or-updates an issue ` +
      `with the ambient GITHUB_TOKEN. If neither is possible yet, add an entry to ` +
      `KNOWN_UNSURFACED naming the reason and the repair`,
  };
}

/**
 * Exemptions naming a workflow OR A JOB that no longer exists, so the list cannot rot quietly.
 *
 * A job key is `file.yml#job`, and the job half matters as much as the file half: renaming a job
 * silently orphans its exemption, and an orphaned exemption is an assertion about something that
 * is not there. `jobsIn` maps each present file to its job names.
 */
export function staleExemptions(
  present,
  known = KNOWN_UNSURFACED,
  jobsIn = new Map()
) {
  return Object.keys(known).filter((k) => {
    const [file, job] = k.split("#");
    if (!present.has(file)) return true;
    if (job === undefined) return false;
    return !(jobsIn.get(file) ?? new Set()).has(job);
  });
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootArg = argv.indexOf("--root");
  const root =
    rootArg === -1 ? resolve(here, "..") : resolve(argv[rootArg + 1]);
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) throw new Refusal(`no .github/workflows under ${root}`);
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );
  if (files.length === 0)
    throw new Refusal(
      `${dir} holds no workflow files. A pass over nothing asserts nothing, and an empty ` +
        `directory is not a clean one`
    );

  const rows = files.sort().map((f) => {
    let r;
    try {
      r = classify(f, readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      if (e instanceof Refusal) throw new Refusal(`${f}: ${e.message}`);
      throw e;
    }
    return { file: f, ...r };
  });

  const jobsIn = new Map(
    files.map((f) => [
      f,
      new Set(jobsOf(readFileSync(join(dir, f), "utf8")).map((j) => j.job)),
    ])
  );
  const stale = staleExemptions(new Set(files), KNOWN_UNSURFACED, jobsIn);

  /*
   * JOB EXEMPTIONS ARE ANNOUNCED SEPARATELY, because their workflow reports SURFACED and would
   * otherwise swallow them. A roster entry nobody can see is the defect this gate exists to
   * prevent, and it would have been hiding three of them in its own output.
   */
  const jobExempt = files.flatMap((f) =>
    unreachableJobs(f, readFileSync(join(dir, f), "utf8"))
      .filter((j) => j.exempt)
      .map((j) => ({ key: j.key, entry: j.entry }))
  );
  const bad = rows.filter((r) => r.verdict === VERDICT.UNSURFACED);
  const exempt = rows.filter((r) => r.verdict === VERDICT.EXEMPT);

  reportSubject(rows.length, "workflow(s)");

  if (stale.length)
    throw new Refusal(
      `KNOWN_UNSURFACED names ${stale.join(", ")}, which ${
        stale.length === 1 ? "is" : "are"
      } not in ${dir} — the list asserts a premise that has expired, so its other entries cannot ` +
        `be trusted either. Delete the entr${stale.length === 1 ? "y" : "ies"}`
    );

  if (bad.length) {
    console.error(
      `FAIL: ${bad.length} of ${rows.length} workflow(s) can fail where nobody looks:\n`
    );
    for (const r of bad) console.error(`  ${r.file}\n    ${r.detail}\n`);
    return 1;
  }

  console.log(
    `OK: all ${rows.length} workflow(s) surface their failures somewhere a person looks.\n`
  );
  for (const r of rows) console.log(`  ${r.file.padEnd(24)} ${r.verdict}`);
  if (exempt.length || jobExempt.length) {
    console.log(
      `\n  ${
        exempt.length + jobExempt.length
      } exempt, which does not fail — each names the ` +
        `repair that retires it:`
    );
    for (const r of exempt) console.log(`    ${r.file}  ${r.detail}`);
    for (const j of jobExempt)
      console.log(`    ${j.key}  ${j.entry.issue} — ${j.entry.repair}`);
    console.log(
      `\n  SURFACED IS NOT ENFORCED: enforce_admins is false on this repository, so a failing\n` +
        `  required check does not stop a merge. This asserts that a failure is VISIBLE, which is\n` +
        `  the property that was missing, and claims nothing about it blocking anything.`
    );
  }
  return 0;
}

const invokedDirectly =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
