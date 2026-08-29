#!/usr/bin/env node
/**
 * THE RUNG DOCS ASSERT MEASURABLE FACTS. THIS RE-MEASURES THEM (#364).
 *
 * Found while writing #10's parity matrix: `docs/rungs/3-deepagents.md` was
 * telling a reader that `deep-research` was FastAPI-only and that Django had no
 * `web_search` and no `ddgs`. Django serves all three topologies and has both.
 * The same false claim appeared THREE times across two files, and the quoted
 * line counts were stale in both directions — 78/109 for files that are 569/581.
 *
 * THE ADVICE WAS LOAD-BEARING. It told a reader to pick FastAPI over Django on
 * the basis of a gap THAT HAD SINCE BEEN CLOSED ON PURPOSE. Someone forking
 * rung 3 would have made an architectural choice from a fact that stopped being
 * true.
 *
 *   A doc that names a divergence is exactly the doc that must be re-measured
 *   when the divergence closes — and nothing fails when it does.
 *
 * That is the case this checker exists for, and it is why the selftest asserts
 * the INVERSE mutation as well as the obvious one. A checker that only catches
 * a hand-edited doc would have missed what actually happened: nobody edited the
 * doc. The code improved underneath it.
 *
 * WHAT IS CHECKED — only claims with a single mechanical answer:
 *
 *   1. EXCLUSIVITY   "<topology> ... FastAPI-only / Python only / Node only"
 *                    The set of runtimes serving that topology must EQUAL the
 *                    claimed scope. This is the claim that was wrong.
 *   2. LINE COUNTS   "`path` (N lines" must match the file, within tolerance.
 *   3. PATHS         A repo-relative path in backticks must exist.
 *
 * A KNOWN FALSE-POSITIVE SHAPE, and it fired on the first doc written after this
 * checker existed. "eject to a TypeScript-only fork" puts a scope word within
 * PROXIMITY of a topology while making a claim about the FORK, not the
 * topology. The remedy is to rephrase, and that trade is deliberate: a visible
 * false positive costs one sentence, and the false NEGATIVE it prevents is a
 * doc telling forkers to avoid a runtime for a reason that stopped being true.
 * If this becomes common, bind the scope to a topology by grammar rather than
 * distance — do not widen the tolerance until it stops complaining.
 *
 * NOT CHECKED, and named so a green run is not read as "every claim verified":
 *   - prose judgement of any kind
 *   - the topology TABLE in docs/rungs/README.md. Its rows are mechanically
 *     checkable in principle and parsing markdown tables reliably is a bigger
 *     job than the three above put together. The prose beside it IS checked,
 *     which is what carried the false claim in the file that misled.
 *
 * Usage: node scripts/check-doc-claims.mjs [--docs docs/rungs] [--json]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const ROOT = process.cwd();
const DOCS_DIR = opt("--docs", "docs/rungs");

/** How far a quoted line count may drift before it is a lie. */
const LINE_TOLERANCE = 10;

/**
 * How near a topology must be to a scope word for the claim to be about it.
 * Wide enough for "the `deep-research` topology is **FastAPI-only**" with
 * markdown emphasis and a line wrap in between; narrow enough that a topology
 * named in a different sentence is not swept in.
 */
const PROXIMITY = 120;

/* -------------------------------------------------------------------------- */
/*  MEASURED FACTS — the source of truth, read from the dispatch maps         */
/* -------------------------------------------------------------------------- */

/**
 * Where each runtime's rung modules live, and how its dispatch map is spelled.
 *
 * These three are the same source `check-run-axes-parity.mjs` reads, and they
 * are the ONLY place a runtime is named in this file — a fork that ejects a
 * runtime loses its entry rather than failing on its absence.
 */
const RUNTIMES = [
  { id: "fastapi", dir: "apps/fastapi-backend/ai_backends", ext: ".py" },
  {
    id: "django",
    dir: "apps/django-backend/deepagents_backend/ai_backends",
    ext: ".py",
  },
  { id: "node", dir: "apps/node-backend/src/ai_backends", ext: ".ts" },
];

/** Words a doc may use to scope a claim, and the runtimes each one means. */
const SCOPES = {
  fastapi: ["fastapi"],
  django: ["django"],
  node: ["node"],
  typescript: ["node"],
  python: ["fastapi", "django"],
};

