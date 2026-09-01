#!/usr/bin/env node
/**
 * RUNG 4'S MULTI-GRAPH FIXTURE AND RUNG 5'S REAL GRAPHS STAY IN STEP (#454).
 *
 * #423 taught the run view to say whether it is showing the whole agent or one
 * third of it, and it tests that against two backend RESPONSES rather than two
 * live backends — which is right. The graph ids in those responses ("alpha",
 * "beta", "gamma") are copied from rung 5's langgraph.json, which is
 * real and in this tree.
 *
 * RUNG 4 MUST NOT READ THAT FILE. An import edge from rung 4 to rung 5 breaks
 * the moment `eject open-swe` deletes rung 5, so the ids are literals on
 * purpose. RunTopologyNotice.test.tsx says exactly this in its own docstring —
 * "nothing asserts they stay in step with rung 5. If upstream renames a graph
 * this fixture goes stale silently. That is a narrower gap than the one it
 * closes, and it is a gap." A gap someone wrote down is still a gap; this is
 * that paragraph with a check behind it.
 *
 * THIS ASSERTS AGREEMENT, IT DOES NOT CREATE A REFERENCE. The literals stay
 * literals and rung 4 gains no dependency; a checker at the repo root, where
 * both trees are visible, reads each side separately and compares. Making the
 * test read rung 5's file at run time would reintroduce the exact coupling the
 * literals exist to avoid.
 *
 * THE DIRECTION IS DELIBERATE, AND THE OBVIOUS ONE IS WRONG.
 *
 * Not "every graph id in rung 4 is declared by rung 5" — rung 4 also fixtures
 * `{ graph_id: "bundled-only" }`, the BUNDLED single-run backend, which is not an
 * upstream Open SWE graph and never should be. That direction flags it and
 * needs an allowlist, and an allowlist is one more thing that rots.
 *
 * So: EVERY GRAPH RUNG 5 DECLARES MUST BE NAMED BY RUNG 4'S FIXTURE. A rename
 * upstream produces an id the fixture does not have and fails. An id rung 4
 * invents for a different backend is simply never required, so it needs no
 * exception.
 *
 * IT ALSO FAILS CLOSED ON ITS OWN EXTRACTION. If the fixture is restructured so
 * the positions below stop matching, the extracted set is EMPTY, and "rung 5's
 * ids are all present" is false for every id — a loud failure naming the file,
 * not a confident pass over nothing. That is the whole reason this direction was
 * chosen over the readable one.
 *
 * THE PREMISE IS CHECKED SEPARATELY. If upstream collapses to a single graph,
 * every id still agrees and the multi-graph fixture models a backend that no
 * longer exists. Agreement cannot see that, so the count is its own claim.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
/** Where each side lives. Both are read; neither is imported by the other. */
export const RUNG5_LANGGRAPH =
  "rungs/5-software-developer-agent/langgraph.json";
export const RUNG4_ROOT = "apps/open-swe";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);
const TEST_FILE = /\.(test|spec)\.(m?[jt]sx?)$/;

/** The graphs rung 5 actually registers, from its own manifest. */
export function graphsDeclaredByRung5(cwd) {
  const abs = path.join(cwd, RUNG5_LANGGRAPH);
  if (!existsSync(abs)) return null; // ejected — the caller says so out loud
  const doc = JSON.parse(readFileSync(abs, "utf8"));
  const graphs = doc && typeof doc === "object" ? doc.graphs : null;
  if (!graphs || typeof graphs !== "object" || Array.isArray(graphs)) {
    throw new Error(`${RUNG5_LANGGRAPH} has no \`graphs\` object to read`);
  }
  return Object.keys(graphs).sort();
}

function testFilesUnder(cwd, root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (TEST_FILE.test(e.name)) out.push(path.relative(cwd, abs));
    }
  };
  const abs = path.join(cwd, root);
  try {
    if (statSync(abs).isDirectory()) walk(abs);
  } catch {
    /* absent root: the caller distinguishes this from an empty one */
  }
  return out.sort();
}

/**
 * Graph ids named by rung 4's fixtures, from two positions:
 *
 *   { graph_id: "alpha" }                     — an assistants/search row
 *   graphs: ["alpha", "beta"]              — a BackendTopology value
 *
 * Deliberately NOT "every string literal in the file": over-collecting would
 * let an unrelated word satisfy a renamed graph id and turn this into a check
 * that cannot fail. Under-collecting is the safe direction here — see the
 * fails-closed note above.
 */
