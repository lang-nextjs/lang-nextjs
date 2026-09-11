import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // #1089: declarations come from `tsc -p tsconfig.build.json` (see the build script),
  // i.e. from the repo\'s pinned TypeScript. tsup\'s dts path bundles them through its own
  // rollup worker instead, which is the compiler #1089 is removing.
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2020",
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  },
});
