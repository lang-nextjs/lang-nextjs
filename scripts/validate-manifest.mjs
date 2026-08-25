#!/usr/bin/env node
/**
 * validate-manifest.mjs — CHECK-0: rungs.json validates against rungs.schema.json.
 *
 * WHY THIS EXISTS, AND WHY ITS FIRST CASE IS AN *ACCEPT*.
 *
 * This gate was missing, and its absence produced exactly the defect this issue exists to
 * remove. rungs.json grew a `docs` plane under `owns`; the schema still declared
 * `additionalProperties: false` with only `{ts, py}`. So the schema rejected the real manifest —
 * and therefore rejected EVERY document, valid or not.
 *
 * DEV7 caught it while testing the schema's prohibition on stream-topology fields. Injecting
 * threadId / runId / streamUrl / graphs all produced "rejected", and the guard looked like it
 * was working. It was not working; it was rejecting everything indiscriminately.
 *
 *     Property:  "the schema forbids stream topology."
 *     What would make a check pass while that is violated?  The schema forbids EVERYTHING.
 *
 * A validator that rejects all inputs is indistinguishable from one that rejects the right
 * inputs — unless something asserts that a KNOWN-GOOD document is ACCEPTED. That is why the
 * baseline-accept case below is not a formality; it is the case that tells the two apart, and
 * every reject case is meaningless without it.
 *
 * Same lesson as the four dist checks, arrived at from the opposite direction: those failed
 * open and could never reject; this failed closed and could never accept. Both report a
 * confident verdict they did not compute.
 *
 * Usage: node scripts/validate-manifest.mjs [--selftest]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const schema = JSON.parse(
  readFileSync(join(ROOT, "scripts", "rungs.schema.json"), "utf8")
);
const manifest = JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8"));

function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmt = (errs) =>
  (errs || [])
    .map(
      (e) =>
        `    ${e.instancePath || "/"} ${e.message}` +
        (e.params?.additionalProperty
          ? ` {${e.params.additionalProperty}}`
          : "")
    )
    .join("\n");

// --------------------------------------------------------------------------------------------
if (!process.argv.includes("--selftest")) {
  const validate = makeValidator();
  if (!validate(manifest)) {
    console.error(
      "FAIL: rungs.json does not validate against rungs.schema.json:"
    );
    console.error(fmt(validate.errors));
    process.exit(1);
  }
  console.log("PASS: rungs.json validates against rungs.schema.json");
  process.exit(0);
}

// --------------------------------------------------------------------------------------------
// Self-test: prove the schema accepts the truth AND rejects each forbidden shape.
let pass = 0;
let fail = 0;

function expect(name, accept, mutate) {
  const validate = makeValidator();
  const doc = clone(manifest);
  if (mutate) mutate(doc);
  const ok = validate(doc);
  if (ok === accept) {
    console.log(
      `  ok   ${name.padEnd(56)} (${
        accept ? "accepted" : "rejected"
      } as expected)`
    );
    pass++;
  } else {
    console.error(
      `  FAIL ${name.padEnd(56)} expected ${
        accept ? "ACCEPT" : "REJECT"
      }, got ${ok ? "ACCEPT" : "REJECT"}`
    );
    if (!ok) console.error(fmt(validate.errors));
    fail++;
  }
}

console.log(
  "rungs.schema.json self-test — accepts the truth, rejects the forbidden\n"
);

// THE CASE THAT MAKES EVERY OTHER CASE MEAN SOMETHING. Without it, a schema that rejects all
// input passes every reject case below and looks perfect.
expect("BASELINE: the real manifest is ACCEPTED", true);

// The stream-topology prohibition. `run` is an interaction shape, not a stream topology: real
// Open SWE registers three graphs that do not share a run, so a per-rung thread or endpoint
// would bake in a topology already documented as wrong (LOCAL-AGENT.md:59-73).
expect("threadId on a rung entry", false, (d) => (d.rungs[3].threadId = "t1"));
expect("runId on a rung entry", false, (d) => (d.rungs[3].runId = "r1"));
expect(
  "streamUrl on a rung entry",
  false,
  (d) => (d.rungs[3].streamUrl = "http://x/stream")
);
expect(
  "graphs[] on a rung entry",
  false,
  (d) => (d.rungs[3].graphs = ["manager", "planner"])
);
expect("threadId at the document root", false, (d) => (d.threadId = "t1"));
expect(
  "streamUrl nested inside target",
  false,
  (d) => (d.rungs[3].target.streamUrl = "http://x")
);
// DEV7's gap: `shared` had no additionalProperties:false, so this validated.
expect("graphs[] inside shared", false, (d) => (d.shared.graphs = ["manager"]));

// The variant DEV7 asked to remove must actually be gone, not merely unused.
expect("target kind:'route' (deliberately removed)", false, (d) => {
  d.rungs[0].target = { kind: "route", app: "example", route: "/langchain" };
});

// Shape and state are closed vocabularies — #23 ruled two shapes, and a third must be a
// deliberate edit here plus a new branch in the shell, never a silent string.
expect("a third interaction shape", false, (d) => (d.rungs[0].shape = "batch"));
expect(
  "an undeclared state",
  false,
  (d) => (d.rungs[0].state = "probably-fine")
);

// Topologies are per (rung, runtime). A rung-level array must not validate, or the ragged
// deepagents x fastapi deep-research cell becomes inexpressible again.
expect("rung-level topologies[] (the shape this replaced)", false, (d) => {
  d.rungs[0].topologies = ["react", "plan-execute"];
});
expect("a runtime with an unknown key", false, (d) => {
  d.rungs[0].runtimes.django.threadId = "t1";
});

// Positives that must keep working, so the schema is not merely strict.
expect("a rung owning docs (the field that broke this)", true, (d) => {
  d.rungs[0].owns.docs = ["docs/rungs/1-langchain.md", "docs/rungs/extra.md"];
});
expect("empty topologies (one cell, no axis)", true, (d) => {
  d.rungs[3].runtimes.node.topologies = [];
});

const EXPECTED_CASES = 15;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} schema cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The schema accepts the real manifest and rejects every forbidden\n` +
    `      shape — so its rejections mean something.`
);
