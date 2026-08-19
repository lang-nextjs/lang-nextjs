import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/**/accumulator.ts"],
      // accumulator.ts is a copy from packages/server and is covered there;
      // duplication is intentional (no cross-package src import). Excluded
      // from this package's coverage to avoid double-counting expectations.
      // Thresholds pinned at current achieved levels — ratchet up as
      // tests are added. The point is regression protection, not
      // absolute level. Re-measure with `pnpm exec vitest run --coverage`
      // and raise after fixing.
      thresholds: {
        lines: 85,
        branches: 70,
        functions: 90,
        statements: 85,
      },
    },
  },
});
