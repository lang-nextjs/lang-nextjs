/**
 * PROOF FOR assert-proofs-are-reachable.mjs — it fires on a proof no route runs, and stays silent
 * on the routes that are legitimately not `pnpm checks` (#839).
 *
 * THE ROUTE SETS ARE INJECTED. The real checker resolves them from nine workflows and a
 * package.json alias graph; driving that here would test #774's resolver, which has its own proof.
 * What is under test is the PREDICATE — which combinations of routes count as reachable — and
 * every one of those combinations can be constructed directly.
 *
 * THE SILENT ARMS ASSERT THE INPUT WAS EXAMINED, because a checker over a computed set can go
 * quiet two ways: the property holds, or the set was empty. Those are indistinguishable from a
 * complaint count of zero, and the empty-domain arm below exists to show the difference is
 * detectable.
 */
import {
  proofsOnDisk,
  routesFor,
  unreachable,
} from "./assert-proofs-are-reachable.mjs";

const results = [];
let pass = 0;
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};

console.log("\nassert-proofs-are-reachable — routes, not registration\n");

const P = "scripts/a.selftest.mjs";
const sets = ({ checks = [], wf = [] }) => ({
  viaChecks: new Set(checks),
  invoked: new Set(wf),
});

/* ── the defect ──────────────────────────────────────────────────────────── */
{
  const r = routesFor([P], sets({}));
  ok(
    "a proof no route reaches is caught — #839's own three, generalised",
    unreachable(r).length === 1 && unreachable(r)[0] === P,
    JSON.stringify([...r])
  );
  ok(
    "...and the routes map records the emptiness rather than omitting the file",
    r.has(P) && r.get(P).length === 0,
    JSON.stringify([...r])
  );
}

/* ── the routes that are NOT defects ─────────────────────────────────────── */
{
  const viaChecks = routesFor([P], sets({ checks: [P] }));
  const viaWf = routesFor([P], sets({ wf: [P] }));
  const both = routesFor([P], sets({ checks: [P], wf: [P] }));
  ok(
    "registered in checks.json is a route",
    unreachable(viaChecks).length === 0 &&
      viaChecks.get(P).includes("checks.json"),
    JSON.stringify([...viaChecks])
  );
  ok(
    "WORKFLOW-ONLY IS A ROUTE AND MUST NOT FAIL — 34 proofs are legitimately only reachable there",
    unreachable(viaWf).length === 0 && viaWf.get(P).includes("workflow"),
    JSON.stringify([...viaWf])
  );
  ok(
    "...and a proof reached by both records both, so the split can be counted",
    both.get(P).length === 2,
    JSON.stringify([...both])
  );
}

/* ── the shape the three actually had ────────────────────────────────────── */
{
  /*
   * All three orphans had their CHECKER in `unregistered`. That excuses the checker from
   * registration; it runs nothing. If `unregistered` were treated as a route, the exact
   * population this checker exists to find would pass.
   */
  const r = routesFor([P], sets({}));
  ok(
    "being excused from registration is NOT being run — the shape all three orphans had",
    unreachable(r).length === 1,
    "an unregistered checker's proof was treated as reached"
  );
}

/* ── the domain ──────────────────────────────────────────────────────────── */
{
  ok(
    "proofsOnDisk takes only *.selftest.mjs, not the checkers beside them",
    JSON.stringify(
      proofsOnDisk(["a.selftest.mjs", "a.mjs", "b.selftest.mjs", "notes.md"])
    ) === JSON.stringify(["scripts/a.selftest.mjs", "scripts/b.selftest.mjs"]),
    JSON.stringify(proofsOnDisk(["a.selftest.mjs", "a.mjs", "b.selftest.mjs"]))
  );
  ok(
    "GUARD (holds either way): an empty domain raises nothing — and is distinguishable from a clean one",
    unreachable(routesFor([], sets({}))).length === 0 &&
      routesFor([], sets({})).size === 0 &&
      routesFor([P], sets({ checks: [P] })).size === 1,
    "an empty domain and a one-proof domain were indistinguishable"
  );
}

/* ── report ─────────────────────────────────────────────────────────────── */
let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(84)} ${
      r.ok ? "" : `(${r.detail})`
    }`
  );
}

const EXPECTED = 8;
const total = results.length;

/*
 * THE COUNT GUARD RUNS AT EXIT, NOT HERE (#836/#853). A guard placed inline is correct only
 * POSITIONALLY: it is re-established by hand on every edit and silently lost the first time
 * someone appends a case below it. EXIT sees everything, because nothing can be appended past
 * process exit. `code === 0` matters — without it this overwrites the exit code of a run that
 * already failed for a real reason, turning a genuine defect into a count complaint.
 *
 * Written this way at birth rather than retrofitted: #853 is converting 32 files, and a new file
 * shipped with the old shape would be the thirty-third.
 */
process.on("exit", (code) => {
  const ran = results.length;
  /*
   * THE COUNT GUARD ASSERTS THE ARITHMETIC; THIS ASSERTS THE RENDERING (#881).
   *
   * `ran === EXPECTED` is true of a run whose results were never SHOWN. The report loop is
   * POSITIONAL — a case appended below it is recorded, counted, and invisible — and the count
   * guard was moved to exit precisely to escape that fragility. The loop never was, so the
   * guard bounds the arithmetic and nothing bounded the output.
   *
   * Two properties, two checks. Having built the first is what made the second feel
   * unnecessary.
   */
  if (code === 0 && printed !== ran) {
    console.error(
      `\nFAIL: ${ran} case(s) ran and ${printed} were printed — ${
        ran - printed
      } result(s) ` +
        `are INVISIBLE. A case below the report loop runs and counts; nothing shows it.`
    );
    process.exitCode = 1;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});

if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Workflow-only is asserted to be a PASS, so this cannot quietly\n` +
    `      become a demand that every proof be registered — which is a decision per file.`
);
