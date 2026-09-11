#!/usr/bin/env node
/**
 * The doc-claims checker, watched failing before it is trusted (#364).
 *
 * TWO MUTATIONS, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 *   FORWARD — edit a doc to say something false. Obvious, and any checker
 *             worth having catches it.
 *   INVERSE — leave the doc alone and CLOSE A DIVERGENCE IN THE CODE. That is
 *             what actually happened: Django gained `deep-research`, nobody
 *             touched `docs/rungs/`, and a correct warning silently became a
 *             lie that told forkers to avoid Django.
 *
 * A checker that only catches hand-edited docs would have missed the real case
 * entirely, so the inverse is not a nice-to-have — it is the acceptance
 * criterion. #364 asks for it by name.
 *
 * Fixtures are built here rather than read from the repo: a selftest that
 * mutates the working tree can leave it dirty, and one that reads the tree
 * passes or fails for reasons that have nothing to do with the checker.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "check-doc-claims.mjs");
import { versionClaims } from "./check-doc-claims.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(
    `  ${cond ? "ok  " : "FAIL"}   ${name}${detail ? `   ${detail}` : ""}`
  );
  if (!cond) failures++;
};

/** The three dispatch maps, as each runtime really spells them. */
const py = (tops) =>
  `TOPOLOGIES = {\n${tops
    .map((t) => `    "${t}": stream_${t},`)
    .join("\n")}\n}\n`;
/* The gating declaration a ruling claims about. `null` writes none, which is a
 * different tree from one declaring an empty set: the first cannot answer the
 * question and the second answers "no". */
const gated = (tops) =>
  tops === null
    ? ""
    : `\n\nGATED_TOPOLOGIES = frozenset({${tops
        .map((t) => `"${t}"`)
        .join(", ")}})\n`;

const ts = (tops) =>
  `export const TOPOLOGIES: Record<string, unknown> = {\n` +
  tops.map((t) => `  "${t}": stream,`).join("\n") +
  `\n}\n`;

/**
 * A miniature repo: three runtimes' dispatch maps plus one doc.
 * `node` deliberately serves fewer topologies, which is the real asymmetry.
 */
function stage({
  fastapi,
  django,
  node,
  doc,
  fastapiGated = [],
  djangoGated = [],
}) {
  const dir = mkdtempSync(join(tmpdir(), "doc-claims-"));
  const write = (p, body) => {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  };
  write(
    "apps/fastapi-backend/ai_backends/deepagents.py",
    py(fastapi) + gated(fastapiGated)
  );
  write(
    "apps/django-backend/deepagents_backend/ai_backends/deepagents.py",
    py(django) + gated(djangoGated)
  );
  write("apps/node-backend/src/ai_backends/deepagents.ts", ts(node));
  write("docs/rungs/3-deepagents.md", doc);
  return dir;
}

/*
 * CARRIES stderr, because an exit code cannot attribute a failure (#767). On the vacuity
 * and git-check-ignore refusals the checker exits 2 before printing JSON, so `parsed` is empty
 * and the code was the ONLY thing a
 * case could assert — which is how "measuring NOTHING is an error" came to pass on the
 * git-check-ignore refusal instead of the vacuity one it is named for. Both exit 2.
 */
function run(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER, "--json"], {
      cwd: dir,
      encoding: "utf-8",
    });
    return { code: 0, stderr: "", ...JSON.parse(out) };
  } catch (e) {
    let parsed = {};
    try {
      parsed = JSON.parse(e.stdout ?? "{}");
    } catch {
      /* the vacuity and git-check-ignore refusals print no JSON */
    }
    return { code: e.status ?? -1, stderr: String(e.stderr ?? ""), ...parsed };
  }
}

const ALL = ["react", "plan-execute", "deep-research"];
const NODE_TWO = ["react", "plan-execute"];

/** The claim that was true when written, and is the subject of both mutations. */
const DOC_PYTHON_ONLY =
  "# Rung 3\n\n" +
  "The `deep-research` topology is **Python only** — it needs a web-search tool.\n";

