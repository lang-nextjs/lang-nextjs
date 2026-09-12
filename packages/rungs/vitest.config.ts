import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // #1124: CI's Test step enforces these, with --coverage, on the full tree only. A plain
      // `pnpm test`, and every ejected fork, runs without them (see ci.yml for why).
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
