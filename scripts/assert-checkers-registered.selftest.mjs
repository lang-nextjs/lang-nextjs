/**
 * PROOF FOR assert-checkers-registered.mjs — it fires on each arm, and stays silent on the
 * cases it must not fire on (#741, widened by #774).
 *
 * THE ARMS ARE TESTED SEPARATELY BECAUSE THEY FAIL FOR DIFFERENT REASONS. A gate asserting
 * "registered or excused" has an obvious degenerate form: excuse everything. Arms 4 and 5 are
 * what stop that, and they are the ones a later reader is most likely to weaken, because a
 * failing exclusion looks like paperwork rather than like a defect.
 *
 * EVERY REJECTION CASE HAS AN ACCEPTANCE COMPANION. Without them a gate that rejected every
 * input would score full marks here, which is the shape this repo keeps deleting.
 *
 * THE RESOLVER'S NEGATIVE CONTROLS ARE THE POINT OF THIS FILE NOW, and they are the reason
 * #774 is not just a wider glob. Accounting is derived from workflows, so:
 *
 *     a resolver that MISSES an invocation  -> a script reads as unaccounted -> RED, safe, loud
 *     a resolver that OVER-MATCHES          -> a script reads as accounted   -> GREEN, silent
 *
 * Only the second can defeat the gate, and positive controls cannot see it. ARCHITECT-lang
 * found the live instance: ci.yml carries the comment "WIRED IN #117. check-palette.mjs and
 * its selftest existed and ran NOWHERE in CI", so a text-matching resolver accounts for
 * check-palette USING THE PROSE THAT RECORDS THE BUG. THE BAR arm below builds exactly that
 * tree — real ci.yml, invocation steps removed, every comment kept — and requires RED.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  partition,
  orphanProofs,
  audit,
} from "./assert-checkers-registered.mjs";
import { PROOF_OVERRIDE } from "./assert-checker-proof-pairing.mjs";
import { resolveInvocations, runBlocks } from "./lib/workflow-invocations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};
const AL = () => true; // every path exists
const NONE = () => false; // no path exists
const M = (...paths) => new Map(paths.map((p) => [p, ["ci.yml"]]));

console.log(
  "\nassert-checkers-registered — each arm fires, and the companions stay green\n"
);

/* ── the population is CONTENT, not prefix ──────────────────────────────── */
{
  const p = partition([
    "assert-a.mjs",
    "assert-a.selftest.mjs",
    "check-b.mjs",
    "check-b.selftest.mjs",
    "tool-c.mjs",
    "tool-c.selftest.mjs",
    "no-proof.mjs",
  ]);
  ok(
    "population is every file with a sibling proof — check-* and unprefixed included",
    p.withProof.length === 3 &&
      p.withProof.includes("check-b.mjs") &&
      p.withProof.includes("tool-c.mjs"),
    `withProof=${JSON.stringify(p.withProof)}`
  );
  ok(
    "...and a file with NO proof is excluded (the companion)",
    !p.withProof.includes("no-proof.mjs") && p.total === 7,
    `total=${p.total}`
  );
}

/* ── a proof is not always a sibling file ───────────────────────────────── */
{
  // The live case: validate-manifest.mjs proves itself with a --selftest FLAG and has no
  // sibling. assert-checker-proof-pairing.mjs's header says a gate keying on
  // `<stem>.selftest.*` "would report it unproven and be wrong" — this gate WAS that gate.
  const names = ["flag-proved.mjs", "unproved.mjs"];
  const table = { "scripts/flag-proved.mjs": "test:flag-proved" };
  ok(
    "a script whose proof is a declared FLAG is in the population",
    partition(names, table).withProof.includes("flag-proved.mjs"),
    "a flag-form proof was not recognised"
  );
  ok(
    "...and one with no proof of any form is still out (the companion)",
    !partition(names, table).withProof.includes("unproved.mjs"),
    "a script with no proof was admitted"
  );
  ok(
    "the real table is IMPORTED, not restated — validate-manifest.mjs is in it",
    Object.prototype.hasOwnProperty.call(
      PROOF_OVERRIDE,
      "scripts/validate-manifest.mjs"
    ),
    "the shared PROOF_OVERRIDE no longer names the file this arm exists for"
  );
}

/* ── the resolver: it must find real invocations ────────────────────────── */
const PKG = {
  palette: "node scripts/check-palette.mjs",
  "test:palette": "node scripts/check-palette.selftest.mjs",
  deep: "pnpm midway",
  midway: "pnpm palette",
  fmt: "node scripts/format.mjs",
};
const wf = (body) => ({ "ci.yml": `jobs:\n  ci:\n    steps:\n${body}` });

