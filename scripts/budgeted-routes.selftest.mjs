#!/usr/bin/env node
/**
 * budgeted-routes.selftest.mjs — prove the budget guard ACCEPTS truth and rejects the rest.
 *
 * WHY THIS FILE EXISTS, AND WHY IT COULD NOT BE WRITTEN BEFORE THE CHECKER CHANGED.
 *
 * `budgetedRoutes()` took no arguments. Its subject was the repo it lives in, fixed at module
 * scope, so the only tree it could ever judge was one whose routes are all fork-guaranteed. A
 * test around that shape can assert "the real repo passes" and nothing else — it can never
 * observe a rejection, which makes it the thing this repo keeps finding: a check nobody has seen
 * fail. The design fix came first; this file is only possible because of it.
 *
 * THE DEFECT THE DESIGN FIX REMOVED, which case 2 pins.
 *
 * Each role used to carry TWO hand-written fields — `path` (what Lighthouse budgets) and `file`
 * (what the fork-guarantee was computed over) — and nothing checked they corresponded. Re-map
 * `path` to a rung-owned route, leave `file` on the old shared one, and the guard proved
 * fork-survival for a file that no longer served the budgeted url: a guarantee computed about a
 * different subject than the one the budget applied to. `file` is now derived from `path`, so the
 * two cannot disagree — the correspondence was removed rather than checked.
 *
 * THE BASELINE-ACCEPT CASE RUNS FIRST, and that ordering is not cosmetic. `rungs.schema.json`
 * once rejected EVERY document, so injecting a forbidden field still produced "rejected" and the
 * prohibition looked enforced. A guard that rejects everything is indistinguishable from one that
 * rejects the right things unless something asserts a known-good input is ACCEPTED.
 *
 * Fixtures are PLANTED, never borrowed from the real tree. An earlier selftest of mine borrowed a
 * live defect for its reject case and broke the day someone fixed it — the case was measuring the
 * repo, not the checker.
 *
 * Usage: node scripts/budgeted-routes.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetedRoutes } from "./budgeted-routes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (what, detail = "") => {
  console.log(`  ok   ${what.padEnd(58)} ${detail}`);
  pass++;
};
const bad = (what, detail = "") => {
  console.error(`  FAIL ${what.padEnd(58)} ${detail}`);
  fail++;
};

/**
 * A throwaway git repo shaped like the real one in the ways the guard reads.
 *
 * The 110 filler files are load-bearing: classify() refuses a tree under 100 tracked files,
 * because a tiny tree means a broken walk or a wrong cwd rather than a small repo, and every
 * assertion over it would be vacuously true.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "budgeted-routes-selftest-"));
  const page = "export default function P() {\n  return null;\n}\n";
  const write = (rel, body) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  write("apps/example/app/page.tsx", page); //            /
  write("apps/example/app/dashboard/page.tsx", page); //  /dashboard
  write("apps/example/app/owned/page.tsx", page); //      /owned        (rung-owned)
  write("apps/example/app/unclassified/page.tsx", page); ///unclassified (in no glob)
  write("apps/example/app/(grp)/grouped/page.tsx", page); // /grouped   (route group)
  write("apps/example/app/_private/page.tsx", page); //    no url at all
  // Two files serving the SAME url — a route group colliding with a plain segment.
  write("apps/example/app/dup/page.tsx", page);
  write("apps/example/app/(other)/dup/page.tsx", page);

  for (let i = 0; i < 110; i++) write(`filler/f${i}.txt`, "x\n");

  writeFileSync(
    join(root, "rungs.json"),
    JSON.stringify(
      {
        shapes: ["conversation", "run"],
        states: ["implemented", "planned"],
        rungs: [
          {
            id: "r4",
            ordinal: 4,
            shape: "run",
            state: "implemented",
            requires: [],
            languages: ["ts"],
            runtimes: [],
            target: { kind: "none" },
            owns: { ts: ["apps/example/app/owned/**"] },
            ownedFileCount: 1,
          },
        ],
        shared: {
          paths: [
            "apps/example/app/page.tsx",
            "apps/example/app/dashboard/**",
            "apps/example/app/(grp)/**",
            "apps/example/app/(other)/**",
            "apps/example/app/dup/**",
            "apps/example/app/_private/**",
            "filler/**",
            "rungs.json",
          ],
        },
      },
      null,
      2
    )
  );

  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

/** Run the guard, returning either the resolved roles or the thrown message. */
function run(root, roles) {
  try {
    return { accepted: true, routes: budgetedRoutes(root, roles) };
  } catch (err) {
    return { accepted: false, message: err.message };
  }
}

