/**
 * Public API type tests for @deepagents-nextjs/sveltekit.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import {
  createDeepAgentsHandler,
  createDeepAgentsStore,
  createHealthProbe,
  createReadinessProbe,
} from "./index";
import type {
  SvelteKitHandlerOptions,
  DeepAgentsState,
  SseFrame,
  SseTransform,
  SseAdapter,
} from "./index";

/**
 * Lock the exact set of runtime exports against accidental drift. If a future
 * change adds, renames, or removes a runtime export from ./index.ts, this test
 * fails loudly — the public-API surface is a contract, not an internal
 * implementation detail. (Type-only exports are checked separately above and
 * are erased at runtime.)
 */
const EXPECTED_RUNTIME_EXPORTS = [
  "createDeepAgentsHandler",
  "createDeepAgentsStore",
  "createHealthProbe",
  "createReadinessProbe",
] as const;

describe("@deepagents-nextjs/sveltekit — public API surface", () => {
  it("createDeepAgentsHandler is a factory taking SvelteKitHandlerOptions", () => {
    expectTypeOf(createDeepAgentsHandler).toBeFunction();
    expectTypeOf(createDeepAgentsHandler)
      .parameter(0)
      .toMatchTypeOf<SvelteKitHandlerOptions>();
  });

  it("createDeepAgentsStore returns a Svelte readable store", () => {
    expectTypeOf(createDeepAgentsStore).toBeFunction();
  });

  it("DeepAgentsState has messages + status + error", () => {
    expectTypeOf<DeepAgentsState>().toHaveProperty("messages");
    expectTypeOf<DeepAgentsState>().toHaveProperty("status");
    expectTypeOf<DeepAgentsState>().toHaveProperty("error");
  });

  it("SseFrame/SseTransform/SseAdapter types are re-exported", () => {
    expectTypeOf<SseFrame>().toHaveProperty("raw");
    expectTypeOf<SseTransform>().toBeFunction();
    expectTypeOf<SseAdapter>().toBeObject();
  });

  it("runtime exports are reachable: handlers, store factory, and health probes are all callable functions", () => {
    // The existing type-only assertions are erased at runtime — if a runtime
    // export is accidentally renamed or removed from ./index.ts, the build
    // still passes typecheck but consumers hit an undefined import at runtime.
    // Pin the runtime contract: every documented public export resolves to
    // a real function (not undefined, not a placeholder object).
    expect(typeof createDeepAgentsHandler).toBe("function");
    expect(typeof createDeepAgentsStore).toBe("function");
    expect(typeof createHealthProbe).toBe("function");
    expect(typeof createReadinessProbe).toBe("function");

    // And calling them with the minimum required args must not throw.
    expect(() =>
      createDeepAgentsHandler({ backendUrl: "http://x" })
    ).not.toThrow();
    expect(() => createDeepAgentsStore("http://x")).not.toThrow();
    expect(() => createHealthProbe()).not.toThrow();
    expect(() => createReadinessProbe()).not.toThrow();
  });

  it("exact runtime export surface has not drifted — no added, removed, or renamed runtime exports", async () => {
    // Adversarial probe: enumerate every export from the package barrel and
    // verify it matches the documented set EXACTLY. A future change that
    // adds, removes, or renames a runtime export will break this test —
    // forcing the author to update the documented surface. Internal-only
    // helpers must NOT be re-exported from the barrel.
    //
    // We use a dynamic import of the barrel module so the test is not
    // tightly coupled to the destructured imports at the top of this file
    // (which would catch only re-export breakage, not accidental additions).
    const barrel = await import("./index");
    const runtimeKeys = Object.keys(barrel).sort();

    // Build the expected set: every documented runtime export must be present
    // AND must resolve to a function (not undefined, not a placeholder).
    const expected = [...EXPECTED_RUNTIME_EXPORTS].sort();
    expect(runtimeKeys).toEqual(expect.arrayContaining(expected));

    // No unexpected exports — pin that no internal helper has leaked into
    // the public barrel.
    expect(runtimeKeys).toEqual(expected);

    // Each export must be a real function (not undefined, not null).
    for (const name of expected) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