ok(
  "a literal scripts/ path in a run: block resolves",
  resolveInvocations({
    workflowSources: wf("      - run: node scripts/check-palette.mjs\n"),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "did not resolve"
);
ok(
  "a one-hop pnpm alias resolves to the file it runs",
  resolveInvocations({
    workflowSources: wf("      - run: pnpm palette\n"),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "did not resolve"
);
ok(
  "a THREE-hop alias chain resolves — one substitution pass would miss it",
  resolveInvocations({
    workflowSources: wf("      - run: pnpm deep\n"),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "fixpoint did not close"
);
ok(
  "a block scalar resolves every line, not only the first",
  resolveInvocations({
    workflowSources: wf(
      "      - run: |\n          set -euo pipefail\n          pnpm palette\n"
    ),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "did not resolve inside run: |"
);

/* ── the resolver: it must NOT find prose. The only side that can go green. ─ */
ok(
  "a step-level COMMENT naming a script resolves nothing",
  !resolveInvocations({
    workflowSources: wf(
      "      # See scripts/check-palette.mjs and run pnpm palette\n      - run: echo hi\n"
    ),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "prose accounted for a script"
);
ok(
  "a script named only in a step NAME: field resolves nothing",
  !resolveInvocations({
    workflowSources: wf(
      "      - name: Self-test `pnpm fmt` by mutation\n        run: pnpm test:palette\n"
    ),
    packageScripts: PKG,
  }).has("scripts/format.mjs"),
  "a name: field accounted for a script — this is the live format.mjs case"
);
ok(
  "...but the same alias in the RUN: does resolve (the companion)",
  resolveInvocations({
    workflowSources: wf("      - name: whatever\n        run: pnpm fmt\n"),
    packageScripts: PKG,
  }).has("scripts/format.mjs"),
  "run: was not read"
);
ok(
  "a SHELL comment inside a run: block resolves nothing",
  !resolveInvocations({
    workflowSources: wf(
      "      - run: |\n          # pnpm palette used to live here\n          echo hi\n"
    ),
    packageScripts: PKG,
  }).has("scripts/check-palette.mjs"),
  "a shell comment accounted for a script"
);
ok(
  "runBlocks does not treat a `run:` inside prose as a step",
  runBlocks("jobs:\n  ci:\n    steps:\n      # run: pnpm palette\n").length ===
    0,
  "a commented run: was parsed as a step"
);

/* ── THE BAR — ARCHITECT-lang's acceptance test, on the REAL tree ───────── */
{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // Remove only what a STEP does; keep every comment line untouched.
  const noSteps = ci
    .split("\n")
    .map((l) =>
      /^\s*#/.test(l)
        ? l
        : /pnpm\s+(run\s+)?(test:)?palette\b|check-palette\.mjs/.test(l)
        ? ""
        : l
    )
    .join("\n");

  // POSITIVE CONTROL ON THE FIXTURE ITSELF. If the prose were also removed, this arm would
  // pass for the wrong reason — it would be testing a tree that no longer contains the trap.
  const proseKept = noSteps
    .split("\n")
    .filter((l) => /^\s*#/.test(l) && /check-palette/.test(l)).length;
  ok(
    "the fixture still contains the ci.yml prose naming check-palette",
    proseKept >= 2,
    `only ${proseKept} comment line(s) survived — the trap is not in the fixture`
  );

  const invoked = resolveInvocations({
    workflowSources: { "ci.yml": noSteps },
    packageScripts: pkg.scripts ?? {},
  });
  ok(
    "THE BAR: check-palette.mjs, selftest present, invoked nowhere, ci.yml prose intact — RED",
    audit({
      population: ["check-palette.mjs"],
      registered: [],
      excluded: [],
      invoked,
      exists: AL,
    }).some((f) => /accounted for by nothing/.test(f)),
    "the gate went GREEN on the #117 tree — the class is still open"
  );
  ok(
    "...and with its real steps restored it is accounted for (the companion)",
    resolveInvocations({
      workflowSources: { "ci.yml": ci },
      packageScripts: pkg.scripts ?? {},
    }).has("scripts/check-palette.mjs"),
    "the real tree does not account for check-palette — the resolver misses"
  );
}

/* ── arm 1: accounted for by nothing ────────────────────────────────────── */
ok(
  "a script with a proof and no route is CAUGHT",
  audit({
    population: ["assert-x.mjs"],
    registered: [],
    excluded: [],
    invoked: new Map(),
    exists: AL,
  }).some((f) => /accounted for by nothing/.test(f)),
  "not caught"
);
ok(
  "...registered is a route (companion)",
  audit({
    population: ["assert-x.mjs"],
    registered: ["scripts/assert-x.mjs"],
    excluded: [],
    invoked: new Map(),
    exists: AL,
  }).length === 0,
  "flagged a registered script"
);
ok(
  "...declared is a route (companion)",
  audit({
    population: ["assert-x.mjs"],
    registered: [],
    excluded: [
      {
        checker: "scripts/assert-x.mjs",
        reason: "a reason long enough to be substantive",
        lifts: null,
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).length === 0,
  "flagged a declared script"
);
ok(
  "...INVOCATION is a route (companion) — the whole of #774",
  audit({
    population: ["assert-x.mjs"],
    registered: [],
    excluded: [],
    invoked: M("scripts/assert-x.mjs"),
    exists: AL,
  }).length === 0,
  "flagged a script a workflow step runs"
);

/* ── arm 2: both registered and declared ────────────────────────────────── */
ok(
  "a script BOTH registered and declared unregistered is CAUGHT",
  audit({
    population: ["assert-x.mjs"],
    registered: ["scripts/assert-x.mjs"],
    excluded: [
      {
        checker: "scripts/assert-x.mjs",
        reason: "a substantive reason here",
        lifts: null,
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).some((f) => /BOTH registered and listed/.test(f)),
  "not caught"
);

/* ── arms 3-5: the exclusion list cannot become a mute button ───────────── */
ok(
  "an exclusion naming a file that does not exist is CAUGHT",
  audit({
    population: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/gone.mjs",
        reason: "a substantive reason here",
        lifts: null,
      },
    ],
    invoked: new Map(),
    exists: NONE,
  }).some((f) => /does not exist/.test(f)),
  "not caught"
);
ok(
  "...an exclusion naming a file that exists is not (the companion)",
  audit({
    population: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/here.mjs",
        reason: "a substantive reason here",
        lifts: null,
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).length === 0,
  "flagged an existing file"
);
ok(
  "an exclusion with no substantive reason is CAUGHT",
  audit({
    population: [],
    registered: [],
    excluded: [{ checker: "scripts/x.mjs", reason: "because", lifts: null }],
    invoked: new Map(),
    exists: AL,
  }).some((f) => /no substantive reason/.test(f)),
  "not caught"
);
ok(
  "a PLACEHOLDER lifts value is CAUGHT",
  audit({
    population: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/x.mjs",
        reason: "a substantive reason here",
        lifts: "#TBD",
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).some((f) => /placeholder cannot ship/i.test(f)),
  "not caught"
);
ok(
  "...a real issue number is accepted (the companion)",
  audit({
    population: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/x.mjs",
        reason: "a substantive reason here",
        lifts: "#771",
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).length === 0,
  "rejected a pending exclusion naming an issue"
);
ok(
  "...and lifts:null is accepted as permanent (the companion)",
  audit({
    population: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/x.mjs",
        reason: "a substantive reason here",
        lifts: null,
      },
    ],
    invoked: new Map(),
    exists: AL,
  }).length === 0,
  "rejected a permanent exclusion"
);

/* ── arm 6: orphan proofs, which CANNOT key on the name ─────────────────── */
ok(
  "a proof with no subject, unregistered and uninvoked, is CAUGHT",
  orphanProofs({
    proofs: ["ghost.selftest.mjs"],
    subjects: ["other.mjs"],
    registeredProofs: [],
    invoked: new Map(),
  }).length === 1,
  "not caught"
);
ok(
  "...a CROSS-NAMED proof a workflow runs is not (the live langfuse/dev-all case)",
  orphanProofs({
    proofs: ["langfuse-wiring.selftest.sh"],
    subjects: ["check-langfuse-wiring.mjs"],
    registeredProofs: [],
    invoked: M("scripts/langfuse-wiring.selftest.sh"),
  }).length === 0,
  "manufactured an orphan out of a naming convention"
);
ok(
  "...a proof registered as a check's proof is not (the companion)",
  orphanProofs({
    proofs: ["ghost.selftest.mjs"],
    subjects: ["other.mjs"],
    registeredProofs: ["scripts/ghost.selftest.mjs"],
    invoked: new Map(),
  }).length === 0,
  "flagged a registered proof"
);
ok(
  "...a proof beside its own subject is not (the companion)",
  orphanProofs({
    proofs: ["assert-a.selftest.mjs"],
    subjects: ["assert-a.mjs"],
    registeredProofs: [],
    invoked: new Map(),
  }).length === 0,
  "flagged a paired proof"
);

/* ── report ─────────────────────────────────────────────────────────────── */
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(82)} ${
      r.ok ? "" : `(${r.detail})`
    }`
  );

const total = results.length;
if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Each arm fires on its own defect, every rejection has an\n` +
    `      acceptance companion, and the resolver is controlled on the side that can go\n` +
    `      SILENTLY green — prose, a name: field and a shell comment account for nothing.`
);
