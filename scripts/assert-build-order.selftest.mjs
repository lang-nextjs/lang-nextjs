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

const EXPECTED_CASES = 8;
const total = pass + fail;
console.log();
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
