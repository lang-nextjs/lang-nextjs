#!/usr/bin/env node
/**
 * Both runtimes record what a run IS, identically (#118, #171).
 *
 * `set_run_axes` / `langfuse_trace_metadata` decide the tags and the session on
 * every trace. The fastapi plane has had them since #118; the django plane had
 * NEITHER, so every django trace arrived untagged and unsessioned while its
 * fastapi twin was filterable. "Compare the same framework across two runtimes"
 * — the comparison this repo exists to make — silently covered half the fleet,
 * and the half it covered was the one anyone looking would check first.
 *
 * WHY A SOURCE CHECK. The django backend has no test harness and `pnpm` cannot
 * see it — it has no package.json. scripts/check-langfuse-wiring.mjs works
 * around the same constraint the same way, and says so. The fastapi behaviour
 * IS unit-tested (tests/test_run_session.py); what this adds is that the other
 * plane cannot quietly diverge from the plane those tests cover.
 *
 * IDENTICAL, NOT MERELY PRESENT. Two implementations that both exist and differ
 * is the failure mode that produced #232, #247/#302 and the subagent reporting
 * fix — each had to be made twice, and each was found only when someone
 * compared. Byte equality is the only version of "the same" that cannot drift.
 *
 * Closed by construction:
 *   * a missing source file is a HARD FAILURE, not "nothing to compare"
 *   * a missing function is a HARD FAILURE, not a skipped comparison
 *   * finding ZERO functions to compare is a HARD FAILURE — a check with no
 *     subject is vacuous, and reads as coverage
 * Proven by scripts/check-run-axes-parity.selftest.mjs, which CI runs first.
 */
import { readFileSync, existsSync } from "node:fs";

const PLANES = {
  fastapi: "apps/fastapi-backend/ai_backends/_common.py",
  django: "apps/django-backend/deepagents_backend/ai_backends/_common.py",
};

// Dispatches that must record the axes, including the session.
const DISPATCH = {
  fastapi: "apps/fastapi-backend/main.py",
  django: "apps/django-backend/deepagents_backend/views.py",
};

const SHARED = ["set_run_axes", "langfuse_trace_metadata"];

const failures = [];

/** The body of a top-level `def name(...)` including its docstring, up to the
 *  next top-level statement. Whitespace-normalised only at the edges. */
function extractDef(src, name) {
  const start = src.indexOf(`def ${name}(`);
  if (start === -1) return null;
  const rest = src.slice(start);
  // The next line that begins at column 0 and is not a continuation ends it.
  const lines = rest.split("\n");
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length && !/^\s/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trimEnd();
}

const sources = {};
for (const [plane, path] of Object.entries(PLANES)) {
  if (!existsSync(path)) {
    console.error(`FAIL: ${plane}'s _common.py is missing at ${path}.`);
    console.error("A comparison with an absent side is not a passing comparison.");
    process.exit(2);
  }
  sources[plane] = readFileSync(path, "utf8");
}

let compared = 0;
for (const fn of SHARED) {
  const bodies = {};
  for (const [plane, src] of Object.entries(sources)) {
    const body = extractDef(src, fn);
    if (body === null) {
      failures.push(
        `${plane} does not define ${fn}(). Every trace from that runtime is ` +
          `missing whatever it records — untagged, unsessioned, and invisible ` +
          `to the filters the other plane's traces answer.`
      );
      continue;
    }
    bodies[plane] = body;
  }
  if (Object.keys(bodies).length < 2) continue;
  compared++;
  const [[aName, a], [bName, b]] = Object.entries(bodies);
  if (a !== b) {
    failures.push(
      `${fn}() DIFFERS between ${aName} and ${bName}. Two implementations that ` +
        `both exist and disagree is the shape that produced #232 and #247/#302 — ` +
        `found only because someone compared.`
    );
  }
}

// Both dispatches must actually record a session, or the parity above is a
// parity of two things nobody calls.
for (const [plane, path] of Object.entries(DISPATCH)) {
  if (!existsSync(path)) {
    console.error(`FAIL: ${plane}'s dispatch is missing at ${path}.`);
    process.exit(2);
  }
  const src = readFileSync(path, "utf8");
  const call = src.match(/set_run_axes\(([\s\S]{0,400}?)\)/);
  if (!call) {
    failures.push(
      `${plane}'s dispatch (${path}) never calls set_run_axes(). The functions ` +
        `can be identical and still record nothing.`
    );
    continue;
  }
  compared++;
  if (!/session\s*=/.test(call[1])) {
    failures.push(
      `${plane}'s set_run_axes() call omits session=. #171: without it a ` +
        `conversation's turns arrive as unrelated traces, which is what the ` +
        `whole client/route/backend chain was fixed to prevent.`
    );
  }
}

if (compared === 0) {
  console.error("REFUSING TO PASS: compared 0 functions and 0 dispatches.");
  console.error("A check with no subject is vacuous, and its green reads as coverage.");
  process.exit(2);
}

if (failures.length) {
  console.error("FAIL — the two runtimes do not record runs identically:\n");
  for (const f of failures) console.error("  " + f + "\n");
  process.exit(1);
}

console.log(
  `PASS: ${SHARED.length} shared functions are byte-identical across both ` +
    `runtimes, and both dispatches record a session (${compared} comparisons).`
);
