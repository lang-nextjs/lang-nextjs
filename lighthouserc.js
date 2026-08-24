/**
 * Core Web Vitals + accessibility budget for the example app.
 *
 * WAS lighthouserc.json. It became JS for one reason: the URL list must be
 * DERIVED, not typed. The JSON version hardcoded three URLs, one of which
 * (/open-swe) had not existed since #19 moved open-swe to its own app on
 * :3001 — so this workflow failed every run with Lighthouse's own
 * ERRORED_DOCUMENT_REQUEST, which is Lighthouse falling over rather than us
 * checking. Hardcoding is what let that rot sit; #6 makes apps/example degrade
 * per rung, so route existence becomes rung-dependent and a typed list would
 * rot again on the next eject.
 *
 * scripts/budgeted-routes.mjs is the single source: it selects routes by ROLE
 * and proves, via the same classifier the severability gate uses, that each is
 * owned by no rung and therefore present in every fork. If that proof fails
 * this config throws and the job dies here — deliberately, rather than
 * producing a green score over surface half the forks do not have.
 *
 * The server is started and PREFLIGHTED by the workflow before this runs (see
 * .github/workflows/performance.yml), which is why there is no
 * startServerCommand: a budgeted route that 404s has to fail as our assertion,
 * naming the route, not as a Lighthouse plumbing error.
 */

const { execFileSync } = require("node:child_process");

const ORIGIN = process.env.LHCI_ORIGIN || "http://localhost:3000";

// Synchronous on purpose: if the route list cannot be proven, there is no
// meaningful config to hand Lighthouse, and execFileSync throws with the
// script's own diagnostic naming the offending route.
const url = execFileSync(process.execPath, ["scripts/budgeted-routes.mjs"], {
  cwd: __dirname,
  encoding: "utf8",
  env: { ...process.env, LHCI_ORIGIN: ORIGIN },
})
  .trim()
  .split("\n")
  .filter(Boolean);

module.exports = {
  ci: {
    collect: {
      url,
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        throttlingMethod: "devtools",
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.8 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.85 }],
        "categories:seo": ["warn", { minScore: 0.8 }],
        "first-contentful-paint": ["warn", { maxNumericValue: 2000 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "total-blocking-time": ["warn", { maxNumericValue: 300 }],
        interactive: ["warn", { maxNumericValue: 3500 }],

        // DELIBERATE DIVISION OF LABOUR, not a silenced failure. Contrast is
        // gated by axe-core in e2e/accessibility.spec.ts, which audits more
        // routes and names the offending selectors; turning this back on
        // duplicates that with a worse diagnostic.
        //
        // KNOW WHAT THIS COSTS — measured, not assumed. Planting a ~1.9:1
        // contrast violation on /dashboard: the audit still RUNS with the
        // assertion off (score 0, 1 failing node) and still feeds the category,
        // but the category only fell 1.000 -> 0.960. The floor above is 0.90,
        // so THE JOB STILL PASSED. Failing color-contrast outright costs ~0.04
        // of the accessibility category, which means this workflow cannot fail
        // on contrast alone no matter how bad the contrast is.
        //
        // So the division of labour is real and it is LOAD-BEARING: axe in
        // e2e/accessibility.spec.ts is the ONLY contrast gate. If a route ever
        // drops out of that spec, nothing here covers it — do not assume the
        // >= 0.9 accessibility floor is a backstop, because it is not one.
        //
        // (History cannot settle the original intent: lighthouserc has only
        // ever been touched by the squashed initial commit. The reasoning
        // above is measured, not inherited.)
        "color-contrast": "off",

        "errors-in-console": "off",
        "legacy-javascript-insight": "off",
        "network-dependency-tree-insight": "off",
        "unused-javascript-insight": "off",
        "render-blocking-insight": "off",
        "third-parties-insight": "off",
        "modern-image-formats": "off",
        "uses-rel-preconnect": "off",
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
