#!/usr/bin/env node
/**
 * Prove the agreement check can fail, in every direction it claims to (#454).
 *
 * PLANT, DON'T BORROW. Every fixture is a temp tree. The real one passes today,
 * so borrowing it would produce a selftest that is green because the repo is
 * healthy rather than because the checker works — and it would go quiet the day
 * someone edits rung 4's tests for an unrelated reason.
 *
 * TWO CASES CARRY THE DESIGN, and without them a wrong checker scores full
 * marks on the rest:
 *
 *   CASE 5 — rung 4 naming an id rung 5 does NOT declare must PASS. `agent` is
 *            the bundled single-run backend and is not an upstream graph. A
 *            checker asserting SET EQUALITY satisfies every other case here and
 *            fails this one, which is the whole reason the direction is
 *            "rung 5's ids are all named" and not "the sets match".
 *
 *   CASE 9 — an id that appears only in an unrelated string must NOT count. A
 *            checker that collected every string literal in the file would pass
 *            cases 1-8 while being unable to notice a rename that happened to
 *            reuse a word already in the file.
 *
 * CASE 7 is what makes the fork skip honest: a check that skipped whenever it
 * felt like it would satisfy case 6 and prove nothing.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  check,
  RUNG5_LANGGRAPH,
  RUNG4_ROOT,
} from "./assert-graph-id-fixture-agreement.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "assert-graph-id-fixture-agreement.mjs");
let pass = 0,
  fail = 0;

function tree({ graphs, files }) {
  const root = mkdtempSync(path.join(tmpdir(), "graphid-"));
  if (graphs !== null) {
    const abs = path.join(root, RUNG5_LANGGRAPH);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify({ node_version: "20", graphs }, null, 2));
  }
  for (const [rel, body] of Object.entries(files ?? {})) {
    const abs = path.join(root, RUNG4_ROOT, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** A fixture in the shape #423 actually wrote. */
const fixture = (ids) =>
  `import { it } from "vitest";
const OPEN_SWE = [
${ids.map((i) => `  { graph_id: "${i}" },`).join("\n")}
];
it("multi-graph", () => {
  renderFor(OPEN_SWE);
});
`;

const graphsOf = (ids) =>
  Object.fromEntries(ids.map((i) => [i, `./src/graphs/${i}/index.ts:graph`]));

function run(root) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CHECKER], {
        cwd: root,
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function expectExit(name, spec, wantCode, mustMention) {
  const root = tree(spec);
  try {
    const { code, out } = run(root);
    const ok = code === wantCode && (!mustMention || out.includes(mustMention));
    if (ok) {
      pass++;
      console.log(`  ok   ${name} -> exit ${code}`);
    } else {
      fail++;
      console.error(
        `  FAIL ${name}\n       want exit ${wantCode}${
          mustMention ? ` mentioning "${mustMention}"` : ""
        }` + `\n       got  exit ${code}: ${out.trim().slice(0, 220)}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("assert-graph-id-fixture-agreement selftest");

// The control: the shape that is true today.
expectExit(
  "0 CONTROL: fixture names every declared graph",
  {
    graphs: graphsOf(["alpha", "beta", "gamma"]),
    files: { "a.test.tsx": fixture(["alpha", "beta", "gamma"]) },
  },
  0,
  "PASS"
);

// 1. THE HEADLINE. Upstream renames a graph; the fixture is untouched and stale.
expectExit(
  "1 upstream RENAMES a graph -> fails naming the new id",
  {
    graphs: graphsOf(["alpha", "beta", "delta"]),
    files: { "a.test.tsx": fixture(["alpha", "beta", "gamma"]) },
  },
  1,
  "delta"
);

// 2. Upstream grows. Updating the fixture is the correct response, consciously.
expectExit(
  "2 upstream ADDS a graph the fixture does not name -> fails",
  {
    graphs: graphsOf(["alpha", "beta", "gamma", "epsilon"]),
    files: { "a.test.tsx": fixture(["alpha", "beta", "gamma"]) },
  },
  1,
  "epsilon"
);

// 3. THE PREMISE, which agreement alone cannot see: every id still matches.
expectExit(
  "3 upstream collapses to ONE graph -> fails on the premise, not on agreement",
  {
    graphs: graphsOf(["alpha"]),
    files: { "a.test.tsx": fixture(["alpha"]) },
  },
  1,
  "models a backend that no longer exists"
);

// 4. FAILS CLOSED on its own extraction: ids present but in a position it cannot read.
expectExit(
  "4 fixture restructured beyond recognition -> fails, does not pass over nothing",
  {
    graphs: graphsOf(["alpha", "beta"]),
    files: {
      "a.test.tsx": `import { it } from "vitest";
const OPEN_SWE = mkAssistants("alpha", "beta");
it("multi-graph", () => { renderFor(OPEN_SWE); });
`,
    },
  },
  1,
  "THE CHECK WENT BLIND"
);

// 5. THE DIRECTION. An id rung 4 invents for another backend is not required.
expectExit(
  "5 rung 4 names an EXTRA id rung 5 never declares -> passes",
  {
    graphs: graphsOf(["alpha", "beta"]),
    files: { "a.test.tsx": fixture(["alpha", "beta", "bundled-only"]) },
  },
  0,
  "PASS"
);

// 6-7. The fork, and the case that keeps the fork branch honest.
expectExit(
  "6 rung 5 ejected -> skips, and says which file is absent",
  { graphs: null, files: { "a.test.tsx": fixture(["alpha"]) } },
  0,
  "SKIPPED"
);
expectExit(
  "7 rung 5 present -> does NOT skip (makes case 6 mean something)",
  {
    graphs: graphsOf(["alpha", "beta"]),
    files: { "a.test.tsx": fixture(["alpha"]) },
  },
  1,
  "beta"
);

// 8. Malformed upstream manifest: refuse, do not report agreement.
expectExit(
  "8 rung 5 manifest has no graphs object -> REFUSES (exit 2)",
  { graphs: undefined, files: { "a.test.tsx": fixture(["alpha"]) } },
  2,
  "REFUSING"
);

// 9. PRECISION. A collect-every-string checker would pass this; it must not.
expectExit(
  "9 an id in an unrelated string does not count as naming it",
  {
    graphs: graphsOf(["alpha", "beta"]),
    files: {
      "a.test.tsx": `import { it } from "vitest";
const label = "beta";
const OPEN_SWE = [{ graph_id: "alpha" }];
it("x", () => { renderFor(OPEN_SWE, label); });
`,
    },
  },
  1,
  "beta"
);

// 10. The exported surface agrees with the CLI, so callers and CI see one answer.
{
  const root = tree({
    graphs: graphsOf(["alpha", "beta"]),
    files: { "a.test.tsx": fixture(["alpha", "beta"]) },
  });
  try {
    const r = await check({ cwd: root });
    const ok =
      r.forked === false && r.missing.length === 0 && r.declared.length === 2;
    ok ? pass++ : fail++;
    console.log(
      ok
        ? "  ok   10 check() returns the same verdict the CLI prints"
        : `  FAIL 10 check() disagreed: ${JSON.stringify(r)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