console.log("check-doc-claims selftest\n");

/* ---------------------------------------------------------------------- */
/* 0. THE CONTROL. If a true doc does not pass, nothing below means much.  */
/* ---------------------------------------------------------------------- */
{
  const r = run(
    stage({ fastapi: ALL, django: ALL, node: NODE_TWO, doc: DOC_PYTHON_ONLY })
  );
  ok(
    "a TRUE claim passes",
    r.code === 0 && (r.findings ?? []).length === 0,
    `exit ${r.code}, ${(r.findings ?? []).length} finding(s)`
  );
  ok(
    "  ...having actually measured something",
    r.topologiesMeasured === 3 && r.runtimesPresent?.length === 3,
    `${r.topologiesMeasured} topologies, ${r.runtimesPresent?.length} runtimes`
  );
}

/* ---------------------------------------------------------------------- */
/* 1. FORWARD — the doc lies, the code is unchanged.                       */
/* ---------------------------------------------------------------------- */
{
  const r = run(
    stage({
      fastapi: ALL,
      django: ALL,
      node: NODE_TWO,
      doc: "# Rung 3\n\nThe `deep-research` topology is **FastAPI only**.\n",
    })
  );
  const hit = (r.findings ?? []).find((f) => f.kind === "exclusivity");
  ok(
    "FORWARD: a doc claiming FastAPI-only goes red",
    r.code === 1 && Boolean(hit)
  );
  ok(
    "  ...and names both sides",
    hit?.detail?.includes("django") && hit?.detail?.includes("fastapi"),
    hit?.detail ?? ""
  );
}

/* ---------------------------------------------------------------------- */
/* 2. INVERSE — THE DOC IS UNTOUCHED AND THE CODE IMPROVES.                */
/*    This is the case that actually happened, and the reason this file    */
/*    exists. Nobody edits anything in docs/; a runtime gains a topology   */
/*    and a correct sentence becomes a false one.                          */
/* ---------------------------------------------------------------------- */
{
  const before = run(
    stage({ fastapi: ALL, django: ALL, node: NODE_TWO, doc: DOC_PYTHON_ONLY })
  );
  ok("INVERSE: green before the divergence closes", before.code === 0);

  // The ONLY change: node gains deep-research. Byte-identical doc.
  const after = run(
    stage({ fastapi: ALL, django: ALL, node: ALL, doc: DOC_PYTHON_ONLY })
  );
  const hit = (after.findings ?? []).find((f) => f.kind === "exclusivity");
  ok(
    "INVERSE: red after it closes, with the doc UNCHANGED",
    after.code === 1 && Boolean(hit),
    hit ? hit.detail : `exit ${after.code}`
  );
  ok(
    "  ...and the finding names node as the new server",
    hit?.detail?.includes("node"),
    hit?.detail ?? ""
  );
}

/* ---------------------------------------------------------------------- */
/* 3. REPORTED SPEECH IS NOT A CLAIM.                                      */
/*    A correction that quotes the claim it retires must not be flagged,   */
/*    or honest corrections become unwritable — which is how a stale doc    */
/*    gets silently deleted instead of corrected.                          */
/* ---------------------------------------------------------------------- */
{
  const r = run(
    stage({
      fastapi: ALL,
      django: ALL,
      node: NODE_TWO,
      doc:
        "# Rung 3\n\n" +
        'This used to say "the `deep-research` topology is FastAPI only", which is\n' +
        "no longer true.\n",
    })
  );
  ok("a QUOTED retired claim is not flagged", r.code === 0, `exit ${r.code}`);
}

