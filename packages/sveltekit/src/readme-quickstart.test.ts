/**
 * Doctest — README Quick Start: createDeepAgentsHandler({ backendUrl }).
 */
import { describe, it, expect } from "vitest";
import { createDeepAgentsHandler } from "./index";

describe("packages/sveltekit — README Quick Start", () => {
  it("snippet returns a SvelteKit RequestHandler-like function", () => {
    const POST = createDeepAgentsHandler({
      backendUrl: "http://localhost:8000/stream",
    });
    expect(typeof POST).toBe("function");
  });
});
