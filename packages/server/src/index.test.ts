import { describe, it, expect } from "vitest";
import * as serverPkg from "./index";

// Only assertions true at EVERY rung live here. createDeepAgentsHandler's behaviour moved to
// deepagents-handler.test.ts, which rungs.json claims for the deepagents rung: a core barrel
// test that calls a rung's export cannot survive an eject that drops that rung.

describe("@deepagents-nextjs/server public API", () => {

  it("exports defaultTransforms as a non-empty array", () => {
    expect(Array.isArray(serverPkg.defaultTransforms)).toBe(true);
    expect(serverPkg.defaultTransforms.length).toBeGreaterThan(0);
  });


  // ---------------------------------------------------------------------------
  // Adversarial edge-case tests (iteration 6)
  // ---------------------------------------------------------------------------

  it("every entry in defaultTransforms is callable as (frame) => frame|null", () => {
    // DESIGNED TO FAIL if defaultTransforms contains a non-function, a function
    // that throws synchronously, or a function with the wrong arity.
    for (const t of serverPkg.defaultTransforms) {
      expect(typeof t).toBe("function");
      const result = t({ raw: "data: hello\n\n" });
      // Either a frame-like object with `raw` or null is acceptable.
      if (result !== null) {
        expect(result).toHaveProperty("raw");
      }
    }
  });

});
