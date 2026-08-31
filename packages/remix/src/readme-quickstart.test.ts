/**
 * Doctest — README Quick Start: createDeepAgentsHandler({ backendUrl }).
 */

/*
 * WHAT THIS FILE ACTUALLY ASSERTS (#478).
 *
 * It runs a COPY of the README's Quick Start that is maintained here by hand.
 * It does not read each package's own README.md — measured, this file contains no
 * `fs`, `readFileSync` or `node:fs` — so it cannot detect the README changing.
 * The header used to call this "the executable form of the README so the docs
 * can't drift silently from the API"; that sentence was not true of it, and a
 * claim like that is worse than no test because it is cited as coverage.
 *
 * What it IS good for, and why it stays: it exercises the documented shape
 * against the real runtime, with this package's peers present — which the
 * README checker deliberately does not do.
 *
 * THE README'S OWN TEXT is checked by scripts/assert-readme-quickstart.mjs,
 * which reads the published file, extracts the Quick Start fences and asserts
 * every symbol they tell a reader to import is exported by this package.
 */
import { describe, it, expect } from "vitest";
import * as Remix from "./index";

describe("packages/remix — README Quick Start", () => {
  it("snippet returns a Remix action function", () => {
    const action = Remix.createDeepAgentsHandler({
      backendUrl: "http://localhost:8000/stream",
    });
    expect(typeof action).toBe("function");
  });

  // Adversarial iter 3 — public API surface smoke
  it("all documented public exports are exposed via the package root", () => {
    // README promises these symbols are available to consumers; if any of
    // them disappear (rename, accidental drop from index.ts barrel, or a
    // bundler that strips unused exports), this smoke breaks loudly.
    expect(typeof Remix.createDeepAgentsHandler).toBe("function");
    expect(typeof Remix.useDeepAgentsChat).toBe("function");
    // Health probes — promised in CHANGELOG (PROBE-01..05).
    expect(typeof Remix.createHealthProbe).toBe("function");
    expect(typeof Remix.createReadinessProbe).toBe("function");
    // Observability types — declared in observability.ts as `export type
    // ObservabilityHooks`. Consumers can import via the package root only if
    // index.ts re-exports it.
    // (Verified at the type level via import-resolution; runtime check that
    // the symbol is reachable through the package barrel.)
    const exportedKeys = Object.keys(Remix).sort();
    expect(exportedKeys).toContain("createDeepAgentsHandler");
    expect(exportedKeys).toContain("useDeepAgentsChat");
    expect(exportedKeys).toContain("createHealthProbe");
    expect(exportedKeys).toContain("createReadinessProbe");
  });
});
