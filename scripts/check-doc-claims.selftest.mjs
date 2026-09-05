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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "check-doc-claims.mjs");

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
 * CARRIES stderr, because an exit code cannot attribute a failure (#767). On exit 2
 * the checker prints no JSON, so `parsed` is empty and the code was the ONLY thing a
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
      /* exit 2 prints no JSON */
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
