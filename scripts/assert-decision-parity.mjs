#!/usr/bin/env node
/**
 * Both planes' suites DRIVE the same decision vocabulary (#668).
 *
 * ── THE RULING THIS ENFORCES, so it lives where someone hits it ──────────────
 *
 * check-run-axes-parity holds the two Python planes' SOURCE identical: every
 * top-level def in `_common.py`, each rung's `stream_chat_react`, and each rung's
 * `GATED_TOPOLOGIES`. That is its whole guarantee and it is SOURCE-ONLY.
 *
 *   Behaviour that flows through code parity does NOT hold identical must be
 *   asserted on BOTH planes. Behaviour entirely within code it DOES hold
 *   identical may be proven once, and the identity is what carries it.
 *
 * The discriminator is not "is this behaviour important" — everyone answers yes.
 * It is "does parity compare the code this behaviour traverses", which anyone can
 * check. Measured: `main.py` is 379 lines and `views.py` is 213, and parity reads
 * them only for a PROPERTY (do they call `set_run_axes` with `session=`), never
 * for identity. Identity there is not merely absent, it is impossible — one is
 * FastAPI and one is Django.
 *
 * The approval decision path — parse the decisions, refuse a lost thread, re-enter
 * with `Command(resume=...)` — runs through those two files. So decision tests
 * establish properties of code parity says nothing about, and proving them once
 * was never covered by the identity argument. That is why a one-plane vocabulary
 * could sit here unnoticed: nobody was wrong, the guarantee just never reached it.
 *
 * WHAT THIS DOES NOT CLAIM. Running a behaviour twice is not proof. Two identical
 * suites both pass on a shared defect. Source identity catches drift and not
 * wrongness; dual coverage catches plane-specific breakage and not shared
 * breakage. Neither is proof and the pair is not proof either. This is about
 * which gap each closes.
 *
 * ── WHY IT READS PAYLOADS AND NOT TEXT ───────────────────────────────────────
 *
 * The cheap version greps for decision-type strings, and passes on a suite that
 * NAMES all four in a docstring and SENDS none — which is the failure this whole
 * area keeps producing, and it would be this checker's own version of it.
 *
 * So the subject is anchored structurally. A "resume helper" is a function whose
 * body puts one of its own PARAMETERS into the `approvalDecisions` wire field;
 * the driven set is the `"type"` values in the literal passed at that parameter's
 * position. A docstring cannot appear inside a call's argument list, and a wire
 * fixture like `{"type": "text-delta"}` never reaches `approvalDecisions`, so
 * neither can be mistaken for a decision that was sent.
 *
 * AN ARGUMENT IT CANNOT READ IS A REFUSAL, NOT A ZERO. If a call passes a
 * variable rather than a literal, the set computed here is not the set driven,
 * and reporting it would be a verdict about a question this could not answer.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { extractConst } from "./lib/python-const.mjs";

const ROOT = process.cwd();

const PLANES = {
  fastapi: {
    tests: "apps/fastapi-backend/tests",
    common: "apps/fastapi-backend/ai_backends/_common.py",
  },
  django: {
    tests: "apps/django-backend/tests",
    common: "apps/django-backend/deepagents_backend/ai_backends/_common.py",
  },
};

/** The wire field a decision payload must reach to count as driven. */
const WIRE_FIELD = "approvalDecisions";

/** Read the span of a bracketed expression starting at `from`, balanced. */
function balancedFrom(src, from) {
  const opens = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  let out = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    out += ch;
    if (opens[ch]) stack.push(opens[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return out;
    }
  }
  return null; // unbalanced to end of file
}

