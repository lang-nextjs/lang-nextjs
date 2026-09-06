#!/usr/bin/env node
/**
 * PROOF THAT THE BUILD-ORDER CHECKER CAN FAIL (PKG-01).
 *
 * The checker's real subject is a DISAGREEMENT between two independently derived sets:
 * what the packages say they depend on, and what turbo says it will order. So the defects
 * worth planting are the ways that comparison can be satisfied while ordering is broken.
 *
 * Deliberately does not shell out to turbo. The expensive real graph is the CI job; this is
 * the verdict, and a proof that needed a turbo invocation to check an empty-set guard is one
 * people skip — an unrun proof proves nothing.
 *
 * MEASURED END-TO-END BEFORE THIS WAS WRITTEN: removing `dependsOn: ["^build"]` from
 * turbo.json takes turbo's resolved graph from 11 edges to 0, and the checker exits 1 naming
 * every unordered pair. These cases guard the logic that produced that.
 */
import {
  verdict,
  expectedEdges,
  observedEdges,
  edgeKey,
  MIN_EDGES,
} from "./assert-build-order.mjs";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ok   ${name}`);
    pass++;
  } else {
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
};

const edges = (n) =>
  Array.from({ length: n }, (_, i) => ({ from: `a${i}`, to: `b${i}` }));
const observedFor = (es) => new Set(es.map((e) => edgeKey(e.from, e.to)));

console.log(
  "assert-build-order — the checker must refuse a graph that orders nothing\n"
);

// CONTROL. Without it every case below could be satisfied by a checker that always fails,
// which cannot report a regression either.
{
  const e = edges(MIN_EDGES + 2);
  const v = verdict(e, observedFor(e));
  check("a fully ordered graph PASSES", v.ok, v.problems.join("; "));
}

// THE DEFECT THIS EXISTS FOR: turbo.json declares dependsOn and turbo orders nothing.
{
  const e = edges(MIN_EDGES + 2);
  const v = verdict(e, new Set());
  check(
    "zero ordered edges is REFUSED (the dependsOn-removed shape)",
    !v.ok && v.missing.length === e.length
  );
}

// One missing edge is the realistic regression — a package added without its dependency
// being buildable, or a narrowed `dependsOn`. It must not be averaged away by the others.
{
  const e = edges(MIN_EDGES + 2);
  const obs = observedFor(e);
  obs.delete(edgeKey("a0", "b0"));
  const v = verdict(e, obs);
  check(
    "a SINGLE missing edge is REFUSED, not tolerated among many present ones",
    !v.ok && v.missing.length === 1 && v.missing[0].from === "a0"
  );
}

// NON-VACUITY. A repo where nothing was enumerated would otherwise "pass" with no edges to
// check — the empty-subject pass this whole family of checkers exists to refuse.
{
  const v = verdict([], new Set());
  check(
    "an EMPTY expected set is REFUSED rather than passing trivially",
    !v.ok && v.problems.some((p) => /enumeration is broken/.test(p))
  );
}
{
  const e = edges(MIN_EDGES - 1);
  const v = verdict(e, observedFor(e));
  check(
    "a suspiciously SMALL expected set is REFUSED even when fully ordered",
    !v.ok && v.problems.some((p) => /at least/.test(p))
  );
}

// EXTRA edges are not a defect: turbo orders transitively and may know about more pairs than
// the direct manifests do. Asserting equality would fail on a correct graph.
{
  const e = edges(MIN_EDGES + 2);
  const obs = observedFor(e);
  obs.add(edgeKey("someone", "else"));
  const v = verdict(e, obs);
  check("EXTRA edges turbo knows about do not fail the check", v.ok);
}

// The derivation itself: only buildable packages, and a package never depends on itself.
{
  const pkgs = new Map([
    ["app", "/app"],
    ["lib", "/lib"],
    ["nobuild", "/nobuild"],
  ]);
  const read = (dir) =>
    ({
      "/app": {
        scripts: { build: "x" },
        dependencies: { lib: "workspace:*", nobuild: "1", app: "1" },
      },
      "/lib": { scripts: { build: "x" } },
      "/nobuild": { dependencies: { lib: "workspace:*" } },
    }[dir] ?? null);
  const e = expectedEdges(pkgs, read);
  check(
    "expected edges skip non-buildable packages and self-references",
    e.length === 1 && e[0].from === "app" && e[0].to === "lib",
    JSON.stringify(e)
  );
}

// The observed side must read turbo's own task ids, and ignore non-build tasks.
{
  const obs = observedEdges({
    tasks: [
      { task: "build", package: "app", dependencies: ["lib#build"] },
      { task: "lint", package: "app", dependencies: ["other#lint"] },
    ],
  });
  check(
    "observed edges come from build tasks only",
    obs.has(edgeKey("app", "lib")) && obs.size === 1
  );
}

let TURBO_MISSING = null;
/* ── #842: an environment that cannot answer is a REFUSAL, not a violation ──── */

/*
 * WHY THESE SPAWN THE CHECKER. Every case above tests `verdict` and `expectedEdges` directly,
 * which is right for pure functions and cannot see this: the property is a PROCESS EXIT CODE,
 * and 1 versus 2 is the difference between "the build graph is wrong" and "nobody obtained the
 * build graph". Asserted BY VALUE — `=== 2`, with `!== 1` stated separately as the specific
 * wrong answer — because a check for non-zero passes identically either way (#767, #769).
 *
 * BOTH READINGS ARE COVERED, and the second one is why. #842 named the turbo catch. Planting a
 * stripped PATH showed the FIRST reading — `pnpm ls`, which had no catch at all — throwing
 * ENOENT uncaught and exiting 1 with a stack trace BEFORE turbo was ever invoked. A case for
 * the named branch alone would have left the one that fires first untested.
 */
{
  const CHECKER = join(ROOT_DIR, "scripts", "assert-build-order.mjs");
  const spawnChecker = (env) =>
    spawnSync(process.execPath, [CHECKER], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  const noPath = spawnChecker({ PATH: "/nonexistent" });
  check(
    "the package list being unreadable exits 2, the could-not-ask code",
    noPath.status === 2,
    `got ${noPath.status}`
  );
  check(
    "...and NOT 1, which would claim the build graph is wrong",
    noPath.status !== 1,
    "exited 1 — an absent pnpm reported as an ordering defect"
  );
  check(
    "...and says which reading it could not take",
    /COULD NOT CHECK/.test(noPath.stderr) && /package list/.test(noPath.stderr),
    (noPath.stderr || "").split("\n").slice(0, 2).join(" ").slice(0, 90)
  );

  /*
   * THE TURBO BRANCH SPECIFICALLY — #842's named one. A shim named `pnpm` that delegates every
   * other invocation to the real binary and fails only on `exec`, so the package list is read
   * successfully and the GRAPH is what cannot be obtained. Without the delegation this would
   * re-test the branch above and report a pass for the wrong reason.
   */
  const realPnpm = spawnSync("sh", ["-c", "command -v pnpm"], {
    encoding: "utf8",
  }).stdout.trim();
  if (realPnpm) {
    const shimDir = mkdtempSync(join(tmpdir(), "bo-shim-"));
    writeFileSync(
      join(shimDir, "pnpm"),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "exec" ]; then\n    echo 'Command "turbo" not found' >&2\n    exit 1\n  fi\ndone\nexec ${realPnpm} "$@"\n`
    );
    chmodSync(join(shimDir, "pnpm"), 0o755);
    const noTurbo = spawnChecker({ PATH: `${shimDir}:${process.env.PATH}` });
    check(
      "the task graph being unobtainable exits 2, not 1",
      noTurbo.status === 2,
      `got ${noTurbo.status}`
    );
    check(
      "...and names the GRAPH rather than the package list it did read",
      /COULD NOT CHECK/.test(noTurbo.stderr) &&
        /task graph/.test(noTurbo.stderr),
      (noTurbo.stderr || "").split("\n").slice(0, 2).join(" ").slice(0, 90)
    );
    rmSync(shimDir, { recursive: true, force: true });
  }

  /*
   * THE COMPANION. Without it every case above is satisfied by a checker that refuses
   * unconditionally, which is a different way of never answering. In a tree with turbo
   * installed the checker must actually reach a verdict — 0 or 1, but never 2.
   *
   * ITS PRECONDITION IS ESTABLISHED INDEPENDENTLY, AND THAT IS THE WHOLE DESIGN.
   *
   * The first version asserted `status !== 2` unconditionally, so in a tree without
   * node_modules it FAILED — exit 1, the code reserved for a property being VIOLATED —
   * because the checker had correctly refused. A proof unable to establish its own
   * precondition was reporting a defect in its subject: #784's inversion, reproduced inside
   * the fix for its sibling.
   *
   * Its detail line was worse than its verdict. It read "exited 2 in a tree where turbo is
   * installed", ASSERTING THE PREMISE THAT IS FALSE IN EXACTLY THE CASE THAT PRINTS IT —
   * turbo is precisely what is missing. It told a reader the environment was fine and the
   * checker broken, routing them away from the cause rather than merely failing to help.
   *
   * The precondition is read from the FILESYSTEM, never from the checker's own answer. Using
   * "the checker refused" as the excuse would make this case unfalsifiable: a checker that
   * refuses unconditionally — the exact defect this companion exists to catch — would then
   * excuse itself. Gaining the ability to excuse a null result is the wrong repair, because
   * the excuse gets used to ship the confident answer. With an independent probe, a tree that
   * HAS turbo still holds this case to `status !== 2`, so the guard keeps its teeth.
   */
  const TURBO = join(ROOT_DIR, "node_modules", ".bin", "turbo");
  if (existsSync(TURBO)) {
    const normal = spawnChecker({});
    check(
      "...and in a working environment it ANSWERS rather than refusing",
      normal.status !== 2,
      `exited ${normal.status} with turbo present at ${TURBO} — refusing unconditionally`
    );
  } else {
    TURBO_MISSING = TURBO;
  }
}

