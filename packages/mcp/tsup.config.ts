import { defineConfig } from "tsup";

/**
 * THE SAME BUILD, DECLARED WHERE A QUERY CAN SEE IT (#1089).
 *
 * This package emitted declarations all along, via `--dts` on the command line in its build
 * script and with no tsup config at all. Nothing was broken; it was INVISIBLE. Any checker,
 * audit or grep that enumerates declaration-emitting packages by reading tsup configs found
 * seven of the eight that publish a `types` field and was silently wrong about this one, and
 * a correct answer required knowing to read build scripts too — which nothing said.
 *
 * THIS IS A CHANGE OF CHANNEL, NOT OF BEHAVIOUR. The four settings below are exactly the four
 * the command line carried: `src/index.ts`, `--format esm,cjs`, `--dts`, `--clean`.
 *
 * `outExtension` IS EXPLICIT RATHER THAN INHERITED, and it is the one line here that was not
 * on the command line. package.json requires `dist/index.mjs` and `dist/index.js`, which tsup
 * produces by default for a dual esm+cjs build — so this pins an output shape the manifest
 * already depends on instead of leaving it resting on a default. Same expression the sibling
 * packages use.
 *
 * DELIBERATELY NOT COPIED FROM THE SIBLINGS: they also set `sourcemap`, `target: "es2020"` and
 * `treeshake`. This package's build never had them, so adopting them here would be a real
 * behaviour change riding on a visibility fix. That divergence is left standing and open on
 * #1089 rather than closed in passing.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  },
});
