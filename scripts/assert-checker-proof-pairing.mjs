#!/usr/bin/env node
/**
 * Property: EVERY CHECKER CI RUNS HAS A PROOF THAT IT CAN FAIL, AND CI RUNS THAT PROOF.
 *
 * This repo's convention is that a checker ships with a self-test, because a checker never
 * observed to fail is indistinguishable from one that cannot. The convention was a habit. Habits
 * are kept by whoever remembers them, and four checkers shipped without a proof by people —
 * mostly me — who were arguing for the convention at the time. This makes it a rule.
 *
 * WHAT IT ASSERTS, AND WHY EACH PART IS NOT THE PART BEFORE IT.
 *
 *   1. Every checker a workflow invokes has a proof.        A missing proof is the original gap.
 *   2. A workflow actually INVOKES that proof.              A proof that exists and never runs is
 *                                                           a file, not a check. Asserting the
 *                                                           file exists would pass over it.
 *   3. The proof runs in the SAME WORKFLOW as the checker.  Workflows fire independently, so a
 *                                                           proof in ci.yml does not gate a
 *                                                           checker in severability.yml — that
 *                                                           workflow goes green over an unproven
 *                                                           guard. This is the part that is
 *                                                           weaker than it looks everywhere else.
 *
 * BOTH ALLOWLISTS DECAY LOUDLY. `KNOWN_UNPROVEN` and `KNOWN_CROSS_WORKFLOW` record what is true
 * today so the gate can be turned on without a mass migration. Each entry is re-derived every
 * run: an entry that has since been fixed FAILS and says to delete it. An allowlist nobody
 * revisits is how a temporary suppression becomes permanent, and this repo already has three
 * allowlists with the same obligation (`NOT_PUBLIC`, `PENDING_RECLASSIFICATION`,
 * `knownRungNamedSharedPaths`).
 *
 * WHY THE PAIRING IS NOT A FILENAME CONVENTION. `validate-manifest.mjs` proves itself with a
 * `--selftest` FLAG and has no sibling file. A gate that looked for `<stem>.selftest.*` would
 * report it unproven and be wrong. So a proof is an INVOCATION, discovered from the workflows,
 * with an override for the flag form.
 *
 * A PROOF THAT IMPORTS ITS CHECKER NEEDS THAT CHECKER'S MAIN BLOCK GUARDED. Reusing the real
 * helpers is the right way to write a proof — it is what stops the proof re-implementing the
 * rule and agreeing with itself. But an unguarded module runs its check on import, so the
 * proof inherits the checker's exit code before asserting anything, and a proof that dies at
 * `import` reports the checker's verdict rather than its own. Guard with
 * `if (isMain)` (see this file, line ~278) whenever a proof imports it.
 *
 * Usage: node scripts/assert-checker-proof-pairing.mjs [--cwd DIR]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD =
  ci >= 0
    ? resolve(argv[ci + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Checkers with no can-it-fail proof yet. `why` must say what is blocking it, not "TODO".
 * An entry that acquires a proof FAILS this check — delete it when that happens.
 */
const KNOWN_UNPROVEN = [
  {
    checker: "scripts/gen-rung-types.mjs",
    why: "selftest written but not merged; it must refuse RUNGS_MANIFEST without RUNGS_CWD first, because a generator reads one tree and writes another",
  },
];

/**
 * Checker/proof pairs that run in different workflows. Not a blessing — a record, so the gate can
 * be enabled without a migration and so no NEW one appears unnoticed.
 * An entry whose proof moves into the checker's workflow FAILS — delete it when that happens.
 */