const EXPECTED_CASES = 14;
const total = pass + fail;

/*
 * THE COUNT GUARD RUNS AT EXIT, AND IS REGISTERED HERE RATHER THAN AT THE END (#836).
 *
 * The in-line comparison below runs at ITS POINT IN THE FILE and reads `total`, a binding
 * taken above. Both are positional and both fail the same way: a case appended at the end
 * of this file runs AFTER the guard and AFTER the binding, so the tally matches what the
 * guard could see and the suite reports a green over a count it never checked. That is how
 * the defect arrived twice in the files this form already landed on.
 *
 * REGISTERED ABOVE THE FIRST `process.exit`, AS DEFENCE IN DEPTH RATHER THAN AS A FIX FOR
 * ANYTHING OBSERVABLE TODAY. A hook registered below an exit is never INSTALLED on the paths
 * that take it, and this file exits at three points where the other 32 exit at one. But all
 * three are non-zero — 2, 1, 1 — so on exactly those paths the `code === 0` test below
 * suppresses this hook anyway. MOVING IT TO THE BOTTOM CHANGES NO ARM: success, a case
 * planted below the guard, and an uninstalled tree all behave identically either way, which
 * was measured rather than argued.
 *
 * It is kept here because it costs nothing now and stops costing nothing the moment any path
 * exits 0 early, or `code === 0` is ever removed. Do not read the placement as load-bearing,
 * and equally do not "simplify" it to match the other 32 on the grounds that nothing changes:
 * what the move gives up is the margin, not a behaviour.
 *
 * `code === 0` IS WHAT PROTECTS THE REFUSAL (#860). Without turbo the companion cannot be
 * established, this file exits 2, and a genuinely deleted case is MASKED rather than
 * reported as a count finding. That masking is deliberate: a run that could not be completed
 * must not then be judged on its completeness. Without `code === 0` the hook would re-assert
 * the count after the refusal had already declined to judge, overwrite the 2 with a 1, and
 * turn "could not ask" into "answered wrongly" — inverting the distinction this proof exists
 * to defend.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED_CASES) {
    console.error(
      `\nFAIL: ran ${ran} cases, expected ${EXPECTED_CASES} — a case was added or lost\n` +
        `      BELOW the in-line guard, where nothing before process exit can see it.`
    );
    process.exitCode = 1;
  }
});

console.log();
/*
 * A PRECONDITION THIS PROOF COULD NOT ESTABLISH IS A REFUSAL, NOT A PASS AND NOT A FAILURE.
 * Every refusal case above ran and passed; the one that stops them being satisfied by a
 * checker which refuses unconditionally could not be established at all.
 */
