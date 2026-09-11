#!/usr/bin/env node
/**
 * Assert every LLM/graph invocation site in BOTH Python backends passes
 * `config=langfuse_config()`, and that the two backends' `_common.py` do not
 * drift — from `def make_llm(` onward by code comparison, and in their PROMPT
 * CONSTANTS, which sit above that anchor and were invisible here until they had
 * already drifted once.
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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
import { blankComments } from "./lib/blank-comments.mjs";

/*
 * REFUSED, NOT CRASHED. The JS half of this file's exemption evidence is now
 * parsed; the PYTHON half keeps its own character scanner below, which needs no
 * compiler and is the right reader for that language.
 */
let ts;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  console.error(
    "REFUSE: typescript could not be imported, so the JS exemption evidence was " +
      `not parsed. Run \`pnpm install\`.\n       ${e.message}`
  );
  process.exit(2);
}
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
/**
 * Blank out Python comments and string literals, PRESERVING LENGTH AND NEWLINES
 * so every byte offset and line number computed against the result still refers
 * to the same place in the original file.
 *
 * WHY THIS EXISTS. The site patterns below are regexes over source text, and a
 * regex cannot tell code from prose. `langchain.py` gained an explanatory
 * comment containing the words `planner.ainvoke(...)` — describing, correctly,
 * why the planner is invoked rather than streamed — and the checker counted the
 * SENTENCE as a third invocation site, then reported that site as untraced. A
 * comment explaining that a path IS traced was read as evidence that it is not.
 *
 * The inverse is the dangerous direction and this closes it too: a comment
 * mentioning `config=langfuse_config()` anywhere inside a call's parentheses
 * would have made a genuinely UNWIRED site look wired. That is this checker's
 * own failure mode — reporting a verdict it never computed — so both directions
 * are asserted in the selftest rather than left to inspection.
 */
export function maskPythonNonCode(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const close = src.indexOf(triple, i + 3);
        const end = close === -1 ? n : close + 3;
        blank(i, end);
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === "\n") break;
        j++;
      }
      const end = j < n && src[j] === c ? j + 1 : j;
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

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

/**
 * The shared region with PROSE REMOVED — full-line `#` comments and
 * triple-quoted docstrings.
 *
 * WHY NOT BYTE EQUALITY. The claim this comparison makes is behavioural: "one
 * runtime would trace and the other would not". A comment cannot cause that.
 * Comparing prose made the check demand that the two planes describe their own
 * history identically — but #247 and #302 fixed the same defect separately, and
 * django's note correctly says "this plane is a separate implementation and
 * kept the defect", which is true of django and false of fastapi.
 *
 * So the check was unsatisfiable by any tree that documented itself accurately,
 * and it had been failing on main. A check nobody can make green is a check
 * that gets unwired, which is exactly what had happened to this one.
 *
 * Renames, added or deleted calls, and changed arguments all survive this
 * stripping — the selftest's drift case renames a function and is still caught.
 */
export function codeOnly(region) {
  return region
    .replace(/"""[\s\S]*?"""/g, "DOCSTRING")
    .replace(/'''[\s\S]*?'''/g, "DOCSTRING")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.trimEnd())
    .filter((l) => l.length)
    .join("\n");
}

