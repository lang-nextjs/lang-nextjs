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
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
import { extractConst } from "./lib/python-const.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = process.cwd();
const DOCS_DIR = opt("--docs", "docs");

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

/*
 * RECURSIVE, AND THAT IS THE WHOLE POINT OF #667's FIRST HALF. This read
 * `readdirSync(dir)` — one level. So widening the default from `docs/rungs` to
 * `docs` would have examined the 9 files in docs/ and DROPPED all 7 in
 * docs/rungs: not a widening at all, a SUBSTITUTION that silently stops
 * checking the rung parity matrix this checker was built for (#10). Measured
 * before the change: 7 files at docs/rungs, 9 at docs/ top level, 17
 * recursively. A domain that moves sideways while looking like it grew is the
 * same defect as the one being fixed, one level up.
 */
const docFiles = () => {
  const dir = join(ROOT, DOCS_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
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

/*
 * A DOCUMENTED GATING POSITION, HELD AGAINST THE DECLARATION (#332 item 6).
 *
 * `GATED_TOPOLOGIES` decides whether a rung x topology cell withholds a tool
 * call upstream. Which cells are OFF is as much a decision as which are on, and
 * #332 asked for one of them — langchain x plan-execute — to be ruled on
 * explicitly rather than "left to be discovered". A ruling in prose is the shape
 * this repo spends its checkers removing, so the ruling is written in a form
 * that can be wrong: state the position in the doc, read the constant, compare.
 *
 * WHAT THIS CATCHES THAT THE PYTHON TRIPWIRE DOES NOT. The tripwire in
 * test_approval_dispatch.py pins the exact set, so arming a cell fails it — but
 * a person who arms the cell AND updates the tripwire has a green tree and a doc
 * still saying the cell is advisory. That is the half nothing held, and it is
 * the half a ruling is for.
 *
 * THE CLAIM IS WRITTEN AS A SENTENCE, not a table row or an HTML comment,
 * because a reader has to meet it. The parse is deliberately narrow: the rung
 * and topology in backticks, the verdict in bold, in that order.
 *
 *     the `plan-execute` topology on the `langchain` rung is **not upstream-gated**
 *     the `react` topology on the `langchain` rung is **upstream-gated**
 *
 * BOTH PLANES ARE READ, and disagreement between them is reported rather than
 * resolved. check-run-axes-parity already refuses a tree where the two planes'
 * declarations differ; if that ever regresses, a doc claim silently matching one
 * plane and not the other would be a second thing to be wrong about.
 */
const GATING_CLAIM_RE =
  /`([a-z][a-z-]*)`\s+topology\s+on\s+the\s+`([a-z][a-z-]*)`\s+rung\s+is\s+\*\*(not\s+)?upstream-gated\*\*/g;

const GATING_PLANES = {
  fastapi: (rung) => `apps/fastapi-backend/ai_backends/${rung}.py`,
  django: (rung) =>
    `apps/django-backend/deepagents_backend/ai_backends/${rung}.py`,
};

function gatingClaims(src, file, findings) {
  for (const m of src.matchAll(GATING_CLAIM_RE)) {
    const [, topology, rung, negated] = m;
    const claimedGated = !negated;

    const measured = {};
    for (const [plane, pathFor] of Object.entries(GATING_PLANES)) {
      const abs = join(ROOT, pathFor(rung));
      // A rung the tree does not have is not a wrong claim — an ejected fork
      // legitimately lacks it. Absent from BOTH planes is reported below;
      // silently passing on it is how a doc outlives its subject.
      if (!existsSync(abs)) continue;
      const value = extractConst(
        readFileSync(abs, "utf-8"),
        "GATED_TOPOLOGIES"
      );
      if (value === null) continue;
      measured[plane] = new RegExp(`["']${topology}["']`).test(value);
    }

    const planes = Object.keys(measured);
    if (planes.length === 0) {
      findings.push({
        kind: "gating",
        file: relative(ROOT, file),
        line: lineOf(src, m.index),
        claim: `${rung} x ${topology} is ${
          claimedGated ? "" : "not "
        }upstream-gated`,
        detail: `no plane in this tree declares GATED_TOPOLOGIES for the "${rung}" rung, so the claim was checked against nothing`,
        text: m[0],
      });
      continue;
    }

    for (const plane of planes) {
      if (measured[plane] === claimedGated) continue;
      findings.push({
        kind: "gating",
        file: relative(ROOT, file),
        line: lineOf(src, m.index),
        claim: `${rung} x ${topology} is ${
          claimedGated ? "" : "not "
        }upstream-gated`,
        detail:
          `${plane}'s GATED_TOPOLOGIES ${
            measured[plane] ? "contains" : "does not contain"
          } ` +
          `"${topology}". The ruling and the declaration disagree: change the ruling in the ` +
          `same commit that changes the switch, or the doc outlives the decision it records.`,
        text: m[0],
      });
    }
  }
}

/*
 * A GITIGNORED PATH IS NOT ASSERTABLE — neither present nor absent — because
 * whether it exists is a fact about the MACHINE, not about the tree. #667
 * measured 7 failures on a clean worktree and 4 on a built one at the same
 * commit; the difference was `apps/example/.next`, which the regex matches
 * because `\.[a-z]{2,4}` reads `.next` as an extension.
 *
 * THE DIRECTION IS WHY IT MATTERED: the checker PASSED for anyone who had built
 * the repo and FAILED on a clean checkout, so the person most likely to run it
 * locally was least likely to see it, and CI was the only place it bit. That
 * produces "CI is red and it passes on my machine", which is expensive out of
 * proportion to its size because it makes the reporter look wrong.
 *
 * AND THE OBVIOUS REPAIR INHERITS THE DEFECT. `git check-ignore <path>` is
 * ITSELF build-state dependent for a DIRECTORY pattern: `.gitignore` line 24 is
 * `.next/`, with a trailing slash, so git can only match it once it knows the
 * path is a directory — which it learns by looking at the disk. Measured:
 *
 *     built tree,   apps/example/.next exists      -> matches .gitignore:24
 *     clean tree,   apps/example/.next absent      -> NO MATCH, exit 1
 *     either tree,  apps/example/.next/ (slash)    -> matches
 *
 * So a naive `check-ignore` skip would pass on a built machine and fail on a
 * clean checkout: the same asymmetry, in the same direction, as the bug it is
 * meant to remove. Asking about BOTH spellings makes the answer independent of
 * whether anything has been built.
 */
/*
 * KIND 4: VERSION CONSTRAINTS, AND WHY THIS IS THE ONLY ONE OF #776's THREE
 * THAT COULD BE BUILT.
 *
 * #776 named three prose claims that look like one shape and are three different
 * resolution problems:
 *
 *   1. VERSION CONSTRAINTS  "package.json pins prettier 2.8.8"
 *      The subject is a FILE THIS REPO ALREADY READS. Checkable here.
 *   2. TOOL DEFAULT BEHAVIOUR  "npx resolves prettier 3.9.6 here"
 *      NOT CHECKED. The subject is what a resolver does in an environment, which
 *      needs the resolver run under the conditions the sentence assumes. That is
 *      a bespoke resolver per tool, and a wrong one answers confidently.
 *   3. UPSTREAM FEATURE REQUIREMENTS  "minimumReleaseAge needs pnpm >=10.16"
 *      NOT CHECKED. The subject is another project's changelog. Nothing in this
 *      tree can be read to settle it.
 *
 * A claim is checkable when its subject is nameable AND its truth is observable by
 * the SAME instrument. Only kind 1 satisfies both, and a green run here says
 * nothing whatever about kinds 2 and 3.
 *
 * ── WHY A MARKER, AND NOT A PATTERN OVER THE PROSE ────────────────────────────
 *
 * The obvious build scans for version-shaped tokens. It cannot work, and the
 * reason is TENSE rather than syntax. This tree deliberately contains true
 * sentences about versions that no longer hold:
 *
 *   assert-single-instance.mjs:11  "When this file was written the tree had TWO
 *                                   zod copies ... packages/mcp pinned ^3.23.0"
 *
 * That is accurate history — `git log -S` finds the commit that removed the pin —
 * and #900 leaves four more like it standing on purpose, because deleting the
 * history would leave a design decision with no visible reason. A token matcher
 * goes RED on every one of them.
 *
 * Distinguishing "asserting now" from "recording then" means classifying English
 * tense, and a classifier that is wrong in either direction is worse than no
 * check: wrong one way it blocks correct prose, wrong the other it certifies a
 * false claim. I do not think it can be done reliably enough to gate CI, so this
 * does not try. THE CLAIM DECLARES ITSELF, exactly as `needs:` and `subjectKind`
 * are declared rather than inferred elsewhere in this repo.
 *
 * ── WHAT THAT BUYS AND WHAT IT COSTS ──────────────────────────────────────────
 *
 * It catches DRIFT, which is the defect that actually occurred: nobody edited the
 * prose, the code moved underneath it. A claim marked when it was written and
 * believed fires the day its source changes.
 *
 * It cannot catch a claim that was FALSE WHEN WRITTEN, because nobody marks a
 * sentence they think is wrong. That blind spot is real and is the same one
 * #875's staleNotes has: this asks "has the ground moved under this sentence",
 * never "is this sentence true". The three false claims on main today became
 * false by drift, so this kind would have caught all three.
 *
 * Syntax, usable from a JS comment, a YAML comment or markdown:
 *
 *   @version-claim <repo-relative-path> :: <exact substring that must be present>
 *
 * The substring is matched literally. No version algebra: "does this file still
 * contain these bytes" is a question with one answer, and a semver comparator
 * would reintroduce a resolver whose bugs look like findings.
 */
const VERSION_CLAIM_RE = /@version-claim\s+(\S+)\s*::\s*(.+?)\s*(?:\*\/\s*)?$/;

/*
 * A MISSING FILE IS A REFUSAL, NOT A VIOLATION (#689, and this file's own
 * `unassertable`). "The file you named is gone" and "your claim about that file
 * is false" send a reader to different places, and only the second is a finding
 * about the prose.
 */
export function versionClaims(src, file, findings, stats) {
  src.split("\n").forEach((text, i) => {
    const m = text.match(VERSION_CLAIM_RE);
    if (!m) return;
    const path = m[1];
    /*
     * THE SYNTAX DOCUMENTATION IS INSIDE THE SUBJECT. The comment twenty lines up
     * spells the marker out — `@version-claim <repo-relative-path> :: ...` — and the
     * first run of this checker refused on its own header, naming
     * `<repo-relative-path>` as a file that does not exist. It was right to: that
     * line matches the pattern in every respect except being a claim.
     *
     * A placeholder is angle-bracketed by convention here and a real repo-relative
     * path never contains `<` or `>`, so the two are separable without a special
     * case for this file — which matters, because any doc explaining the syntax
     * would hit exactly the same thing.
     */
    if (/[<>]/.test(path)) return;
    const needle = m[2].replace(/\s*-->\s*$/, "").trim();
    stats.examined++;
    const abs = join(ROOT, path);
    if (!existsSync(abs)) {
      stats.unreadable.push(
        `${file}:${i + 1} names ${path}, which does not exist`
      );
      return;
    }
    let source;
    try {
      source = readFileSync(abs, "utf8");
    } catch (e) {
      /*
       * A SOURCE THAT EXISTS AND CANNOT BE READ IS NOT A FALSE CLAIM EITHER (#1204).
       * `existsSync` is true for a directory, so a claim naming one used to throw EISDIR
       * here, and the caller's catch, written for an unreadable DOC, swallowed it together
       * with every claim after it in that file: a false claim went unevaluated and the run
       * passed. It now registers on the refusal channel like a missing source, and the loop
       * goes on to the next claim.
       */
      stats.unreadable.push(
        `${file}:${i + 1} names ${path}, which could not be read (${
          e?.code ?? e?.message
        })`
      );
      return;
    }
    if (!source.includes(needle)) {
      findings.push({
        file,
        line: i + 1,
        kind: "version-constraint",
        claim: `${path} contains "${needle}"`,
        detail:
          `${path} exists and does NOT contain "${needle}". The prose beside this ` +
          `marker asserts a version its own named source no longer carries — the ` +
          `source moved and the sentence did not.`,
        text: text.trim(),
      });
    }
  });
}

function unassertable(paths) {
  const probe = [];
  for (const p of paths) probe.push(p, `${p}/`);
  if (!probe.length) return new Set();
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT,
      input: probe.join("\n"),
      encoding: "utf-8",
    });
  } catch (e) {
    // exit 1 means "nothing matched", which is a real answer, not a failure.
    if (e.status === 1) {
      out = e.stdout ?? "";
    } else {
      /*
       * COULD NOT ASK IS NOT "NOTHING IS IGNORED". Outside a git repo — a bare
       * fixture directory, a tarball, a vendored copy — `git check-ignore`
       * cannot answer, and treating that silence as "no path is ignored" would
       * reinstate exactly the build-state dependence this function removes,
       * only harder to see. So it REFUSES with the repo's "could not compute"
       * status rather than guessing, and says which question went unanswered.
       */
      console.error(
        "CANNOT BE COMPUTED: `git check-ignore` could not run, so which paths " +
          "are gitignored is unknown.\n" +
          "      A gitignored path is not assertable, and assuming NONE are " +
          "ignored would make this checker's\n" +
          "      verdict depend on whether the repo has been built — the defect " +
          "it exists to remove (#667).\n" +
          `      git said: ${
            String(e.stderr ?? e.message)
              .trim()
              .split("\n")[0]
          }`
      );
      process.exit(2);
    }
  }
  const ignored = new Set();
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t) ignored.add(t.replace(/\/$/, ""));
  }
  return ignored;
}

