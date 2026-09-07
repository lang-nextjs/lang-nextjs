/**
 * Stryker mutation testing config for @deepagents-nextjs/server.
 *
 * Coverage measures whether tests RAN against a line; mutation tests
 * measure whether tests CARE. A surviving mutant means the test suite
 * accepts a behavioral change without complaint — a real assertion gap.
 *
 * Threshold semantics:
 *   - high: ≥80% mutation score → reward
 *   - low:  ≥60% → acceptable
 *   - break: <50% → fail the run (gates the weekly CI job)
 *
 * Excluded from mutation: type-only definitions, debug helpers, and the
 * accumulator (covered separately + property-tested).
 */
export default {
  packageManager: "pnpm",
  // Explicit plugin list. Stryker's default discovery globs the flat
  // node_modules/@stryker-mutator/* directory, but pnpm's strict layout
  // hoists packages into the workspace-root .pnpm store and exposes them
  // only via symlinks — so the glob finds nothing and Stryker aborts with
  // "no TestRunner plugins were loaded". Naming the plugin makes Stryker
  // require() it directly (resolution verified working under pnpm).
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["html", "clear-text", "progress", "json"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
  },
  coverageAnalysis: "perTest",
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.test-d.ts",
    "!src/**/*.property.test.ts",
    "!src/index.ts",
    "!src/types.ts",
    "!src/debug.ts",
    // Assertion helpers, not shipped code: not exported from index.ts, and
    // tsup's entry is index.ts alone, so they never reach dist. Mutating them
    // would put a parser into the denominator of a gate that measures how well
    // the PRODUCT is tested.
    "!src/__testing__/**",
  ],
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  // Stryker is SLOW (~5-10 min for this package). Use timeout liberally
  // to avoid false failures on slow mutants.
  timeoutMS: 60_000,
  /*
   * NO `tempDirName`, AND FIVE TEST SUITES DEPEND ON THAT. Stryker copies this
   * package into `.stryker-tmp/sandbox-N/` and runs the suite from there, so every
   * test that reaches a repo-root artifact -- apps/, docs/, rungs.json -- locates
   * the root by searching upward from its own file (src/__testing__/repo-root.ts).
   * That search terminates at the real root only because the default temp directory
   * sits INSIDE the repository.
   *
   * WHAT SETTING THIS KEY ACTUALLY DOES IS NOT FULLY KNOWN, and the earlier version of
   * this comment asserted it confidently without anyone having driven it. Driven once,
   * with the temp dir in /tmp, the dry run went red -- but the TEST RUNNER CRASHED at
   * transform time with TSCONFIG_ERROR before any suite ran, so the refusal those five
   * would give was never reached and nothing listed the directories it searched. A
   * different "outside" may reach them; one configuration is not the class.
   *
   * AND `pnpm test` CANNOT SEE THIS KEY AT ALL. vitest never enters a sandbox, so the
   * step that runs before Stryker passes either way -- measured, 779/779 with the key
   * unset and 779/779 with it pointing outside the tree.
   *
   * So this is a dependency recorded HERE and in src/__testing__/repo-root.ts and
   * asserted NOWHERE. #1025 is the assertion -- not yet built -- and it belongs under
   * `pnpm test`, which reads this file and can therefore fire on it.
   */
  // Skip equivalent mutants like `(a + b) -> (b + a)` for arithmetic
  // commutativity (overrides default).
  disableTypeChecks: false,
};
