import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // #1124: CI's Test step enforces these, with --coverage, on the full tree only. A plain
      // `pnpm test`, and every ejected fork, runs without them (see ci.yml for why).
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 90,
        statements: 85,
      },
    },
  },
});