/**
 * topology -> the set of runtimes that serve it, measured.
 *
 * Reads the dispatch map rather than the file list: a module can exist and
 * serve two of three topologies, which is exactly the node/deepagents case.
 */
function measureTopologies() {
  const byTopology = new Map();
  const runtimesPresent = [];
  for (const rt of RUNTIMES) {
    const dir = join(ROOT, rt.dir);
    if (!existsSync(dir)) continue;
    runtimesPresent.push(rt.id);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(rt.ext)) continue;
      const src = readFileSync(join(dir, f), "utf-8");
      // `TOPOLOGIES = {` (py) or `export const TOPOLOGIES: ... = {` (ts).
      const m = src.match(/TOPOLOGIES[^=]*=\s*\{([\s\S]*?)\n\}/);
      if (!m) continue;
      for (const k of m[1].matchAll(/["']([a-z][a-z0-9-]*)["']\s*:/g)) {
        if (!byTopology.has(k[1])) byTopology.set(k[1], new Set());
        byTopology.get(k[1]).add(rt.id);
      }
      // TS allows a bare identifier key: `react: streamChatReact,`
      for (const k of m[1].matchAll(/^\s*([a-z][a-zA-Z0-9]*)\s*:/gm)) {
        if (!byTopology.has(k[1])) byTopology.set(k[1], new Set());
        byTopology.get(k[1]).add(rt.id);
      }
    }
  }
  return { byTopology, runtimesPresent };
}

/* -------------------------------------------------------------------------- */
/*  CLAIMS                                                                    */
/* -------------------------------------------------------------------------- */

