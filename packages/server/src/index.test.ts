import { describe, it, expect } from "vitest";
import * as serverPkg from "./index";

describe("@deepagents-nextjs/server public API", () => {
  it("exports createDeepAgentsHandler function", () => {
    expect(typeof serverPkg.createDeepAgentsHandler).toBe("function");
  });

  it("exports defaultTransforms as a non-empty array", () => {
    expect(Array.isArray(serverPkg.defaultTransforms)).toBe(true);
    expect(serverPkg.defaultTransforms.length).toBeGreaterThan(0);
  });

  it("createDeepAgentsHandler returns a function (handler factory smoke test)", () => {
    const handler = serverPkg.createDeepAgentsHandler({
      backendUrl: "http://backend",
    });
    expect(typeof handler).toBe("function");
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

  it("createDeepAgentsHandler with empty-string backendUrl does not throw at construction time", () => {
    // The handler is a factory — construction must succeed regardless of
    // backendUrl value; runtime guards (e.g. 503) live in the handler body.
    // DESIGNED TO FAIL if the factory eagerly validates and throws.
    expect(() =>
      serverPkg.createDeepAgentsHandler({ backendUrl: "" })
    ).not.toThrow();
  });
});