/** Split a call's argument span on top-level commas. */
function splitArgs(span) {
  const inner = span.slice(1, -1);
  const parts = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (const ch of inner) {
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
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

/**
 * Functions that put one of their parameters into the wire field, with the
 * INDEX of that parameter — django's helper takes it first, fastapi's second, so
 * position cannot be assumed.
 */
function resumeHelpers(src) {
  const found = [];
  const defRe = /^def\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  for (const m of src.matchAll(defRe)) {
    const [, name, params] = m;
    const names = params
      .split(",")
      .map((p) => p.trim().split(/[:=]/)[0].trim())
      .filter(Boolean);
    // The body runs to the next top-level def.
    const rest = src.slice(m.index + m[0].length);
    const nextDef = rest.search(/^def\s+\w+\s*\(/m);
    const body = nextDef === -1 ? rest : rest.slice(0, nextDef);
    const wire = body.match(new RegExp(`["']${WIRE_FIELD}["']\\s*:\\s*(\\w+)`));
    if (!wire) continue;
    const idx = names.indexOf(wire[1]);
    if (idx === -1) continue; // assigns something that is not a parameter
    found.push({ name, index: idx });
  }
  return found;
}

const problems = [];
const unreadable = [];
const driven = {};
const examined = [];

let vocabulary = null;

for (const [plane, paths] of Object.entries(PLANES)) {
  const testsDir = join(ROOT, paths.tests);
  if (!existsSync(testsDir)) continue; // an ejected fork legitimately lacks a plane
  examined.push(plane);

  if (vocabulary === null && existsSync(join(ROOT, paths.common))) {
    const raw = extractConst(
      readFileSync(join(ROOT, paths.common), "utf-8"),
      "_DECISION_TYPES"
    );
    if (raw)
      vocabulary = new Set(
        [...raw.matchAll(/["']([a-z]+)["']/g)].map((m) => m[1])
      );
  }

  const files = readdirSync(testsDir).filter(
    (f) => f.startsWith("test_") && f.endsWith(".py")
  );
  const seen = new Set();
  const other = new Set();
  let helperCount = 0;

  for (const file of files) {
    const src = readFileSync(join(testsDir, file), "utf-8");
    const helpers = resumeHelpers(src);
    helperCount += helpers.length;

    for (const { name, index } of helpers) {
      const callRe = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
      for (const call of src.matchAll(callRe)) {
        const open = call.index + call[0].length - 1;
        // Its own definition is not a call site.
        if (/def\s+$/.test(src.slice(Math.max(0, call.index - 5), call.index)))
          continue;
        const span = balancedFrom(src, open);
        if (span === null) {
          unreadable.push(`${plane}/${file}: a call to ${name}( is unbalanced`);
          continue;
        }
        const args = splitArgs(span);
        const arg = args[index];
        if (arg === undefined) continue; // called with fewer args; not a decision send
        if (!arg.includes("{")) {
          unreadable.push(
            `${plane}/${paths.tests}/${file} passes \`${arg}\` to ${name}() rather than a ` +
              `literal, so the set driven here cannot be read from source`
          );
          continue;
        }
        for (const t of arg.matchAll(/["']type["']\s*:\s*["']([a-z-]+)["']/g)) {
          (vocabulary && vocabulary.has(t[1]) ? seen : other).add(t[1]);
        }
      }
    }
  }

  if (files.length > 0 && helperCount === 0) {
    problems.push(
      `${plane} has ${files.length} test file(s) and NO function that puts a parameter ` +
        `into "${WIRE_FIELD}". Either this plane drives no decisions at all — which is ` +
        `#668 — or the helper was renamed and this check lost its subject.`
    );
  }
  driven[plane] = { decisions: seen, other };
}

/*
 * REFUSALS FIRST. A set computed from source that could not read every call is
 * not the set driven, and a verdict from it would be a claim about a question
 * this could not answer.
 */
if (unreadable.length) {
  console.error(
    "REFUSING TO REPORT: some decision payloads are not readable from source:\n"
  );
  for (const u of unreadable) console.error("  " + u + "\n");
  process.exit(2);
}
if (examined.length === 0) {
  console.log("PASS: no Python test plane in this tree — nothing to compare.");
  process.exit(0);
}
if (vocabulary === null || vocabulary.size === 0) {
  console.error(
    "REFUSING TO REPORT: _DECISION_TYPES could not be read, so every set below " +
      "would be empty and this would pass by comparing nothing to nothing."
  );
  process.exit(2);
}

if (examined.length === 1) {
  const only = examined[0];
  console.log(
    `PASS: only the ${only} plane is present (ejected fork) — it drives ` +
      `[${[...driven[only].decisions].sort()}]. Nothing to compare against.`
  );
  process.exit(problems.length ? 1 : 0);
}

const [a, b] = examined;
const setA = driven[a].decisions;
const setB = driven[b].decisions;
for (const [x, y, sx, sy] of [
  [a, b, setA, setB],
  [b, a, setB, setA],
]) {
  const missing = [...sy].filter((d) => !sx.has(d)).sort();
  if (missing.length) {
    problems.push(
      `${x} does not drive [${missing}] — ${y} does. The decision path runs through ` +
        `main.py/views.py, which check-run-axes-parity does not compare and cannot: ` +
        `a behaviour asserted only on ${y} says nothing about ${x}. Add the case to ` +
        `${PLANES[x].tests}/, or argue on #668 that this decision is plane-specific.`
    );
  }
}

if (problems.length) {
  console.error(
    `FAIL: the two planes do not drive the same decision vocabulary:\n`
  );
  for (const p of problems) console.error("  " + p + "\n");
  process.exit(1);
}

const shared = [...setA].sort();
console.log(
  `PASS: both planes drive the same ${shared.length} decision type(s) — [${shared}] — ` +
    `read from the literals passed to their "${WIRE_FIELD}" helpers, not from text ` +
    `mentioning them.`
);
const extras = new Set([...driven[a].other, ...driven[b].other]);
if (extras.size) {
  console.log(
    `\nNOT COMPARED: [${[
      ...extras,
    ].sort()}] appear in resume payloads and are not in ` +
      `_DECISION_TYPES — refusal probes rather than vocabulary. A plane probing a ` +
      `different bogus type is not a coverage gap, so they are reported and not diffed.`
  );
}
