import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      // #1124: these thresholds were declared from the initial commit and never
      // evaluated, because nothing ran coverage. Enabled here so `pnpm test` enforces them.
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/**/accumulator.ts"],
      // accumulator.ts is a copy from packages/server and is covered there.
      // Thresholds pinned at current achieved levels — ratchet up as
      // tests are added.
      thresholds: {
        lines: 85,
        branches: 70,
        functions: 90,
        statements: 85,
      },
    },
  },
});