const root = fixture();
try {
  // --- 1. BASELINE ACCEPT, first, or every rejection below proves nothing ---------------------
  const base = run(root, [
    { role: "shell", path: "/dashboard" },
    { role: "streaming-run-view", path: "/" },
  ]);
  if (base.accepted && base.routes.length === 2) {
    ok("a fork-guaranteed set is ACCEPTED", "(not a reject-everything guard)");
  } else {
    bad("baseline accept", base.message ?? `got ${base.routes?.length} routes`);
  }

  // --- 2. THE CORRESPONDENCE, which used to be two hand-written fields ------------------------
  const derived = Object.fromEntries(
    (base.routes ?? []).map((r) => [r.path, r.file])
  );
  if (
    derived["/"] === "apps/example/app/page.tsx" &&
    derived["/dashboard"] === "apps/example/app/dashboard/page.tsx"
  ) {
    ok("the file is DERIVED from the budgeted path", "(cannot disagree)");
  } else {
    bad("derivation", JSON.stringify(derived));
  }

  // --- 3-6. REJECTIONS, each asserting WHICH one fired ----------------------------------------
  // "Something failed" is not enough: eject's census gate once refused correctly and crashed
  // with a raw stack, so the refusal happened and the message a maintainer needs was buried.
  const cases = [
    ["a rung-owned route is REJECTED", "/owned", /OWNED BY RUNG "r4"/],
    [
      "an unclassified route is REJECTED",
      "/unclassified",
      /is neither rung-owned nor/,
    ],
    ["a path no page serves is REJECTED", "/nope", /no page file under/],
    ["an AMBIGUOUS path is REJECTED", "/dup", /AMBIGUOUS — 2 page files/],
    ["a private folder serves no url", "/_private", /no page file under/],
  ];
  for (const [what, path, pattern] of cases) {
    const r = run(root, [{ role: "x", path }]);
    if (r.accepted) bad(what, "it was accepted");
    else if (!pattern.test(r.message))
      bad(what, `rejected for the wrong reason: ${r.message.slice(0, 90)}`);
    else ok(what, "(and names why)");
  }

  // --- 7. A ROUTE GROUP CONTRIBUTES NO URL SEGMENT --------------------------------------------
  // The reason the map is read off the tree instead of computed from the path: a formula would
  // look for `app/grouped/page.tsx`, not find it, and call a healthy route missing.
  const grouped = run(root, [{ role: "x", path: "/grouped" }]);
  if (grouped.accepted && grouped.routes[0].file.includes("(grp)")) {
    ok("a route group serves its ungrouped url", "(formula would miss it)");
  } else {
    bad("route group", grouped.message ?? JSON.stringify(grouped.routes));
  }

  // --- 8. NON-VACUITY -------------------------------------------------------------------------
  // Budgeting nothing satisfies "every budgeted route is fork-guaranteed" trivially.
  const empty = run(root, []);
  if (!empty.accepted && /no roles declared/.test(empty.message)) {
    ok("an empty role set is REJECTED", "(vacuous pass refused)");
  } else {
    bad("non-vacuity", "an empty budget was accepted");
  }

  // --- 9. THE MANIFEST FOLLOWS THE ROOT -------------------------------------------------------
  // classify()'s default manifest is the one read from THIS repo. If budgetedRoutes passed only a
  // cwd, it would walk the fixture and classify against the repo's rules — one call, two trees.
  // /owned is rung-owned in the FIXTURE manifest and matches nothing in the repo's, so this
  // rejection is only possible if the manifest travelled with the root.
  const split = run(root, [{ role: "x", path: "/owned" }]);
  if (!split.accepted && /OWNED BY RUNG "r4"/.test(split.message)) {
    ok("the manifest travels with the root", "(one parameter, one subject)");
  } else {
    bad("split subject", "the fixture manifest was not the one consulted");
  }

  // --- 10. AND THE SHIPPED CONFIG ITSELF ------------------------------------------------------
  // Everything above judges planted fixtures. This asserts the guard is right about the roles the
  // repo actually budgets — otherwise the suite proves a mechanism nobody uses.
  const real = run(REPO);
  if (
    real.accepted &&
    real.routes.length > 0 &&
    real.routes.every((r) => r.file)
  ) {
    ok(
      "the repo's own declared roles resolve",
      `(${real.routes.length} routes)`
    );
  } else {
    bad("real config", real.message ?? "no routes resolved");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const EXPECTED_CASES = 11;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(
    `FAIL: ${fail}/${total}. budgeted-routes.mjs is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The guard accepts a fork-guaranteed set, rejects rung-owned,\n` +
    `      unclassified, missing and ambiguous routes, refuses an empty budget, and derives\n` +
    `      each file from the path it budgets rather than trusting a second hand-written field.`
);
