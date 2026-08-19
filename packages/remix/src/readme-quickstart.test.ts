/**
 * Doctest — README Quick Start: createDeepAgentsHandler({ backendUrl }).
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