const docFiles = () => {
  const dir = join(ROOT, DOCS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
};

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/**
 * "<topology> ... FastAPI-only" and friends.
 *
 * PARAGRAPH-SCOPED, NOT LINE-SCOPED, and the first version was line-scoped and
 * missed the instance that mattered most. Markdown wraps prose, so
 * docs/rungs/README.md carried
 *
 *     ⚠️ **The two Python backends are not perfect mirrors.** `deep-research` exists in
 *     FastAPI only. Django's `deepagents.py` has two topologies, ...
 *
 * — the topology on one line and the scope word on the next. A line-scoped
 * check found seven real claims, reported a plausible list, and silently walked
 * past the copy in the most-read file of the six. It looked like it worked.
 *
 * Quoted claims are skipped: a doc that says `this used to read "FastAPI only"`
 * is describing a claim, not making one, and flagging that would make an honest
 * correction unwritable.
 */
function exclusivityClaims(src, file, measured, findings) {
  const SCOPE_RE = new RegExp(
    `\\b(${Object.keys(SCOPES).join("|")})[\\s-]?only\\b`,
    "i"
  );
  /*
   * Blocks are blank-line separated AND a list item starts a new one.
   *
   * Without the second rule the three topology bullets in 3-deepagents.md merge
   * into ONE block — markdown does not blank-line-separate list items — and the
   * "FastAPI only" belonging to the `deep-research` bullet is attributed to
   * `react` and `plan-execute` as well. Three findings, two of them false, from
   * a claim about a third thing entirely.
   */
  const lines = src.split("\n");
  const blocks = [];
  let cur = null;
  const startsItem = (l) => /^\s*(?:[-*+]\s|\d+\.\s)/.test(l);
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      cur = null;
      return;
    }
    if (!cur || startsItem(line)) {
      cur = { start: i + 1, text: [] };
      blocks.push(cur);
    }
    cur.text.push(line);
  });

  for (const block of blocks) {
    const text = block.text.join(" ");
    const m = text.match(SCOPE_RE);
    if (!m) continue;
    const before = text.slice(0, m.index);
    if ((before.match(/"/g) ?? []).length % 2 === 1) continue;
    const scope = m[1].toLowerCase();
    for (const [topology, servers] of measured.byTopology) {
      /*
       * PROXIMITY BINDS THE SCOPE TO A TOPOLOGY. "the `deep-research` topology
       * is **FastAPI-only**" is one claim; a block that happens to mention
       * another topology sixty words earlier is not making a claim about it.
       * Without this, one true finding drags in every topology named nearby.
       */
      const at = text.indexOf(topology);
      if (at === -1) continue;
      if (Math.abs(at - m.index) > PROXIMITY) continue;
      const claimed = new Set(
        SCOPES[scope].filter((r) => measured.runtimesPresent.includes(r))
      );
      const actual = new Set(
        [...servers].filter((r) => measured.runtimesPresent.includes(r))
      );
      const same =
        claimed.size === actual.size &&
        [...claimed].every((r) => actual.has(r));
      if (!same) {
        findings.push({
          kind: "exclusivity",
          file: relative(ROOT, file),
          line: block.start,
          claim: `"${topology}" is ${scope}-only`,
          detail: `claimed [${[...claimed].sort()}], measured [${[
            ...actual,
          ].sort()}]`,
          text: text.trim().slice(0, 140),
        });
      }
    }
  }
}

/** "`path` (N lines" — the count must match the file. */
function lineCountClaims(src, file, findings) {
  for (const m of src.matchAll(
    /`([^`]+\.(?:py|ts|tsx|mjs))`\s*\((\d+) lines/g
  )) {
    const [, path, claimed] = m;
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue; // the path check reports this separately
    const actual = readFileSync(abs, "utf-8").split("\n").length - 1;
    if (Math.abs(actual - Number(claimed)) > LINE_TOLERANCE) {
      findings.push({
        kind: "line-count",
        file: relative(ROOT, file),
        line: lineOf(src, m.index),
        claim: `${path} is ${claimed} lines`,
        detail: `actual ${actual} (tolerance ${LINE_TOLERANCE})`,
        text: m[0],
      });
    }
  }
}

/** A repo-relative path in backticks must exist. */
function pathClaims(src, file, findings) {
  for (const m of src.matchAll(
    /`((?:apps|packages|scripts|e2e|docs)\/[A-Za-z0-9_./-]+\.[a-z]{2,4})`/g
  )) {
    const path = m[1];
    if (path.includes("*")) continue;
    if (existsSync(join(ROOT, path))) continue;
    findings.push({
      kind: "missing-path",
      file: relative(ROOT, file),
      line: lineOf(src, m.index),
      claim: path,
      detail: "no such file",
      text: m[0],
    });
  }
}

/* -------------------------------------------------------------------------- */

const measured = measureTopologies();
const findings = [];
const files = docFiles();
for (const file of files) {
  const src = readFileSync(file, "utf-8");
  exclusivityClaims(src, file, measured, findings);
  lineCountClaims(src, file, findings);
  pathClaims(src, file, findings);
}

/*
 * A ZERO WITH NOTHING MEASURED IS NOT A ZERO. Every check compares a doc
 * against the dispatch maps; with no maps parsed, every claim is trivially
 * consistent with an empty world and this reports a clean bill of health for a
 * repo it never read — the failure this whole file is about, one layer along.
 *
 * BEFORE THE OUTPUT BRANCH, and it was inside it. The guard ran in human mode
 * and not under `--json`, so the machine-readable path — the one a CI step or
 * another script would use — returned exit 0 and an empty finding list for an
 * empty world. Its own selftest caught that: a guard with a mode in which it
 * does not run is the shape it exists to prevent.
 */
if (measured.byTopology.size === 0 || files.length === 0) {
  console.error(
    "FAIL: measured nothing — no dispatch map parsed or no docs found.\n" +
      "      A green result here would be vacuous, so this is an error."
  );
  process.exit(2);
}

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        findings,
        docsScanned: files.length,
        topologiesMeasured: measured.byTopology.size,
        runtimesPresent: measured.runtimesPresent,
      },
      null,
      2
    )
  );
} else {
  console.log(
    `Doc claims re-measured over ${files.length} file(s) in ${DOCS_DIR}/\n` +
      `  runtimes present : ${
        measured.runtimesPresent.join(", ") || "(none)"
      }\n` +
      `  topologies found : ${
        [...measured.byTopology.keys()].sort().join(", ") || "(none)"
      }\n`
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.kind}]  ${f.claim}`);
    console.log(`      ${f.detail}`);
    console.log(`      > ${f.text}`);
  }
  console.log(
    findings.length === 0
      ? "\nPASS: every mechanically-checkable claim in the rung docs still holds."
      : `\nFAIL: ${findings.length} doc claim(s) no longer hold.`
  );
  console.log(
    "\nNOT CHECKED (so a pass is not read as 'every claim verified'):\n" +
      "  - prose judgement of any kind\n" +
      "  - the topology TABLE in docs/rungs/README.md — rows are checkable in\n" +
      "    principle; the prose beside it is checked, and that is what carried\n" +
      "    the false claim in the file that misled."
  );
}

process.exit(findings.length === 0 ? 0 : 1);