export function checkLockstep(root) {
  const problems = [];

  const shared = [];
  for (const f of COMMONS) {
    const path = join(root, f);
    if (!existsSync(path)) {
      problems.push(`MISSING SOURCE: ${f} — cannot compare lockstep`);
      continue;
    }
    const src = readFileSync(path, "utf8");
    const m = ANCHOR_RE.exec(src);
    const at = m ? m.index : -1;
    if (at === -1) {
      // Without this the slice would be empty in BOTH files and "identical"
      // would be vacuously true.
      problems.push(
        `${f}: anchor "${ANCHOR}" not found — the shared region cannot be located`
      );
      continue;
    }
    const region = src.slice(at);
    if (!region.includes("langfuse_callbacks")) {
      problems.push(
        `${f}: shared region does not contain langfuse_callbacks — comparing the wrong span`
      );
      continue;
    }
    shared.push([f, region]);
  }
  if (
    shared.length === COMMONS.length &&
    codeOnly(shared[0][1]) !== codeOnly(shared[1][1])
  ) {
    problems.push(
      `${shared[0][0]} and ${shared[1][0]} have DRIFTED from "${ANCHOR}" onward. ` +
        `One runtime would trace and the other would not, while both report the same status.`
    );
  } else if (shared.length !== COMMONS.length) {
    problems.push(
      "lockstep comparison ran with fewer than two readable files — it proved nothing"
    );
  }

  const pins = [];
  for (const f of REQUIREMENTS) {
    const path = join(root, f);
    if (!existsSync(path)) {
      problems.push(`MISSING SOURCE: ${f}`);
      continue;
    }
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => /^langfuse\b/.test(l.trim()));
    if (!line) {
      // Absent in BOTH would otherwise "match".
      problems.push(
        `${f}: declares no langfuse requirement — the backend cannot trace`
      );
      continue;
    }
    pins.push([f, line.trim()]);
  }
  if (pins.length === REQUIREMENTS.length && pins[0][1] !== pins[1][1]) {
    problems.push(
      `langfuse pin differs: ${pins[0][0]} has "${pins[0][1]}", ${pins[1][0]} has "${pins[1][1]}"`
    );
  } else if (pins.length !== REQUIREMENTS.length) {
    problems.push(
      "langfuse pin comparison ran with fewer than two files — it proved nothing"
    );
  }

  return problems;
}

/**
 * THE PROMPTS ARE BEHAVIOUR, AND THE COMPARISON ABOVE CANNOT SEE THEM.
 *
 * `checkLockstep` compares the two `_common.py` from `def make_llm(` onward.
 * Both prompt constants are assigned ABOVE that anchor — RESEARCH_PROMPT and
 * SYSTEM_PROMPT at lines 87 and 95 in fastapi, 93 and 101 in django, against
 * `def make_llm(` at 104 and 110. So the span this file calls "the shared
 * region" has never included the instructions the agent is actually given.
 *
 * MEASURED, NOT SUPPOSED. A one-line SYSTEM_PROMPT repair was applied to the
 * fastapi copy alone and this checker stayed green; the drift was found by
 * reading the two files side by side, and parity was restored by hand. By hand
 * is the defect: the pair is held identical by a check for one half of their
 * content and by someone remembering for the other.
 *
 * WHY A SEPARATE COMPARISON RATHER THAN A HIGHER ANCHOR — and this is the trap
 * worth naming, because moving the anchor is the obvious repair and it produces
 * a check that CANNOT FAIL. `codeOnly()` rewrites every triple-quoted string to
 * the token DOCSTRING, deliberately, so the two planes may describe their own
 * history differently. Sliding the anchor above the prompts would compare
 * `SYSTEM_PROMPT = DOCSTRING` with `SYSTEM_PROMPT = DOCSTRING` and report
 * agreement for any two prompts in the world. These literals are the opposite
 * of prose — they are shipped to the model — so they are compared AS WRITTEN,
 * delimiters included, with nothing stripped.
 *
 * THE PINNED SET IS THE DURABLE HALF. Comparing only the two names below would
 * not have caught what actually went wrong, which is that nobody knew a
 * constant needed comparing. So the names are pinned HERE, and each file's own
 * set of `*_PROMPT` assignments must EQUAL that set — a third prompt added to
 * both backends fails until it is registered, instead of quietly inheriting the
 * blind spot SYSTEM_PROMPT is leaving.
 */
const PROMPTS = ["RESEARCH_PROMPT", "SYSTEM_PROMPT"];
const PROMPT_DECL_RE = /^([A-Z][A-Z0-9_]*_PROMPT)\s*=/gm;

/**
 * The Python string literal beginning at `from`, AS WRITTEN, delimiters
 * included — or null if what starts there is not one.
 *
 * Returning null rather than a best guess is the same seam `blankComments` uses:
 * a caller must be able to tell "no literal here" from "an empty literal", or an
 * unparsed assignment reads exactly like a matching one.
 */
export function pythonLiteralAt(src, from) {
  let i = from;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  const c = src[i];
  if (c !== '"' && c !== "'") return null;
  const triple = src.slice(i, i + 3);
  if (triple === '"""' || triple === "'''") {
    const close = src.indexOf(triple, i + 3);
    return close === -1 ? null : src.slice(i, close + 3);
  }
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === c) return src.slice(i, j + 1);
    if (src[j] === "\n") return null;
  }
  return null;
}