/*
 * A CITATION IS NOT A CLAIM, and no regex separates them — which
 * docs/CHECKING-THE-CHECK.md predicted before this was written:
 *
 *     "The checker's subject was never 'tails versus full paths.' It is
 *      'strings that look like paths', and that is not the same set as
 *      'links this document asserts.'"
 *
 * It also predicted that the obvious repair fails: requiring full paths still
 * reports that very section, because the paragraphs QUOTE a path while
 * explaining that no such file exists. Measured here too — every one of the 28
 * path references in docs/*.md is inline code and NONE is a markdown link, so
 * "only check link targets" would shrink the domain to zero and check nothing.
 *
 * The difference is semantic, so the DOCUMENT declares it rather than the
 * checker guessing. A region marked with these comments is prose ABOUT paths:
 *
 *     <!-- doc-claims:cite --> ... <!-- /doc-claims:cite -->
 *
 * AND IT CANNOT ROT INTO A MUTE BUTTON, because a region that suppresses
 * nothing is an ERROR. The day someone creates docs/LOCAL-AGENT.md, the region
 * quoting it stops doing any work and this says so instead of sitting there
 * silently excusing a file that now exists.
 */
const CITE_OPEN = "<!-- doc-claims:cite -->";
const CITE_CLOSE = "<!-- /doc-claims:cite -->";

