#!/usr/bin/env node
/**
 * Assert every LLM/graph invocation site in BOTH Python backends passes
 * `config=langfuse_config()`.
 *
 * WHY A STATIC CHECK AND NOT A UNIT TEST.
 * The Python side has no test harness (#80), and `pnpm` cannot see either
 * backend — they have no package.json. So the enforceable check available today
 * is a source assertion, and the thing most worth asserting is the one that
 * silently regresses: someone adds a seventh topology, calls `astream_events`
 * without `config=`, and `/health` keeps reporting the backend as traced while
 * that path emits nothing. Partial wiring reported as whole is the exact defect
 * #118 was opened to avoid.
 *
 * WHAT IT CANNOT DO, stated so nobody reads more into a green tick: it proves
 * the ARGUMENT IS PRESENT AT THE CALL SITE. It does not prove a span arrives —
 * that needs a live Langfuse, which scripts/langfuse-local/ provides and
 * README.md there records the observed result of.
 *
 * Closed by construction, the same way scripts/assert-dist-clean.sh is:
 *   * a missing source file is a HARD FAILURE, not "no sites found, all good"
 *   * finding ZERO sites is a HARD FAILURE — a check with no subject is vacuous
 *   * the expected site COUNT is pinned, so DELETING a wired site fails too
 * Proven by scripts/check-langfuse-wiring.selftest.mjs, which CI runs first.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Every module that invokes a model or a graph, per runtime.
const RUNTIMES = [
  "apps/fastapi-backend/ai_backends",
  "apps/django-backend/deepagents_backend/ai_backends",
];
const MODULES = ["deepagents.py", "langgraph.py", "langchain.py"];

// Sites that MUST carry `config=`, per module, with the expected count pinned
// so that DELETING a wired site fails as loudly as adding an unwired one.
//
// `.ainvoke(` inside a GRAPH NODE is deliberately excluded. langgraph.py's
// planner/executor/replanner calls sit inside the compiled graph and were
// OBSERVED to arrive as child observations of the parent trace against a live
// Langfuse — `fastapi-langgraph-plan-execute` came back with 13 nested
// observations including `planner`, `executor` and `replanner`. Requiring
// `config=` there would demand an argument the run already carries.
//
// langchain.py's planner is the opposite case and the reason this file exists:
// it is invoked OUTSIDE any graph, so it inherits nothing.
const SITES = {
  "deepagents.py": { pattern: /\.astream\s*\(/gm, expected: 1 },
  "langgraph.py": { pattern: /\.astream_events\s*\(/gm, expected: 2 },
  "langchain.py": {
    pattern: /\.astream_events\s*\(|planner\.ainvoke\s*\(/gm,
    expected: 2,
  },
};

/**
 * The two backends' `_common.py` must stay byte-identical from `def make_llm`
 * onward — that region holds langfuse_callbacks/langfuse_config/langfuse_probe
 * and observability_status. If they drift, ONE RUNTIME SILENTLY LOSES TRACING
 * while `/health` on the other keeps saying `tracing: true`, and nothing else
 * in this repo would notice. Same for the `langfuse` pin: a version present in
 * one requirements.txt and not the other is the same failure with a slower fuse.
 *
 * Note what this compares: the two artifacts AGAINST EACH OTHER, with the
 * required agreement region pinned here as a literal. It does not read an
 * expectation out of either file, because an expectation derived from the thing
 * it validates cannot fail when both sides move together.
 */
