#!/usr/bin/env node
/**
 * Prove the doc-claim check can fail, in each direction it claims to (#468).
 *
 * PLANT, DON'T BORROW. Every fixture is a temp tree. The real docs agree with
 * upstream today, so borrowing them would produce a selftest that is green
 * because the repo is healthy rather than because the checker works — and #468
 * was HELD partly on the objection that a fix built now needs a synthetic
 * fixture. It would need one either way: a selftest that reads production docs
 * passes or fails for reasons outside its own control.
 *
 * CASES 4 AND 5 ARE THE PAIR THAT MAKES "BOTH HALVES" REAL, and each kills a
 * different half-checker:
 *
 *   4  right names, WRONG COUNT   — "two graphs (manager, planner, programmer)"
 *      A names-only checker passes this.
 *   5  right count, WRONG NAMES   — "three graphs (manager, planner, sculptor)"
 *      A count-only checker passes this.
 *
 * CASE 6 IS THE VACUITY FLOOR: a tree whose docs state no claim must REFUSE, not
 * report agreement. A checker that found nothing and a checker that searched
 * wrong print the same word, and this one's whole subject is a sentence someone
 * may reword at any time.
 *
 * CASE 12 PINS THE SUBJECT BOUNDARY. Code comments restate this list too, and
 * guarding them would manufacture a coupling — in those the names are
 * illustration and the fix is deletion, tracked separately. If someone widens
 * the scan to .ts, this case goes red and the decision gets made deliberately.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, RUNG5_LANGGRAPH } from "./assert-graph-list-doc-claim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "assert-graph-list-doc-claim.mjs");
let pass = 0,
  fail = 0;

function tree({ graphs, files }) {
  const root = mkdtempSync(path.join(tmpdir(), "doclist-"));
  if (graphs !== null) {
    const abs = path.join(root, RUNG5_LANGGRAPH);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify({ node_version: "20", graphs }, null, 2));
  }
  for (const [rel, body] of Object.entries(files ?? {})) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}
const graphsOf = (ids) =>
  Object.fromEntries(ids.map((i) => [i, `./g/${i}:graph`]));
const doc = (count, names) =>
  `# Topology\n\nReal Open SWE registers **${count}** graphs (${names
    .map((n) => `\`${n}\``)
    .join(", ")})\nand they do **not share a run**.\n`;

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
    ok ? pass++ : fail++;
    console.log(
      ok
        ? `  ok   ${name} -> exit ${code}`
        : `  FAIL ${name}\n       want exit ${wantCode}${
            mustMention ? ` mentioning "${mustMention}"` : ""
          }\n       got  exit ${code}: ${out.trim().slice(0, 200)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const THREE = ["manager", "planner", "programmer"];
console.log("assert-graph-list-doc-claim selftest");

expectExit(
  "0  CONTROL: doc agrees with upstream",
  { graphs: graphsOf(THREE), files: { "docs/a.md": doc("three", THREE) } },
  0,
  "PASS"
);

expectExit(
  "1  upstream RENAMES a graph -> names disagree",
  {
    graphs: graphsOf(["manager", "planner", "coder"]),
    files: { "docs/a.md": doc("three", THREE) },
  },
  1,
  "[names]"
);

expectExit(
  "2  upstream ADDS a graph -> count AND names disagree",
  {
    graphs: graphsOf([...THREE, "reviewer"]),
    files: { "docs/a.md": doc("three", THREE) },
  },
  1,
  "[count]"
);

expectExit(
  "3  doc RIGHT names, WRONG count -> a names-only checker passes this",
  { graphs: graphsOf(THREE), files: { "docs/a.md": doc("two", THREE) } },
  1,
  "says 2, upstream declares 3"
);

expectExit(
  "4  doc RIGHT count, WRONG names -> a count-only checker passes this",
  {
    graphs: graphsOf(THREE),
    files: { "docs/a.md": doc("three", ["manager", "planner", "sculptor"]) },
  },
  1,
  "[names]"
);

expectExit(
  "5  the list WRAPS across lines -> the whole list is read, not one line",
  {
    graphs: graphsOf(THREE),
    files: {
      "docs/a.md":
        "Real Open SWE registers three graphs (manager, planner,\nprogrammer) that do not share a run.\n",
    },
  },
  0,
  "PASS"
);

expectExit(
  "6  VACUITY FLOOR: no claim anywhere -> REFUSES, does not report agreement",
  {
    graphs: graphsOf(THREE),
    files: { "docs/a.md": "# Nothing about graphs here.\n" },
  },
  2,
  "REFUSING"
);

expectExit(
  "7  count word unreadable -> REFUSES rather than skipping the claim",
  {
    graphs: graphsOf(THREE),
    files: {
      "docs/a.md":
        "Real Open SWE registers several graphs (manager, planner, programmer).\n",
    },
  },
  2,
  "not a number"
);

expectExit(
  "8  unclosed list -> REFUSES rather than comparing half a list",
  {
    graphs: graphsOf(THREE),
    files: {
      "docs/a.md": "Real Open SWE registers three graphs (manager, planner\n",
    },
  },
  2,
  "no closed"
);

expectExit(
  "9  rung 5 ejected -> SKIPS and names the absent file",
  { graphs: null, files: { "docs/a.md": doc("three", THREE) } },
  0,
  "SKIPPED"
);

expectExit(
  "10 rung 5 present -> does NOT skip (makes case 9 mean something)",
  { graphs: graphsOf(THREE), files: { "docs/a.md": doc("two", THREE) } },
  1,
  "[count]"
);

expectExit(
  "11 SUBJECT BOUNDARY: a wrong claim in .ts is NOT scanned",
  {
    graphs: graphsOf(THREE),
    files: {
      "docs/a.md": doc("three", THREE),
      "src/x.ts":
        "/* Real Open SWE registers three graphs (manager/planner/sculptor). */\n",
    },
  },
  0,
  "PASS"
);

expectExit(
  "12 digits work as well as words -> '3' is not an unreadable count",
  {
    graphs: graphsOf(THREE),
    files: {
      "docs/a.md":
        "Real Open SWE registers 3 graphs (manager, planner, programmer).\n",
    },
  },
  0,
  "PASS"
);

// The exported surface and the CLI must agree, so callers and CI see one answer.
{
  const root = tree({
    graphs: graphsOf(THREE),
    files: { "docs/a.md": doc("three", THREE) },
  });
  try {
    const r = check({ cwd: root });
    const ok =
      r.forked === false && r.problems.length === 0 && r.claims.length === 1;
    ok ? pass++ : fail++;
    console.log(
      ok
        ? "  ok   13 check() returns the same verdict the CLI prints"
        : `  FAIL 13 check() disagreed: ${JSON.stringify(r)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
