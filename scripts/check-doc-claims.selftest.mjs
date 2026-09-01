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

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER, "--json"], {
      cwd: dir,
      encoding: "utf-8",
    });
    return { code: 0, ...JSON.parse(out) };
  } catch (e) {
    let parsed = {};
    try {
      parsed = JSON.parse(e.stdout ?? "{}");
    } catch {
      /* exit 2 prints no JSON */
    }
    return { code: e.status ?? -1, ...parsed };
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