/* ---------------------------------------------------------------------- */
/* 4. VACUITY. With no dispatch map parsed every claim is trivially        */
/*    consistent with an empty world, so a PASS here would be the exact    */
/*    defect this checker exists to catch, one layer along.                */
/* ---------------------------------------------------------------------- */
{
  const dir = mkdtempSync(join(tmpdir(), "doc-claims-empty-"));
  mkdirSync(join(dir, "docs/rungs"), { recursive: true });
  writeFileSync(join(dir, "docs/rungs/3-deepagents.md"), DOC_PYTHON_ONLY);
  const r = run(dir);
  ok(
    "measuring NOTHING is an error, not a pass",
    r.code === 2,
    `exit ${r.code} (0 would be a clean bill of health for a repo it never read)`
  );
  ok(
    "...and says it MEASURED NOTHING, not that git was unavailable",
    /measured nothing/.test(String(r.stderr ?? "")),
    `stderr=${String(r.stderr ?? "").slice(0, 140)}`
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------- */
/* 5. A LIST ITEM IS ITS OWN CLAIM UNIT.                                   */
/*    The first version merged markdown bullets into one block and blamed  */
/*    `react` for a sentence about `deep-research` — two false findings     */
/*    from one true one.                                                    */
/* ---------------------------------------------------------------------- */
{
  const r = run(
    stage({
      fastapi: ALL,
      django: ALL,
      node: NODE_TWO,
      doc:
        "# Rung 3\n\n" +
        "- `react` — the library default.\n" +
        "- `plan-execute` — subagents.\n" +
        "- `deep-research` — **Python only**, needs web search.\n",
    })
  );
  ok(
    "a bullet's scope does not leak to its siblings",
    r.code === 0 && (r.findings ?? []).length === 0,
    `${(r.findings ?? []).length} finding(s)`
  );
}

/*
 * THE GATING RULING (#332 item 6). A documented position on whether a cell
 * withholds upstream, held against the declaration that decides it.
 *
 * The Python tripwire already fails if someone arms a cell. What it cannot see
 * is a person who arms the cell AND updates the tripwire, leaving a doc saying
 * the opposite with nothing objecting. These cases pin that half.
 */
{
  const DOC_ADVISORY =
    "The `plan-execute` topology on the `deepagents` rung is **not upstream-gated**.\n";
  const base = { fastapi: ALL, django: ALL, node: NODE_TWO };
  const gatingOf = (r) => (r.findings ?? []).filter((f) => f.kind === "gating");

  let r = run(
    stage({
      ...base,
      doc: DOC_ADVISORY,
      fastapiGated: ["react"],
      djangoGated: ["react"],
    })
  );
  ok(
    "GATING a ruling matching both planes passes",
    r.code === 0 && gatingOf(r).length === 0,
    `${(r.findings ?? []).length} finding(s)`
  );

  r = run(
    stage({
      ...base,
      doc: DOC_ADVISORY,
      fastapiGated: ["react", "plan-execute"],
      djangoGated: ["react", "plan-execute"],
    })
  );
  ok(
    "GATING arming the cell while the ruling still says advisory is REJECTED",
    r.code !== 0 && gatingOf(r).length === 2,
    `${gatingOf(r).length} gating finding(s), expected one per plane`
  );

  r = run(
    stage({
      ...base,
      doc: DOC_ADVISORY,
      fastapiGated: ["react", "plan-execute"],
      djangoGated: ["react"],
    })
  );
  ok(
    "GATING one plane armed and the other not is REPORTED, not resolved",
    r.code !== 0 &&
      gatingOf(r).length === 1 &&
      /fastapi/.test(gatingOf(r)[0].detail),
    `${gatingOf(r).length} gating finding(s)`
  );

  r = run(
    stage({
      ...base,
      doc: "The `react` topology on the `deepagents` rung is **upstream-gated**.\n",
      fastapiGated: ["react"],
      djangoGated: ["react"],
    })
  );
  ok(
    "GATING the POSITIVE form is checked too, not only the negation",
    r.code === 0 && gatingOf(r).length === 0,
    `${(r.findings ?? []).length} finding(s)`
  );

  r = run(
    stage({ ...base, doc: DOC_ADVISORY, fastapiGated: null, djangoGated: null })
  );
  ok(
    "GATING a claim about a rung declaring nothing is REJECTED, not passed over",
    r.code !== 0 &&
      gatingOf(r).length === 1 &&
      /checked against nothing/.test(gatingOf(r)[0].detail),
    `${gatingOf(r).length} gating finding(s)`
  );
}

/* -------------------------------------------------------------------------- */
/* #667: the DOMAIN, the UNASSERTABLE, and CITATION-versus-CLAIM.              */
/* -------------------------------------------------------------------------- */
{
  const base = {
    fastapi: ALL,
    django: ALL,
    node: NODE_TWO,
    doc: DOC_PYTHON_ONLY,
  };
  const extra = (dir, rel, body) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  let r;

  // THE DOMAIN. This is the regression that motivated #667's first half: a
  // one-level readdir over `docs` examines docs/*.md and DROPS docs/rungs/*.md,
  // which is a SUBSTITUTION wearing a widening's clothes. The fixture's only
  // rung doc lives one level down, so a non-recursive walk finds zero rung docs
  // and the checker's own vacuity guard fires — which is what this asserts.
  let dir = stage(base);
  extra(dir, "docs/TOP-LEVEL.md", "A doc at the top level.\n");
  r = run(dir);
  ok(
    "DOMAIN a doc one level down is still examined when docs/ is the root",
    r.code === 0 && r.docsScanned === 2,
    `docsScanned=${r.docsScanned} (want 2: docs/TOP-LEVEL.md + docs/rungs/3-deepagents.md)`
  );

  // A GITIGNORED PATH IS NOT ASSERTABLE. Whether it exists is a fact about the
  // machine. Both spellings are probed because `git check-ignore` on a bare
  // path only matches a DIRECTORY pattern once the directory exists — the same
  // build-state dependence being removed.
  dir = stage(base);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".next/\n");
  extra(dir, "docs/BUILD.md", "The cache lives at `apps/example/.next`.\n");
  const unbuilt = run(dir);
  mkdirSync(join(dir, "apps/example/.next"), { recursive: true });
  writeFileSync(join(dir, "apps/example/.next/x.json"), "{}");
  const built = run(dir);
  ok(
    "UNASSERTABLE a gitignored path is not claimed — and the verdict does NOT " +
      "depend on whether the repo has been built",
    unbuilt.code === 0 &&
      built.code === 0 &&
      unbuilt.pathsUnassertable === 1 &&
      built.pathsUnassertable === 1,
    `unbuilt=${unbuilt.code}/${unbuilt.pathsUnassertable} built=${built.code}/${built.pathsUnassertable}`
  );

  // THE POSITIVE COMPANION. Without this, the rule above is satisfied by a
  // checker that stopped asserting paths at all.
  dir = stage(base);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".next/\n");
  extra(dir, "docs/BUILD.md", "It lives at `apps/example/gone.tsx`.\n");
  r = run(dir);
  ok(
    "UNASSERTABLE ...but a NON-ignored missing path is still reported",
    r.code !== 0 && (r.findings ?? []).some((f) => f.kind === "missing-path"),
    `code=${r.code}`
  );

  // A CITATION IS NOT A CLAIM.
  dir = stage(base);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  extra(
    dir,
    "docs/CITE.md",
    "<!-- doc-claims:cite -->\nIt reported `apps/example/gone.tsx` broken. It was not.\n<!-- /doc-claims:cite -->\n"
  );
  r = run(dir);
  ok(
    "CITE a path quoted inside a cite region is not a claim",
    r.code === 0 && r.pathsCited === 1,
    `code=${r.code} cited=${r.pathsCited}`
  );

  // AND THE REGION CANNOT ROT INTO A MUTE BUTTON. The day the quoted path
  // becomes real, the region stops doing work and must be removed — otherwise
  // it sits there silently excusing a file that now exists.
  dir = stage(base);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  extra(
    dir,
    "docs/CITE.md",
    "<!-- doc-claims:cite -->\nQuoting `docs/rungs/3-deepagents.md`, which exists.\n<!-- /doc-claims:cite -->\n"
  );
  r = run(dir);
  ok(
    "CITE a region that suppresses NOTHING is an error, not a silent pass",
    r.code !== 0 &&
      (r.findings ?? []).some((f) => f.kind === "dead-cite-region"),
    `code=${r.code}`
  );

  dir = stage(base);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  extra(
    dir,
    "docs/CITE.md",
    "<!-- doc-claims:cite -->\nDangling `apps/x/gone.tsx`.\n"
  );
  r = run(dir);
  ok(
    "CITE an unclosed region is an error rather than suppressing to end-of-file",
    r.code !== 0 &&
      (r.findings ?? []).some((f) => f.kind === "unclosed-cite-region"),
    `code=${r.code}`
  );
}

