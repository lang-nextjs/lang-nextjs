import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  oxc: {
    // Required for JSX in test files (ToolCard, RunDetail page, hooks).
    // vite 8 transforms via Rolldown/oxc; the legacy `esbuild` option is
    // ignored, so JSX config must live under `oxc`.
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
});