/**
 * Every module-level `*_PROMPT` name assigned in `src`.
 *
 * Read from the MASKED source, so a name written inside a comment or inside
 * another prompt's text is not discovered — the same direction of error that
 * made this checker once count a sentence as an invocation site.
 */
export function declaredPromptNames(src) {
  const masked = maskPythonNonCode(src);
  const names = new Set();
  for (const m of masked.matchAll(PROMPT_DECL_RE)) names.add(m[1]);
  return names;
}

/** The literal assigned to `name` at module level, or null. */
export function promptLiteral(src, name) {
  const masked = maskPythonNonCode(src);
  const m = new RegExp(`^${name}\\s*=`, "m").exec(masked);
  return m === null ? null : pythonLiteralAt(src, m.index + m[0].length);
}

/**
 * Closed the same way as everything else here: a missing file, a missing
 * constant, and an empty subject are FAILURES, never a silent match. Two files
 * that both lack SYSTEM_PROMPT are not two files that agree about it.
 */
export function checkPromptParity(root) {
  const problems = [];

  if (PROMPTS.length === 0) {
    return ["no prompt constants are pinned — this comparison has no subject"];
  }

  const sources = [];
  for (const f of COMMONS) {
    const path = join(root, f);
    if (!existsSync(path)) {
      problems.push(`MISSING SOURCE: ${f} — cannot compare prompts`);
      continue;
    }
    sources.push([f, readFileSync(path, "utf8")]);
  }
  if (sources.length !== COMMONS.length) {
    problems.push(
      "prompt comparison ran with fewer than two readable files — it proved nothing"
    );
    return problems;
  }

  // REGISTRATION, not just equality. An unregistered prompt is the blind spot
  // itself, so it fails here rather than in six months.
  const pinned = new Set(PROMPTS);
  for (const [f, src] of sources) {
    const found = declaredPromptNames(src);
    for (const name of found) {
      if (!pinned.has(name)) {
        problems.push(
          `${f}: ${name} is assigned but not pinned in PROMPTS — it would not be ` +
            `compared between the backends, which is exactly how SYSTEM_PROMPT drifted. ` +
            `Add it to PROMPTS in ${"scripts/check-langfuse-wiring.mjs"}.`
        );
      }
    }
    for (const name of pinned) {
      if (!found.has(name)) {
        problems.push(
          `${f}: PROMPTS pins ${name}, but no module-level assignment of it was found — ` +
            `renamed or deleted. The pin is the record of what must agree; update both.`
        );
      }
    }
  }
  if (problems.length) return problems;

  let compared = 0;
  for (const name of pinned) {
    const literals = [];
    for (const [f, src] of sources) {
      const lit = promptLiteral(src, name);
      if (lit === null) {
        problems.push(
          `${f}: ${name} is assigned something this reader cannot parse as a string ` +
            `literal, so its text was never compared`
        );
        continue;
      }
      literals.push([f, lit]);
    }
    if (literals.length !== sources.length) continue;
    compared++;
    if (literals[0][1] !== literals[1][1]) {
      /*
       * NAME THE FIRST DIFFERING LINE. These literals run to a dozen lines and a
       * bare "they differ" sends the reader to diff two files by eye — which is
       * the manual step this check exists to remove.
       */
      const a = literals[0][1].split("\n");
      const b = literals[1][1].split("\n");
      let k = 0;
      while (k < a.length && k < b.length && a[k] === b[k]) k++;
      problems.push(
        `${name} DIFFERS between the backends — one agent is instructed differently ` +
          `from the other while both report the same topology.\n` +
          `       first difference at line ${k + 1} of the literal:\n` +
          `         ${literals[0][0]}\n           ${JSON.stringify(
            a[k] ?? "(ends)"
          )}\n` +
          `         ${literals[1][0]}\n           ${JSON.stringify(
            b[k] ?? "(ends)"
          )}`
      );
    }
  }

  if (compared === 0 && problems.length === 0) {
    problems.push(
      "prompt comparison compared nothing — a pass over no literals is vacuous"
    );
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
    if (!existsSync(path)) {
      problems.push(`MISSING FIXTURE FILE: ${f}`);
      continue;
    }
    scanned++;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (SECRET_SHAPED.test(line)) {
          problems.push(
            `${f}:${
              i + 1
            } contains a secret-shaped literal. Generate it into a ` +
              `gitignored .env via up.sh instead — a committed one fails gitleaks on every PR.`
          );
        }
      });
  }
  if (scanned === 0)
    problems.push("ZERO fixture files scanned for secrets — vacuous.");
  return problems;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE SUBJECT IS ASSERTED, NOT ASSUMED (#602).
 *
 * RUNTIMES, MODULES and SITES are literals, and that is right: each carries a reason a glob
 * could not — `.ainvoke(` inside a graph node is excluded because it was OBSERVED arriving as a
 * child observation, and no enumeration can know that. What was missing is not derivation, it
 * is a guard that the literals still COVER THE WORLD.
 *
 * Measured before writing this: adding apps/fastapi-backend/ai_backends/newrung.py with an
 * UNCONFIGURED `.astream_events(` — exactly the shape a new rung's dispatch takes — left this
 * checker's output BYTE-IDENTICAL, still reporting "all 10 invocation sites pass". Its verdict
 * was never "langfuse is wired"; it was "the sites I was told about are wired".
 *
 * So the population is derived and the rule stays literal, which is the shape
 * assert-readme-quickstart already uses: a listed subject plus a totality check against the
 * enumerated world, so every entry keeps its reason AND nothing can be silently outside.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every backend plane the MANIFEST declares, as runtime id -> adapter directory.
 *
 * rungs.json's `runtimes` keys are the authoritative answer to "what is a plane" — and the
 * important part is what they EXCLUDE. Enumerating `apps/*` would demand a plane entry for
 * apps/example, apps/open-swe and the two framework ports, none of which serve a rung; the
 * manifest names django, fastapi and node, which is three and only three. The directory comes
 * from `topologiesSource`, so a plane that moves is followed rather than re-listed here.
 */
export function declaredPlanes(root) {
  const manifest = JSON.parse(readFileSync(join(root, "rungs.json"), "utf8"));
  const dirs = new Map();
  for (const rung of manifest.rungs ?? []) {
    for (const [id, cfg] of Object.entries(rung.runtimes ?? {})) {
      const src = cfg?.topologiesSource;
      if (!src) continue;
      if (!dirs.has(id)) dirs.set(id, src.slice(0, src.lastIndexOf("/")));
    }
  }
  return dirs;
}

/**
 * Planes this file's rule does NOT apply to, with the reason, and the reason is re-checked.
 *
 * NOT A MUTE BUTTON, and the test is whether the entry has a one-line repair. This one does
 * not: `config=langfuse_config()` is a Python idiom, and the node runtime ATTACHES NO LANGFUSE
 * HANDLER AT ALL — it says so itself, in code, at src/common/observability.ts:
 *
 *     langfuse: { supported: false, ... "the node runtime attaches no Langfuse callback
 *                 handler yet; keys in the environment change nothing here." }
 *
 * That declaration is the exemption's evidence, so the exemption is verified against the tree
 * rather than asserted here. The day node declares `supported: true` while remaining outside
 * this checker, the entry goes stale and this fails — which is the only kind of exception list
 * worth having.
 */
const PLANES_NOT_CHECKED = {
  node: {
    why:
      "declares `langfuse: { supported: false }` in src/common/observability.ts — it attaches " +
      "no Langfuse handler, so there is no `config=langfuse_config()` to require",
    evidence: "apps/node-backend/src/common/observability.ts",
    /*
     * Comments stripped FIRST, and that is not tidiness. This same file explains the convention
     * in a doc comment that contains the literal text `supported: false`; a predicate reading raw
     * bytes would accept that prose as the declaration and hold node's exemption open on the
     * strength of a sentence about declarations. The exemption rests on the field or on nothing.
     */
    /*
     * RETURNS null WHEN THE FILE COULD NOT BE READ, and that is a third answer
     * rather than a falsy second one. `false` here means STALE EXEMPTION — the
     * evidence no longer says what the entry claims — and an unparsed file would
     * have produced exactly that sentence for a file nobody read. A refusal has to
     * name its own subject.
     */
    stillTrue: (src) => {
      const code = blankComments(ts, src, "observability.ts");
      if (code === null) return null;
      return /langfuse:\s*\{[\s\S]{0,400}?supported:\s*false/.test(code);
    },
  },
};

/**
 * Modules inside a checked plane that carry no invocation site, with reasons.
 *
 * Derived where derivation is honest: a leading underscore or a dunder is Python's own marker
 * for "not a public module of this package", so `_common.py` and `__init__.py` are excluded by
 * that convention rather than by name. Anything else must be named.
 */
const MODULES_NOT_CHECKED = {};

/** The literals must cover the world. Returns the ways they currently do not. */
export function checkSubjectTotality(root) {
  const problems = [];

  // ── planes ────────────────────────────────────────────────────────────────────────────────
  const declared = declaredPlanes(root);
  if (declared.size === 0) {
    problems.push(
      "TOTALITY: rungs.json declared ZERO runtimes, so 'every plane is accounted for' is true " +
        "of no planes. The manifest moved or the parse broke; either way nothing was checked."
    );
    return problems;
  }
  const checkedDirs = new Set(RUNTIMES);
  for (const [id, dir] of declared) {
    const isChecked = checkedDirs.has(dir);
    const exempt = PLANES_NOT_CHECKED[id];
    if (isChecked && exempt)
      problems.push(
        `TOTALITY: plane "${id}" is both checked and listed in PLANES_NOT_CHECKED — one of the ` +
          `two is wrong, and which one decides whether its sites are being read.`
      );
    if (!isChecked && !exempt)
      problems.push(
        `TOTALITY: rungs.json declares plane "${id}" (${dir}) and this checker neither reads it ` +
          `nor records why not. A plane outside RUNTIMES is a plane whose wiring nothing here ` +
          `asserts, while the summary still says every site passes. Add it to RUNTIMES, or to ` +
          `PLANES_NOT_CHECKED with a reason.`
      );
    if (!isChecked && exempt) {
      const abs = join(root, exempt.evidence);
      if (!existsSync(abs))
        problems.push(
          `STALE EXEMPTION: plane "${id}" is excused on the evidence of ${exempt.evidence}, ` +
            `which does not exist. The reason cannot be confirmed, so the exemption is not one.`
        );
      else if (exempt.stillTrue(readFileSync(abs, "utf8")) === null)
        problems.push(
          `COULD NOT CHECK: plane "${id}" is excused on the evidence of ` +
            `${exempt.evidence}, which did not parse — so the exemption was neither ` +
            `confirmed nor refuted, which is not the same as it having gone stale.`
        );
      else if (!exempt.stillTrue(readFileSync(abs, "utf8")))
        problems.push(
          `STALE EXEMPTION: plane "${id}" is excused because it ${exempt.why}, and ` +
            `${exempt.evidence} no longer says so. Either it gained Langfuse support and belongs ` +
            `in RUNTIMES, or the evidence moved and this entry is describing nothing.`
        );
    }
  }
  for (const id of Object.keys(PLANES_NOT_CHECKED))
    if (!declared.has(id))
      problems.push(
        `STALE EXEMPTION: PLANES_NOT_CHECKED names "${id}", which rungs.json no longer declares ` +
          `as a runtime. A hole held open for a plane that is gone reads as a considered decision.`
      );

  // ── modules within each checked plane ─────────────────────────────────────────────────────
  let scanned = 0;
  for (const dir of RUNTIMES) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      if (!file.endsWith(".py")) continue;
      // Python's own convention for "not a public module of this package".
      if (file.startsWith("_")) continue;
      scanned++;
      if (MODULES.includes(file) || file in MODULES_NOT_CHECKED) continue;
      problems.push(
        `TOTALITY: ${dir}/${file} is an adapter module this checker never opens. A new rung's ` +
          `dispatch lands here, and MODULES not naming it is why the summary can say every site ` +
          `passes while the new one is unread. Add it to MODULES with its expected count, or to ` +
          `MODULES_NOT_CHECKED with a reason.`
      );
    }
  }
  if (scanned === 0)
    problems.push(
      "TOTALITY: ZERO adapter modules found across the checked planes, so the module comparison " +
        "examined nothing. The directories moved, or the extension filter stopped matching."
    );
  return problems;
}