export async function graphIdsNamedByRung4(file, source) {
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found = new Set();
  const strings = (node) =>
    ts.isArrayLiteralExpression(node)
      ? node.elements.filter(ts.isStringLiteral).map((e) => e.text)
      : [];
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name)) {
      const key = n.name.getText(sf).replace(/['"]/g, "");
      if (key === "graph_id" && ts.isStringLiteral(n.initializer)) {
        found.add(n.initializer.text);
      }
      if (key === "graphs")
        for (const s of strings(n.initializer)) found.add(s);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export async function check({ cwd = process.cwd() } = {}) {
  const declared = graphsDeclaredByRung5(cwd);
  if (declared === null) return { forked: true };

  const files = testFilesUnder(cwd, RUNG4_ROOT);
  const named = new Map(); // id -> files that name it
  for (const rel of files) {
    const ids = await graphIdsNamedByRung4(
      rel,
      readFileSync(path.join(cwd, rel), "utf8")
    );
    for (const id of ids) named.set(id, [...(named.get(id) ?? []), rel]);
  }
  const missing = declared.filter((g) => !named.has(g));
  return { forked: false, declared, named, files, missing };
}

async function main() {
  const cwd = process.cwd();
  let r;
  try {
    r = await check({ cwd });
  } catch (e) {
    console.error(
      `REFUSING: could not compare the fixture with rung 5 — ${e.message}`
    );
    process.exit(2);
  }

  if (r.forked) {
    // NOT A SILENT SKIP. Rung 5 is gone, so there is no upstream in this tree to
    // agree with and the question does not arise — which is a different thing
    // from the check having run and found nothing. Said out loud so a fork's log
    // cannot be mistaken for a full ladder's.
    console.log(
      `SKIPPED: ${RUNG5_LANGGRAPH} is not in this tree, so rung 5 was ejected ` +
        `and there is no upstream manifest to agree with. On a full ladder this ` +
        `check runs; the selftest proves it does not skip there.`
    );
    process.exit(0);
  }

  const { declared, named, files, missing } = r;

  if (declared.length === 0) {
    console.error(`REFUSING: ${RUNG5_LANGGRAPH} declares no graphs at all.`);
    process.exit(2);
  }

  // THE PREMISE, checked before the agreement. If upstream ever collapses to one
  // graph, every id below still agrees and the multi-graph fixture models a
  // backend that stopped existing. Agreement cannot see that.
  if (declared.length < 2) {
    console.error(
      `FAIL: rung 5 now declares ONE graph (${declared[0]}), so the multi-graph ` +
        `fixture in rung 4 models a backend that no longer exists. The premise ` +
        `of #423's notice has expired — decide whether the notice still has a ` +
        `case to serve before updating the fixture.`
    );
    process.exit(1);
  }

  /*
   * AN EMPTY EXTRACTION IS ITS OWN DIAGNOSIS, not a rename.
   *
   * Both produce "these graphs are named nowhere", and they call for opposite
   * actions: a rename means edit the fixture, an empty extraction means this
   * checker went blind and must be taught the new position. Reporting them with
   * one message would leave a reader editing literals that were never the
   * problem — and it would make the selftest's two cases indistinguishable,
   * which is how a case stops being worth having.
   */
  if (named.size === 0) {
    console.error(
      `FAIL: rung 4's fixtures name NO graph ids at all, so nothing here can ` +
        `agree with rung 5.\n\n  rung 5 declares: ${declared.join(", ")}\n\n` +
        `  Either #423's fixture is gone, or it was restructured so this check\n` +
        `  can no longer read it — it looks for \`graph_id: "..."\` and\n` +
        `  \`graphs: [...]\` under ${RUNG4_ROOT}. THE CHECK WENT BLIND; it fails\n` +
        `  rather than reporting agreement over an empty extraction, which is the\n` +
        `  silent staleness it exists to prevent. Teach it the new position.`
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `FAIL: ${missing.length} graph(s) declared by rung 5 are named nowhere in ` +
        `rung 4's fixtures, so the fixture no longer models the real backend:\n`
    );
    for (const g of missing) console.error(`    ${g}  (in ${RUNG5_LANGGRAPH})`);
    console.error(
      `\n  rung 5 declares: ${declared.join(", ")}\n` +
        `  rung 4 names:    ${
          [...named.keys()].sort().join(", ") || "(nothing)"
        }\n\n` +
        `  If upstream RENAMED a graph, update the literals in rung 4's fixtures\n` +
        `  in the same change — do NOT make the test read rung 5's file, which is\n` +
        `  the coupling the literals exist to avoid.\n` +
        `  If rung 4's fixture was restructured so these ids are no longer written\n` +
        `  as \`graph_id: "..."\` or \`graphs: [...]\`, this check stopped being able\n` +
        `  to see them and must be taught the new position — it fails rather than\n` +
        `  passing precisely so that cannot go unnoticed.`
    );
    process.exit(1);
  }

  console.log(
    `PASS: all ${declared.length} graphs rung 5 declares (${declared.join(
      ", "
    )}) ` +
      `are named by rung 4's fixtures across ${files.length} test files; rung 4 ` +
      `names ${named.size} id(s) total (${[...named.keys()]
        .sort()
        .join(", ")}) — ` +
      `the extra ones are other backends and are not required to match.`
  );
}

if (invokedAsProgram(import.meta.url)) await main();