{
  // OUTSIDE A GIT REPO the ignore question is unanswerable, and the checker must
  // say so rather than assume nothing is ignored — which would silently restore
  // the build-state dependence. No `git init` here, deliberately.
  const dir = stage({
    fastapi: ALL,
    django: ALL,
    node: NODE_TWO,
    doc: DOC_PYTHON_ONLY,
  });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs/BUILD.md"), "Cache at `apps/example/.next`.\n");
  const r = run(dir);
  ok(
    "REFUSAL outside a git repo the ignore question is unanswerable — exit 2, " +
      "not a guess",
    r.code === 2,
    `code=${r.code} (0 or 1 would be a verdict it could not compute)`
  );
  ok(
    "...and says the IGNORE question is what it could not answer",
    /check-ignore|gitignored/.test(
      String(r.stderr ?? "") + String(r.why ?? "")
    ),
    `stderr=${String(r.stderr ?? "").slice(0, 120)}`
  );
}

/* ── KIND 4: VERSION CONSTRAINTS (#776) ──────────────────────────────────────
 *
 * Driven through the exported function with real repo paths, so no fake tree is
 * needed and the cases exercise the same reader the checker uses.
 *
 * THE LOAD-BEARING CASE IS THE SILENT ONE. A version token in past-tense prose
 * must produce NOTHING. This tree deliberately carries true sentences about
 * versions that no longer hold — assert-single-instance.mjs records that
 * `packages/mcp` once pinned zod ^3.23.0, which `git log -S` confirms and which
 * is no longer in that file — and #900 leaves four more standing on purpose. A
 * checker that fired on those would have to be reverted the day it landed.
 */
{
  const run = (src) => {
    const findings = [];
    const stats = { examined: 0, unreadable: [] };
    versionClaims(src, "fixture.mjs", findings, stats);
    return { findings, stats };
  };

  const TRUE_CLAIM =
    '# @version-claim package.json :: "packageManager": "pnpm@9.0.0"';
  ok(
    "a marked claim whose named source CONTAINS the needle yields no finding",
    (() => {
      const r = run(TRUE_CLAIM);
      return r.findings.length === 0 && r.stats.examined === 1;
    })(),
    JSON.stringify(run(TRUE_CLAIM).findings)
  );

  ok(
    "...and one whose source does NOT contain it is a finding naming both",
    (() => {
      const r = run(
        '# @version-claim package.json :: "packageManager": "pnpm@11.4.2"'
      );
      return (
        r.findings.length === 1 &&
        r.findings[0].kind === "version-constraint" &&
        r.findings[0].detail.includes("package.json") &&
        r.findings[0].detail.includes("11.4.2")
      );
    })(),
    JSON.stringify(
      run('# @version-claim package.json :: "packageManager": "pnpm@11.4.2"')
        .findings
    )
  );

  /*
   * A MISSING SOURCE IS NOT A FALSE CLAIM. It must leave the findings list empty
   * and register on the refusal channel instead — the driver exits 2 on that, and
   * an edit instruction derived from a file nobody could read is exactly what
   * #689 forbids.
   */
  ok(
    "a marker naming a file that does not exist REFUSES rather than reporting a violation",
    (() => {
      const r = run(
        "# @version-claim apps/nope/requirements.txt :: langchain==1.3.18"
      );
      return r.findings.length === 0 && r.stats.unreadable.length === 1;
    })(),
    JSON.stringify(
      run("# @version-claim apps/nope/requirements.txt :: langchain==1.3.18")
    )
  );

  /*
   * A MARKER NAMING A DIRECTORY REFUSES THAT CLAIM AND NOTHING ELSE (#1204). `existsSync`
   * is true for a directory, so the read threw EISDIR, and the driver's catch voided every
   * claim after it in the file: a false claim went unevaluated and the run passed. Measured
   * end to end before this, a fixture with a directory claim above a false claim exited 0.
   * The false claim must still be a finding, and the directory claim must be refused.
   */
  {
    const tryRun = (src) => {
      try {
        return run(src);
      } catch (e) {
        return { threw: e?.code ?? String(e) };
      }
    };
    const r = tryRun(
      "# @version-claim packages :: anything\n" +
        '# @version-claim package.json :: "packageManager": "pnpm@11.4.2"'
    );
    ok(
      "a marker naming a DIRECTORY refuses that claim, and the false claim after it is still a finding",
      !r.threw &&
        r.stats.unreadable.length === 1 &&
        r.stats.unreadable[0].includes("names packages") &&
        r.findings.length === 1 &&
        r.findings[0].detail.includes("11.4.2"),
      JSON.stringify(r)
    );
  }

  /*
   * THE CHECKER IS INSIDE ITS OWN SUBJECT. The header spells the syntax out, and
   * the first run of this kind refused on that line, naming `<repo-relative-path>`
   * as a missing file. It was right to — the line matches in every respect except
   * being a claim. Any doc explaining the syntax hits the same thing.
   */
  ok(
    "COMPANION: an angle-bracketed placeholder is documentation, not a claim",
    (() => {
      const r = run(
        " * @version-claim <repo-relative-path> :: <exact substring>"
      );
      return (
        r.findings.length === 0 &&
        r.stats.examined === 0 &&
        r.stats.unreadable.length === 0
      );
    })(),
    JSON.stringify(
      run(" * @version-claim <repo-relative-path> :: <exact substring>")
    )
  );

  ok(
    "PAST-TENSE PROSE NAMING A VERSION IS SILENT — the whole reason coverage is opt-in",
    (() => {
      const r = run(
        " * When this file was written the tree had TWO zod copies installed, 3.25.76\n" +
          " * and 4.4.3, because `packages/mcp` pinned `zod: ^3.23.0` in `dependencies`.\n" +
          " * The then-declared floor was `langchain>=0.3.0` and CI went red."
      );
      return r.findings.length === 0 && r.stats.examined === 0;
    })(),
    JSON.stringify(run(" * packages/mcp pinned `zod: ^3.23.0`"))
  );

  /*
   * THE DOMAIN IS REAL. Every case above runs on fixtures and all of them would
   * pass over a tree with no markers at all — which is precisely the vacuous zero
   * this kind reported on its first green run, before the five claims were marked.
   */
  ok(
    "the real tree carries marked claims, so a passing run is not vacuous",
    (() => {
      const findings = [];
      const stats = { examined: 0, unreadable: [] };
      for (const f of [
        "scripts/format.mjs",
        "pnpm-workspace.yaml",
        ".github/dependabot.yml",
        ".github/workflows/ci.yml",
      ]) {
        versionClaims(
          readFileSync(join(HERE, "..", f), "utf8"),
          f,
          findings,
          stats
        );
      }
      return (
        stats.examined >= 4 &&
        findings.length === 0 &&
        stats.unreadable.length === 0
      );
    })(),
    "no marked claim found in the tree, so every case above asserted nothing"
  );
}