export function checkWiring(root) {
  const problems = [];
  let checked = 0;

  for (const rt of RUNTIMES) {
    for (const mod of MODULES) {
      const path = join(root, rt, mod);
      if (!existsSync(path)) {
        problems.push(
          `MISSING SOURCE: ${rt}/${mod} — cannot confirm its wiring`
        );
        continue;
      }
      // Scan the MASKED source, never the raw bytes: comments and string
      // literals are blanked so neither a site nor its `config=` can be found
      // in prose. Offsets and line numbers are unchanged by the masking.
      const src = maskPythonNonCode(readFileSync(path, "utf8"));
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
        let depth = 0,
          end = start,
          seen = false;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "(") {
            depth++;
            seen = true;
          } else if (src[i] === ")") {
            depth--;
            if (seen && depth === 0) {
              end = i;
              break;
            }
          }
        }
        const call = src.slice(start, end + 1);
        checked++;
        // `config=` must REACH langfuse_config(), not equal it. The gated langchain path
        // merges the tracing config with the approval thread's — `config={**langfuse_config(),
        // **(config or {})}` — and the property this checker exists for ("would this run
        // untraced") is satisfied by that just as well as by the bare form.
        //
        // WIDENED, NOT WEAKENED: `config=` still has to be present AND
        // `langfuse_config()` still has to appear inside the same balanced call. A site
        // passing some other config, or none, fails exactly as before — which is what the
        // selftest's REJECT cases pin.
        /*
         * TWO ACCEPTED SHAPES, NAMED — not a loose "both strings appear somewhere".
         *
         *   config=langfuse_config()                      the original
         *   config={**langfuse_config(), **(other or {})}  the gated langchain path, which
         *                                                 merges the approval thread in
         *
         * A loose test would accept `foo(langfuse_config(), config=other())` — tracing
         * present, and not the thing being passed. An explicit pair means a THIRD shape has
         * to be added here deliberately rather than slipping through.
         *
         * The first attempt at this matched the value with `[^,)]+`, which stops at the `)`
         * of `langfuse_config()` itself and so rejected the bare form. It failed on four
         * modules I had not touched, which is how a wrong pattern announces itself rather
         * than a wrong codebase.
         */
        const BARE = /config\s*=\s*langfuse_config\(\)/;
        // One level of nesting allowed: the merge form contains `or {}`.
        const MERGED =
          /config\s*=\s*\{(?:[^{}]|\{[^{}]*\})*langfuse_config\(\)(?:[^{}]|\{[^{}]*\})*\}/;
        if (!BARE.test(call) && !MERGED.test(call)) {
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

if (invokedAsProgram(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { problems, checked } = checkWiring(root);
  const lockstep = checkLockstep(root);
  const secrets = checkNoSecretLiterals(root);
  /*
   * A guard that cannot read its own population has not found the population empty. rungs.json
   * missing or unparseable makes every totality answer unknown, and an uncaught throw would
   * exit 1 — indistinguishable from "a plane is unaccounted for". 2 says which happened.
   */
  let totality;
  try {
    totality = checkSubjectTotality(root);
  } catch (err) {
    console.error(
      `REFUSE: cannot read rungs.json, so the population of planes is unknown: ${err.message}`
    );
    console.error(
      `        Every site this run did read may still pass; what is unknown is whether`
    );
    console.error(
      `        they are all of them. Exiting 2 — not checked is not the same as passed.`
    );
    process.exit(2);
  }
  const prompts = checkPromptParity(root);
  const all = [...totality, ...problems, ...lockstep, ...prompts, ...secrets];
  for (const p of all) console.error(`FAIL: ${p}`);
  if (all.length) process.exit(1);
  /*
   * THE SUBJECT IS IN THE SUMMARY. "all 10 invocation sites pass" was true of a tree with an
   * unread eleventh, because the sentence named a count and not a population. Saying which
   * planes were read, and which were deliberately not, makes the scope falsifiable at a glance.
   */
  const declared = declaredPlanes(root);
  const skipped = Object.keys(PLANES_NOT_CHECKED).filter((id) =>
    declared.has(id)
  );
  reportSubject(checked, "invocation site(s)");
  console.log(
    `PASS: all ${checked} invocation sites pass config=langfuse_config(), across ` +
      `${RUNTIMES.length} of ${declared.size} declared plane(s) and ${MODULES.length} adapter ` +
      `module(s) each` +
      (skipped.length ? `; ${skipped.join(", ")} deliberately not checked` : "")
  );
  console.log(
    `PASS: both _common.py agree from "${ANCHOR}" onward, and both requirements pin langfuse identically.`
  );
  console.log(
    `PASS: both _common.py assign identical ${PROMPTS.join(
      " and "
    )} — the constants that sit ABOVE "${ANCHOR}" and are therefore invisible to the comparison above.`
  );
  console.log("PASS: the local fixture carries no secret-shaped literal.");
}