if (TURBO_MISSING) {
  console.error(
    `\nCOULD NOT CHECK: the presence companion needs turbo installed — nothing is at\n` +
      `  ${TURBO_MISSING}. The refusal cases above all ran, but the one that stops them\n` +
      `  being satisfied by a checker which refuses UNCONDITIONALLY was not established, so\n` +
      `  the case count is one short and is a CONSEQUENCE of that rather than a finding.\n` +
      `  Run \`pnpm install\` first.\n` +
      `  Exiting 2: the question could not be asked, not answered — the distinction this\n` +
      `  proof exists to defend, applied to the proof itself.`
  );
  process.exit(2);
}

/*
 * KEPT AS A FAST PATH, NOT AS THE GUARANTEE — the hook above is what actually holds the
 * count. This runs first only so the ordinary case reports cleanly, instead of printing the
 * emphatic PASS below and then contradicting it from the exit handler.
 */
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — this selftest is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(
    `FAIL: ${fail}/${total} cases wrong. The build-order checker is NOT trustworthy.`
  );
  process.exit(1);
}

console.log(
  `PASS: ${pass}/${total}. The checker refuses an unordered graph, a single missing edge,\n` +
    `      and an empty enumeration — so its green means build order is enforced rather\n` +
    `      than merely declared.`
);