/* ---------------------------------------------------------------------- */
/* A REFUSAL NO LONGER HIDES A FINDING IN THE SAME RUN (#1208).            */
/* ---------------------------------------------------------------------- */
{
  // DEV1's case on #1208: a claim naming a missing path, and a FALSE claim whose source IS
  // read, in one file under a claim root. Everything else is the control tree above.
  const withClaims = (claims) => {
    const dir = stage({
      fastapi: ALL,
      django: ALL,
      node: NODE_TWO,
      doc: DOC_PYTHON_ONLY,
    });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "fixture", packageManager: "pnpm@9.0.0" },
        null,
        2
      ) + "\n"
    );
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "zz-claims.mjs"),
      claims.map((c) => `// @version-claim ${c}`).join("\n") + "\n"
    );
    return dir;
  };
  const human = (dir) => {
    try {
      const out = execFileSync(process.execPath, [CHECKER], {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      return {
        code: e.status ?? -1,
        out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      };
    }
  };
  const MISSING = "no-such-path-1208 :: anything";
  const FALSE = 'package.json :: "packageManager": "pnpm@0.0.0-planted"';
  const n = (x) => (x ?? []).length;

  const both = run(withClaims([MISSING, FALSE]));
  ok(
    "#1208: a refusal AND a false claim in one run exits 1, and the finding is shown",
    both.code === 1 && n(both.findings) === 1,
    `exit ${both.code}, ${n(both.findings)} finding(s)`
  );
  ok(
    "#1208: ...and the refusal is still named: COULD NOT CHECK on stderr, `unreadable` in --json",
    /COULD NOT CHECK/.test(both.stderr) &&
      both.stderr.includes("no-such-path-1208") &&
      n(both.unreadable) === 1,
    `unreadable=${JSON.stringify(both.unreadable)}`
  );
  const reversed = run(withClaims([FALSE, MISSING]));
  ok(
    "#1208: ...in either order in the file",
    reversed.code === 1 &&
      n(reversed.findings) === 1 &&
      n(reversed.unreadable) === 1,
    `exit ${reversed.code}, ${n(reversed.findings)} finding(s), ${n(
      reversed.unreadable
    )} unreadable`
  );
  const refusalOnly = run(withClaims([MISSING]));
  ok(
    "#1208 control: a refusal alone is still exit 2, and its --json now names it",
    refusalOnly.code === 2 &&
      n(refusalOnly.findings) === 0 &&
      n(refusalOnly.unreadable) === 1,
    `exit ${refusalOnly.code}, unreadable=${JSON.stringify(
      refusalOnly.unreadable
    )}`
  );
  const falseOnly = run(withClaims([FALSE]));
  ok(
    "#1208 control: a false claim alone is still exit 1, with nothing unreadable",
    falseOnly.code === 1 &&
      n(falseOnly.findings) === 1 &&
      n(falseOnly.unreadable) === 0,
    `exit ${falseOnly.code}`
  );
  const h = human(withClaims([MISSING]));
  ok(
    "#1208: a refused run in HUMAN mode does not print the PASS line",
    h.code === 2 &&
      /COULD NOT CHECK/.test(h.out) &&
      !/PASS: every mechanically-checkable claim/.test(h.out),
    `exit ${
      h.code
    }, PASS line printed: ${/PASS: every mechanically-checkable claim/.test(
      h.out
    )}`
  );
}

console.log(
  failures === 0
    ? "\nPASS: the checker was watched failing on BOTH mutations — the edited doc\n" +
        "      and, with the doc untouched, the closed divergence. And on a gating\n" +
        "      ruling in both directions: the doc edited away from the declaration,\n" +
        "      and the declaration armed away from the doc — plus a rung that\n" +
        "      declares nothing, which is refused rather than passed over."
    : `\nFAIL: ${failures} check(s) failed. Do not trust this checker's output.`
);
process.exit(failures === 0 ? 0 : 1);