const KNOWN_CROSS_WORKFLOW = [
  {
    checker: "scripts/classify.mjs",
    why: "also runs inside severability.yml against each fork; proof is in ci.yml",
  },
  {
    checker: "scripts/validate-manifest.mjs",
    why: "also runs inside severability.yml against each fork; proof is in ci.yml",
  },
  {
    checker: "scripts/matrix.mjs",
    why: "derives the severability matrix inside severability.yml; proof is in ci.yml",
  },
  {
    checker: "scripts/payload-triangulation.mjs",
    why: "also runs inside severability.yml against each fork; proof is in ci.yml",
  },
  // scripts/eject.mjs WAS HERE, and its removal is the point of #180. The entry read
  // "the subject of severability.yml; proof is in ci.yml" — an accurate description of a
  // gate named Severability that could be green while eject's own guards were red. This
  // allowlist is built to decay loudly, and it did: adding the `guards` job to
  // severability.yml made the entry stale, and this checker failed demanding its deletion
  // rather than letting a fixed exemption sit on as permanent suppression.
  {
    checker: "scripts/has-rung.mjs",
    why: "gates steps in cross-version.yml and e2e.yml; proof is in ci.yml. This was the WORST of these while cross-version.yml carried paths: filters — the checker could be skipped entirely while the proof reported green. #380 removed them, so the workflow now runs on every PR and the gap is the ordinary cross-workflow one: a proof in ci.yml does not gate a checker elsewhere",
  },
];

/** Proofs that are not a sibling file. Keyed by checker path, valued by the pnpm script. */
const PROOF_OVERRIDE = {
  "scripts/validate-manifest.mjs": "test:rungs-schema",
};

const isProof = (p) => /\.selftest\.[cm]?[jt]s$|\.selftest\.sh$/.test(p);

/**
 * Blank YAML comments rather than dropping them, so a DOCUMENTED invocation inside a comment is
 * not counted as a real one. `docs/RUNGS.md` learned this the expensive way: a comment saying
 * "removed, in the mechanism that removes it" mentions the very script it describes.
 */
const stripYamlComments = (src) =>
  src
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");

const scriptPaths = (text) =>
  new Set(
    [...text.matchAll(/(?:scripts|\.github\/scripts)\/([\w.-]+\.(?:mjs|sh))/g)].map(
      (m) => m[0]
    )
  );

/**
 * Run the pairing rules over `root`.
 *
 * The allowlists are PARAMETERS with the module constants as defaults, for the same reason
 * `budgetedRoutes` takes its roles: constants baked into the function make the subject
 * unvaryable, and a checker whose subject cannot vary is one nobody can watch fail. The real
 * allowlists stay in this file's source, where an exception is one line, written by a person,
 * and visible in a diff — which is the property that makes an allowlist better than a flag.
 *
 * Returns `{ problems, stale, stats }` rather than exiting, so the caller decides.
 */