function citeRegions(src, file, findings) {
  const regions = [];
  let from = 0;
  for (;;) {
    const a = src.indexOf(CITE_OPEN, from);
    if (a === -1) break;
    const b = src.indexOf(CITE_CLOSE, a);
    if (b === -1) {
      findings.push({
        kind: "unclosed-cite-region",
        file: relative(ROOT, file),
        line: lineOf(src, a),
        claim: CITE_OPEN,
        detail: `opened and never closed with ${CITE_CLOSE}`,
        text: CITE_OPEN,
      });
      break;
    }
    regions.push({
      start: a,
      end: b + CITE_CLOSE.length,
      line: lineOf(src, a),
      used: 0,
    });
    from = b + CITE_CLOSE.length;
  }
  return regions;
}

/** A repo-relative path in backticks must exist, unless it is not assertable. */
function pathClaims(src, file, findings, stats) {
  const regions = citeRegions(src, file, findings);
  const matches = [
    ...src.matchAll(
      /`((?:apps|packages|scripts|e2e|docs)\/[A-Za-z0-9_./-]+\.[a-z]{2,4})`/g
    ),
  ].filter((m) => !m[1].includes("*"));

  const ignored = unassertable(matches.map((m) => m[1]));

  for (const m of matches) {
    const path = m[1];
    stats.examined++;
    if (ignored.has(path)) {
      stats.unassertable++;
      continue;
    }
    if (existsSync(join(ROOT, path))) continue;
    const region = regions.find((r) => m.index > r.start && m.index < r.end);
    if (region) {
      region.used++;
      stats.cited++;
      continue;
    }
    findings.push({
      kind: "missing-path",
      file: relative(ROOT, file),
      line: lineOf(src, m.index),
      claim: path,
      detail: "no such file",
      text: m[0],
    });
  }

  for (const r of regions) {
    if (r.used === 0) {
      findings.push({
        kind: "dead-cite-region",
        file: relative(ROOT, file),
        line: r.line,
        claim: "doc-claims:cite region",
        detail:
          "suppresses nothing — every path inside it resolves, so the region is " +
          "excusing a problem that no longer exists. Delete it.",
        text: CITE_OPEN,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */

/*
 * THE DRIVER RUNS ONLY WHEN THIS FILE IS THE PROGRAM.
 *
 * It was top-level, and importing the module for its exports executed the whole
 * checker and called process.exit — so this file's own proof, which imports
 * `versionClaims`, exited 2 before running a single assertion. A module that
 * cannot be imported without running has no unit-testable surface, and the proof
 * that would have caught it is the one the behaviour prevents.
 */
function main() {
  const measured = measureTopologies();
  const findings = [];
  const files = docFiles();
  const pathStats = { examined: 0, unassertable: 0, cited: 0 };
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    exclusivityClaims(src, file, measured, findings);
    lineCountClaims(src, file, findings);
    pathClaims(src, file, findings, pathStats);
    gatingClaims(src, file, findings);
  }

  /*
   * THE VERSION-CLAIM CORPUS IS NOT docs/. These claims live in the comments of the
   * things they describe — a CI step explaining its pin, a formatter explaining
   * which prettier it means — which is the right place for them and not a place the
   * rung-doc scan looks. Listing the roots explicitly rather than walking the repo
   * keeps the subject nameable: a reader can see which trees are covered, and a
   * tree nobody listed is visibly uncovered rather than silently so.
   */
  const VERSION_CLAIM_ROOTS = [
    ["scripts", /\.mjs$/],
    [".github", /\.ya?ml$/],
    [join(".github", "workflows"), /\.ya?ml$/],
    [".", /^pnpm-workspace\.yaml$/],
  ];
  const versionStats = { examined: 0, unreadable: [] };
  const versionFiles = [];
  for (const [dir, re] of VERSION_CLAIM_ROOTS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!re.test(name)) continue;
      /*
       * A PROOF'S FIXTURES ARE NOT CLAIMS. The first run of this scan read this
       * kind's own selftest and reported its two deliberately-broken fixtures --
       * `apps/nope/requirements.txt` -- as claims naming a missing file, and
       * refused. The negative fixtures a checker needs in order to be shown
       * trustworthy are, to that same checker, violations.
       */
      if (/\.selftest\.mjs$/.test(name)) continue;
      const full = join(abs, name);
      // The try covers the READ only (#1204). It used to wrap versionClaims() too, so a throw
      // while evaluating one claim was taken for "not a claim site" and voided the whole file.
      let body;
      try {
        body = readFileSync(full, "utf8");
      } catch {
        /* a directory matching the pattern, or an unreadable entry: not a claim site */
        continue;
      }
      versionFiles.push(full);
      versionClaims(body, relative(ROOT, full), findings, versionStats);
    }
  }

  /*
   * REFUSAL OUTRANKS, and it is reported before the findings so a reader is not
   * handed an edit instruction derived from a run that could not read its sources.
   */
  if (versionStats.unreadable.length > 0) {
    console.error(
      `COULD NOT CHECK: ${versionStats.unreadable.length} version claim(s) name a source that does not exist or could not be read:`
    );
    for (const u of versionStats.unreadable) console.error(`   - ${u}`);
    console.error(
      "\n      A claim whose named source is missing has not been shown false — it has\n" +
        "      not been checked. Fix the path, or remove the marker if the claim is gone."
    );
    process.exit(2);
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

  /*
   * ONE SUBJECT, AND IT COUNTS CLAIMS RATHER THAN FILES.
   *
   * HUMAN MODE ONLY, because `--json`'s stdout is a machine contract. `reportSubject`
   * writes to stdout, and emitting it before the JSON made the payload unparseable —
   * every spawn-based case in this file's own proof came back `exit -1` with zero
   * findings, which is what a JSON.parse throw looks like from the outside: not a
   * verdict, the absence of one. run-checks invokes checkers in human mode, so the
   * count still reaches the runner. A file count answers
   * "did I open anything"; the question a floor must protect is "did I examine
   * any CLAIM", and those differ exactly when the corpus is present but carries
   * nothing checkable — the shape every vacuity failure in this repo has taken.
   *
   * Only the two kinds that count their own subjects are summed. Exclusivity and
   * line-count claims are found by scanning rather than enumerated, so they have
   * no count to contribute, and inventing one would make this number less true
   * rather than larger. That understates the subject and is said here so the
   * number is read as a floor on claims examined, not a total.
   */
  if (!args.includes("--json")) {
    reportSubject(
      pathStats.examined + versionStats.examined,
      "enumerable doc claim(s) re-measured (paths + version constraints)"
    );
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          findings,
          docsScanned: files.length,
          versionClaimsExamined: versionStats.examined,
          versionClaimFiles: versionFiles.length,
          pathsExamined: pathStats.examined,
          pathsUnassertable: pathStats.unassertable,
          pathsCited: pathStats.cited,
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
        /*
         * THE DOMAIN IS PART OF THE ANSWER. All three known instances of this
         * class shipped without it — SCHEMA_MAP's 11 and docs/rungs' 7 both
         * looked plausible and both were wrong, and neither said so. A reader
         * who can see the number can notice it is too small; one who cannot,
         * cannot. The two exclusion counts are here for the same reason: a
         * suppression nobody can see is indistinguishable from a check that
         * never ran.
         */
        `  version claims   : ${versionStats.examined} marked, re-read against their named source\n` +
        `  paths examined   : ${pathStats.examined} (${pathStats.unassertable} not assertable, ` +
        `${pathStats.cited} cited rather than claimed)\n` +
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
        "    the false claim in the file that misled.\n" +
        "  - version claims with NO `@version-claim` marker. Coverage is opt-in\n" +
        "    because separating an assertion from recorded history means reading\n" +
        "    tense, and this tree deliberately keeps true past-tense sentences\n" +
        "    about versions that no longer hold (#900 keeps four).\n" +
        "  - what a TOOL resolves (`npx resolves prettier 3.9.6`) and what an\n" +
        "    UPSTREAM release requires (`minimumReleaseAge needs pnpm >=10.16`).\n" +
        "    #776's other two kinds: neither subject is a file in this tree."
    );
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

if (invokedAsProgram(import.meta.url)) main();