// LINE-ANCHORED AND PARENTHESISED, not a substring. `indexOf("def make_llm")`
// also matches `def make_llm_RENAMED(`, so a renamed anchor slid through and the
// comparison silently proceeded on a region that was no longer what it named.
// Caught by this file's own selftest.
const ANCHOR = "def make_llm(";
const ANCHOR_RE = /^def make_llm\(/m;
const COMMONS = [
  "apps/fastapi-backend/ai_backends/_common.py",
  "apps/django-backend/deepagents_backend/ai_backends/_common.py",
];
const REQUIREMENTS = [
  "apps/fastapi-backend/requirements.txt",
  "apps/django-backend/requirements.txt",
];

export function checkLockstep(root) {
  const problems = [];

  const shared = [];
  for (const f of COMMONS) {
    const path = join(root, f);
    if (!existsSync(path)) { problems.push(`MISSING SOURCE: ${f} — cannot compare lockstep`); continue; }
    const src = readFileSync(path, "utf8");
    const m = ANCHOR_RE.exec(src);
    const at = m ? m.index : -1;
    if (at === -1) {
      // Without this the slice would be empty in BOTH files and "identical"
      // would be vacuously true.
      problems.push(`${f}: anchor "${ANCHOR}" not found — the shared region cannot be located`);
      continue;
    }
    const region = src.slice(at);
    if (!region.includes("langfuse_callbacks")) {
      problems.push(`${f}: shared region does not contain langfuse_callbacks — comparing the wrong span`);
      continue;
    }
    shared.push([f, region]);
  }
  if (shared.length === COMMONS.length && shared[0][1] !== shared[1][1]) {
    problems.push(
      `${shared[0][0]} and ${shared[1][0]} have DRIFTED from "${ANCHOR}" onward. ` +
        `One runtime would trace and the other would not, while both report the same status.`
    );
  } else if (shared.length !== COMMONS.length) {
    problems.push("lockstep comparison ran with fewer than two readable files — it proved nothing");
  }

  const pins = [];
  for (const f of REQUIREMENTS) {
    const path = join(root, f);
    if (!existsSync(path)) { problems.push(`MISSING SOURCE: ${f}`); continue; }
    const line = readFileSync(path, "utf8").split("\n").find((l) => /^langfuse\b/.test(l.trim()));
    if (!line) {
      // Absent in BOTH would otherwise "match".
      problems.push(`${f}: declares no langfuse requirement — the backend cannot trace`);
      continue;
    }
    pins.push([f, line.trim()]);
  }
  if (pins.length === REQUIREMENTS.length && pins[0][1] !== pins[1][1]) {
    problems.push(`langfuse pin differs: ${pins[0][0]} has "${pins[0][1]}", ${pins[1][0]} has "${pins[1][1]}"`);
  } else if (pins.length !== REQUIREMENTS.length) {
    problems.push("langfuse pin comparison ran with fewer than two files — it proved nothing");
  }

  return problems;
}

/**
 * The local fixture must carry NO secret-shaped literal.
 *
 * A committed 64-hex ENCRYPTION_KEY turned secret scanning red on EVERY open PR
 * in this repo — security.yml uses fetch-depth 0 and `gitleaks detect --source .`
 * scans the whole object graph, not the PR diff, so one such string on any branch
 * blocks all of them. It was a throwaway value for an ephemeral container, and it
 * still cost the whole board, because a high-entropy literal is indistinguishable
 * from a real key by construction.
 *
 * This asserts the shape, not the value: no long hex/base64 run in the fixture.
 * The deliberately LOW-entropy labelled values (pk-lf-local-dev-public, the salt)
 * are what make the trace proof reproducible and are meant to stay.
 */
const FIXTURE = [
  "scripts/langfuse-local/docker-compose.yml",
  "scripts/langfuse-local/backend-override.yml",
];
const SECRET_SHAPED = /[0-9a-fA-F]{40,}|[A-Za-z0-9+/]{60,}={0,2}/;

export function checkNoSecretLiterals(root) {
  const problems = [];
  let scanned = 0;
  for (const f of FIXTURE) {
    const path = join(root, f);
    if (!existsSync(path)) { problems.push(`MISSING FIXTURE FILE: ${f}`); continue; }
    scanned++;
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (SECRET_SHAPED.test(line)) {
        problems.push(
          `${f}:${i + 1} contains a secret-shaped literal. Generate it into a ` +
            `gitignored .env via up.sh instead — a committed one fails gitleaks on every PR.`
        );
      }
    });
  }
  if (scanned === 0) problems.push("ZERO fixture files scanned for secrets — vacuous.");
  return problems;
}

export function checkWiring(root) {
  const problems = [];
  let checked = 0;

  for (const rt of RUNTIMES) {
    for (const mod of MODULES) {
      const path = join(root, rt, mod);
      if (!existsSync(path)) {
        problems.push(`MISSING SOURCE: ${rt}/${mod} — cannot confirm its wiring`);
        continue;
      }
      const src = readFileSync(path, "utf8");
      // A site is "wired" if `config=langfuse_config()` appears within the
      // call's argument list. Calls here span lines, so scan the whole call.
      const { pattern, expected } = SITES[mod];
      const found = [...src.matchAll(pattern)];
      if (found.length !== expected) {
        problems.push(
          `${rt}/${mod}: found ${found.length} invocation site(s), expected ${expected}. ` +
            `If a site was added or removed, update SITES deliberately.`
        );
      }
      for (const m of found) {
        const start = m.index;
        // Take the balanced call text so a `config=` belonging to a LATER call
        // cannot be miscredited to this one.
        let depth = 0, end = start, seen = false;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "(") { depth++; seen = true; }
          else if (src[i] === ")") { depth--; if (seen && depth === 0) { end = i; break; } }
        }
        const call = src.slice(start, end + 1);
        checked++;
        if (!/config\s*=\s*langfuse_config\(\)/.test(call)) {
          const line = src.slice(0, start).split("\n").length;
          problems.push(
            `${rt}/${mod}:${line} — invocation site does NOT pass config=langfuse_config(). ` +
              `This path would run untraced while /health reports the backend as traced.`
          );
        }
      }
    }
  }

  if (checked === 0) {
    problems.push(
      "ZERO invocation sites were checked. A check with no subject cannot fail " +
        "and must not report success."
    );
  }
  return { problems, checked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] || process.cwd();
  const { problems, checked } = checkWiring(root);
  const lockstep = checkLockstep(root);
  const secrets = checkNoSecretLiterals(root);
  const all = [...problems, ...lockstep, ...secrets];
  for (const p of all) console.error(`FAIL: ${p}`);
  if (all.length) process.exit(1);
  console.log(`PASS: all ${checked} invocation sites pass config=langfuse_config().`);
  console.log(`PASS: both _common.py agree from "${ANCHOR}" onward, and both requirements pin langfuse identically.`);
  console.log("PASS: the local fixture carries no secret-shaped literal.");
}