export function checkPairing(root = CWD, opts = {}) {
  const { unproven = KNOWN_UNPROVEN, crossWorkflow = KNOWN_CROSS_WORKFLOW } = opts;
  const CWD = root;
  const wfDir = join(CWD, ".github", "workflows");
  if (!existsSync(wfDir)) {
    return {
      problems: [`no .github/workflows in ${CWD} — wrong cwd, not a clean tree.`],
      stale: [],
      stats: null,
    };
  }
  const pkg = JSON.parse(readFileSync(join(CWD, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};

  // workflow -> set of script paths it invokes, directly or through a pnpm script.
  const invokedBy = new Map();
  for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
    const body = stripYamlComments(readFileSync(join(wfDir, f), "utf8"));
    const found = scriptPaths(body);
    for (const [name, cmd] of Object.entries(scripts)) {
      // `(?!\S)` so `pnpm test` does not match `pnpm test:eject`.
      if (new RegExp(`pnpm (?:run )?${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}(?!\\S)`).test(body)) {
        for (const p of scriptPaths(cmd)) found.add(p);
      }
    }
    invokedBy.set(f, found);
  }

  /*
   * THE RUN RECORD, FOR THE CHECKS THAT DECLARE THEMSELVES (#396 stage 1).
   *
   * Everything above establishes that a workflow's TEXT MENTIONS A SCRIPT. It cannot tell
   * that apart from the step having run — latent in ci.yml, where no checker step is
   * conditional, and live elsewhere: has-rung.mjs gates steps with a shell `if` inside `run:`
   * blocks that no YAML parse can see.
   *
   * For the checks declared in scripts/checks.json the subject is no longer the YAML. It is
   * `.checks-run.json`, written by run-checks.mjs as it executes, so a declared check the
   * runner never ran is a HOLE here rather than a pass. The declaration is the expectation
   * and the record is the evidence, which is what stops the two being circular: the record
   * cannot claim an execution that did not happen.
   */
  const listPath = join(CWD, "scripts", "checks.json");
  const recordPath = join(CWD, ".checks-run.json");
  let recorded = null;
  if (existsSync(listPath)) {
    if (!existsSync(recordPath)) {
      return {
        problems: [
          `scripts/checks.json declares checks but ${recordPath} is absent, so which of them ` +
            `actually ran CANNOT BE COMPUTED. Run \`pnpm checks\` first — in CI that step ` +
            `precedes this one. A missing record is not an empty one.`,
        ],
        stale: [],
        stats: null,
      };
    }
    const declared = JSON.parse(readFileSync(listPath, "utf8")).checks ?? [];
    const ran = JSON.parse(readFileSync(recordPath, "utf8")).ran ?? [];
    const ranScripts = new Set(ran.map((r) => r.script));
    recorded = { declared: declared.length, ran: ran.length };
    const holes = [];
    for (const c of declared) {
      for (const [phase, script] of [["proof", c.proof], ["checker", c.checker]]) {
        if (!ranScripts.has(script)) {
          holes.push(
            `scripts/checks.json declares "${c.name}" but its ${phase} ${script} does not ` +
              `appear in ${recordPath} — declared and not executed.`
          );
        }
      }
    }
    if (holes.length) return { problems: holes, stale: [], stats: null };
    // Recorded scripts ran in ci.yml, which is where the runner is invoked. Adding them here
    // rather than to a synthetic key keeps the same-workflow rule meaning what it says.
    const ci = invokedBy.get("ci.yml") ?? new Set();
    for (const sc of ranScripts) ci.add(sc);
    invokedBy.set("ci.yml", ci);
  }

  const workflowsOf = (path) =>
    new Set([...invokedBy].filter(([, s]) => s.has(path)).map(([f]) => f));

  const allInvoked = new Set([...invokedBy.values()].flatMap((s) => [...s]));
  const checkers = [...allInvoked].filter((p) => !isProof(p)).sort();

  // Non-vacuity. A scan finding no checkers would report every rule satisfied over nothing.
  const MIN_CHECKERS = opts.minCheckers ?? 5;
  if (checkers.length < MIN_CHECKERS) {
    return {
      problems: [
        `found only ${checkers.length} checker(s) across the workflows — the scan is broken, ` +
          `not the tree.`,
      ],
      stale: [],
      stats: null,
    };
  }

  /** The proof invocation for a checker, or null. */
  function proofFor(checker) {
    const override = PROOF_OVERRIDE[checker];
    if (override) {
      const cmd = scripts[override];
      if (!cmd) return null;
      const wfs = new Set(
        [...invokedBy]
          .filter(([f]) =>
            new RegExp(`pnpm (?:run )?${override.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}(?!\\S)`).test(
              stripYamlComments(readFileSync(join(wfDir, f), "utf8"))
            )
          )
          .map(([f]) => f)
      );
      return { label: `pnpm ${override}`, workflows: wfs };
    }
    const stem = checker.replace(/\.(mjs|sh)$/, "");
    const sibling = [...allInvoked].find((p) => p.startsWith(`${stem}.selftest.`));
    if (!sibling) return null;
    return { label: sibling, workflows: workflowsOf(sibling) };
  }

  const unprovenAllow = new Map(unproven.map((e) => [e.checker, e]));
  const crossAllow = new Map(crossWorkflow.map((e) => [e.checker, e]));
  const problems = [];
  const stale = [];
  let proven = 0;
  const recordedStats = recorded;
  let crossed = 0;

  for (const checker of checkers) {
    const proof = proofFor(checker);
    const cw = workflowsOf(checker);

    if (!proof || proof.workflows.size === 0) {
      // Distinguish "no proof exists" from "a proof exists but nothing runs it" — the second
      // looks fixed in a directory listing and is not.
      const stem = checker.replace(/\.(mjs|sh)$/, "");
      const dir = join(CWD, dirname(checker));
      const onDisk = existsSync(dir)
        ? readdirSync(dir).some((f) =>
            f.startsWith(`${basename(stem)}.selftest.`)
          )
        : false;
      if (unprovenAllow.has(checker)) {
        unprovenAllow.delete(checker);
        continue;
      }
      problems.push(
        onDisk
          ? `${checker}: a selftest file exists but NO WORKFLOW INVOKES IT. A proof nothing runs ` +
              `is a file, not a check.`
          : `${checker}: no can-it-fail proof. Add a sibling *.selftest.* and invoke it from the ` +
              `workflow that runs this checker.`
      );
      continue;
    }
    proven++;

    // Rule 3: the checker's workflows must be covered by the proof's workflows.
    const uncovered = [...cw].filter((f) => !proof.workflows.has(f));
    if (uncovered.length > 0) {
      if (crossAllow.has(checker)) {
        crossAllow.delete(checker);
        crossed++;
        continue;
      }
      problems.push(
        `${checker}: runs in ${[...cw].join(", ")} but its proof (${proof.label}) runs only in ` +
          `${[...proof.workflows].join(", ")}. Workflows fire independently, so ` +
          `${uncovered.join(", ")} would go green over an unproven checker.`
      );
    }
  }

  // Anti-rot, both directions. An entry that no longer describes the tree is not harmless: it is
  // a suppression nobody is being told they can remove.
  for (const e of unprovenAllow.values()) {
    stale.push(
      `KNOWN_UNPROVEN names ${e.checker}, which now HAS a proof (or is no longer invoked) — delete the entry.`
    );
  }
  for (const e of crossAllow.values()) {
    stale.push(
      `KNOWN_CROSS_WORKFLOW names ${e.checker}, whose proof now runs in every workflow that runs it (or which is no longer invoked) — delete the entry.`
    );
  }

  return {
    problems,
    stale,
    stats: {
      checkers: checkers.length,
      workflows: invokedBy.size,
      proven,
      recordedUnproven: unproven.length,
      crossed,
    },
  };
}

// --- CLI -------------------------------------------------------------------------------------
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { problems, stale, stats } = checkPairing(CWD);
  if (problems.length > 0) {
    console.error(
      `FAIL: ${problems.length} checker(s) are not properly paired with a proof:`
    );
    for (const p of problems) console.error(`       ${p}`);
  }
  if (stale.length > 0) {
    console.error(`\nFAIL: ${stale.length} stale allowlist entr(ies):`);
    for (const t of stale) console.error(`       ${t}`);
  }
  if (problems.length > 0 || stale.length > 0) {
    // POINT AT THE LESSON, HERE, AT THE MOMENT SOMEBODY NEEDS IT (#108).
    //
    // docs/CHECKING-THE-CHECK.md carries the reasoning behind this gate, and #108
    // measured that NOTHING in scripts/ or .github/ pointed at it — so the lesson
    // that cost this repo a gate reporting success without running lived in a
    // document a script author has no reason to open. #105 moved the content and
    // did not move the reader.
    //
    // This failure is the one moment a checker author is definitionally thinking
    // about proofs. A pointer anywhere else is a pointer they walk past.
    console.error(
      `\n  WHY THIS GATE EXISTS: docs/CHECKING-THE-CHECK.md\n` +
        `  A checker with no proof is a checker nobody has watched fail, and this repo\n` +
        `  has shipped several that could not fail at all — one exited 0 printing\n` +
        `  "usage:", another examined no shell because a dependency was absent.\n` +
        `  Adding <stem>.selftest.mjs is not the fix; PLANTING THE DEFECT in it is.\n` +
        `  See also CONTRIBUTING.md, "The house rule".\n`
    );
    process.exit(1);
  }
  console.log(
    `PASS: ${stats.checkers} checker(s) invoked across ${stats.workflows} workflows; ` +
      `${stats.proven} have a proof CI runs.\n` +
      `      ${stats.recordedUnproven} recorded unproven, ${stats.crossed} recorded as proved ` +
      `in a different workflow — both allowlists re-derived, no stale entries.`
  );
}
