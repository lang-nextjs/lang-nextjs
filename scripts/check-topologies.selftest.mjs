#!/usr/bin/env node
/**
 * Prove check-topologies can fail — in both directions — and that it stays
 * silent where it should.
 *
 * PLANT, DON'T BORROW. Every fixture is synthesised in a temp dir with rung
 * ids that name nothing in this ladder ("alpha", "beta"). Borrowing a real
 * rung name would couple this test to the manifest it is meant to police, and
 * would break the moment the ladder changed — the trap that made a `shared`
 * fixture reference `open-swe` and refuse to eject.
 *
 * Case 7 is the one that makes the other six mean anything: a pair that
 * declares NO topologies must be skipped, not flagged. Without it, a checker
 * that refused everything would score 6/6.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { check, topologyKeysInSource } from "./check-topologies.mjs";

let pass = 0,
  fail = 0;

function sandbox(manifest, files) {
  const root = mkdtempSync(path.join(tmpdir(), "topo-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const mp = path.join(root, "rungs.json");
  writeFileSync(mp, JSON.stringify(manifest, null, 2));
  return { root, mp };
}

function mod(keys) {
  return `TOPOLOGIES = {\n${keys
    .map((k) => `    "${k}": stream_${k.replace(/-/g, "_")},`)
    .join("\n")}\n}\n`;
}

/**
 * The TYPESCRIPT spelling of the same table (#360).
 *
 * Deliberately reproduces the two things that made apps/node-backend's real
 * declarations unreadable to the original parser: the `= {` sits several lines
 * below the name because of a multi-line type annotation, and a key is quoted
 * ONLY when it is not a valid identifier — so `react:` and `"plan-execute":`
 * appear in one table.
 *
 * Written as a fixture rather than by pointing at the real file: a selftest
 * that reads production source passes or fails for reasons outside its own
 * control, and this one has to keep meaning something after those files move.
 */
function tsMod(keys) {
  const body = keys
    .map((k) =>
      /^[A-Za-z_$][\w$]*$/.test(k)
        ? `  ${k}: streamChat${k},`
        : `  "${k}": streamChat,`
    )
    .join("\n");
  return (
    "export const TOPOLOGIES: Record<\n" +
    "  string,\n" +
    "  (messages: ChatMessage[]) => AsyncGenerator<string>\n" +
    `> = {\n${body}\n};\n`
  );
}

function it(name, expectRefuse, manifest, files) {
  const { root, mp } = sandbox(manifest, files);
  try {
    const { problems } = check(mp, root);
    const refused = problems.length > 0;
    const ok = refused === expectRefuse;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${name.padEnd(52)} (${
        refused ? "refused: " + problems[0].slice(0, 60) : "accepted"
      })`
    );
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`  FAIL ${name} — threw: ${e.message}`);
    fail++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SRC = "backends/alpha.py";
const withSource = (topologies, source = SRC) => ({
  rungs: [
    {
      id: "alpha",
      runtimes: { django: { topologies, topologiesSource: source } },
    },
  ],
});

console.log(
  "check-topologies self-test — refuses what it must, accepts what it should\n"
);

it(
  "declared but absent from the module",
  true,
  withSource(["react", "deep-research"]),
  {
    [SRC]: mod(["react"]),
  }
);

it("present in the module but undeclared", true, withSource(["react"]), {
  [SRC]: mod(["react", "plan-execute"]),
});

it(
  "no topologiesSource named at all",
  true,
  {
    rungs: [{ id: "alpha", runtimes: { django: { topologies: ["react"] } } }],
  },
  {}
);

it(
  "topologiesSource points at a missing file",
  true,
  withSource(["react"], "backends/gone.py"),
  {
    [SRC]: mod(["react"]),
  }
);

it("module has no TOPOLOGIES dict", true, withSource(["react"]), {
  [SRC]: "def stream_react(m):\n    pass\n",
});

it(
  "unterminated TOPOLOGIES dict is refused, not guessed",
  true,
  withSource(["react"]),
  {
    [SRC]: 'TOPOLOGIES = {\n    "react": stream_react,\n',
  }
);

it("matching sets are accepted", false, withSource(["react", "plan-execute"]), {
  [SRC]: mod(["react", "plan-execute"]),
});

// THE CASE THAT STOPS A REFUSE-EVERYTHING CHECKER SCORING FULL MARKS.
it(
  "a runtime declaring no topologies is SKIPPED, not flagged",
  false,
  {
    rungs: [{ id: "beta", runtimes: { node: { topologies: [] } } }],
  },
  {}
);

/*
 * THE TYPESCRIPT PLANE (#360).
 *
 * These four exist because the parser silently reported EVERY node pair as "no
 * module-level TOPOLOGIES dict" — a truthful manifest reported as claiming
 * topologies against a file that declares none. Nine Python cases passed
 * throughout: the suite was complete over one language and blind to the other,
 * and nothing in it could say so.
 */
const TS_SRC = "backends/alpha.ts";
const withTsSource = (topologies, source = TS_SRC) => ({
  rungs: [
    {
      id: "alpha",
      runtimes: { node: { topologies, topologiesSource: source } },
    },
  ],
});

it(
  "a TypeScript module that AGREES is accepted",
  false,
  withTsSource(["react", "plan-execute"]),
  { [TS_SRC]: tsMod(["react", "plan-execute"]) }
);

it(
  "TS: declared but missing from the module is refused",
  true,
  withTsSource(["react", "plan-execute", "deep-research"]),
  { [TS_SRC]: tsMod(["react", "plan-execute"]) }
);

it(
  "TS: in the module but not declared is refused",
  true,
  withTsSource(["react"]),
  { [TS_SRC]: tsMod(["react", "plan-execute"]) }
);

it(
  "TS: an UNQUOTED key is read — the branch Python never needed",
  true,
  // `react` is unquoted in TypeScript because it is a valid identifier. If the
  // key pattern still required quotes, the module would read as declaring only
  // "plan-execute" and this case would be refused for the WRONG reason — so it
  // is paired with the accepting case above, which fails if unquoted keys are
  // dropped.
  withTsSource(["react"]),
  { [TS_SRC]: tsMod(["reactx"]) }
);

// Direct unit check on the extractor's contract: absent vs empty must differ.
{
  const none = topologyKeysInSource("x = 1\n");
  const empty = topologyKeysInSource("TOPOLOGIES = {\n}\n");
  // The TS shape must also distinguish absent from empty, or "no table" and
  // "a table declaring nothing" collapse on the plane that has both.
  const tsEmpty = topologyKeysInSource(
    "export const TOPOLOGIES: Record<string, X> = {\n}\n"
  );
  const tsNone = topologyKeysInSource("export const OTHER = {\n}\n");
  const ok =
    none === null &&
    Array.isArray(empty) &&
    empty.length === 0 &&
    tsNone === null &&
    Array.isArray(tsEmpty) &&
    tsEmpty.length === 0;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${"absent dict is null, empty dict is []".padEnd(
      52
    )} (${
      ok ? "distinguished" : `none=${none} empty=${JSON.stringify(empty)}`
    })`
  );
  ok ? pass++ : fail++;
}

console.log(
  `\n${fail === 0 ? "PASS" : "FAIL"}: ${pass}/${pass + fail} cases. ` +
    (fail === 0
      ? "check-topologies refuses both directions of disagreement and spares a pair with nothing declared."
      : "the check is NOT trustworthy.")
);
process.exit(fail === 0 ? 0 : 1);
