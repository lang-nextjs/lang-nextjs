/**
 * Behavioural tests for createDeepAgentsHandler — the DeepAgents rung's convenience entry point.
 *
 * These lived in index.test.ts, which is a CORE barrel test. That put rung-3 behaviour in a file
 * every fork keeps, so `pnpm eject langgraph` left index.test.ts calling a symbol its own barrel
 * no longer exported — a hard type error that failed the fork.
 *
 * The split is not cosmetic. index.test.ts asserts things about the barrel that are true at every
 * rung (defaultTransforms is a non-empty array of callables). These assert the behaviour of one
 * rung's wrapper, and so belong to that rung: rungs.json claims this file for `deepagents`, and
 * eject deletes it alongside deepagents-handler.ts itself.
 *
 * Core transport behaviour is NOT tested here — createSseProxyHandler is the rung-free
 * constructor and keeps its own coverage, which survives every eject.
 */
import { describe, it, expect } from "vitest";
import { createDeepAgentsHandler } from "./deepagents-handler";

describe("createDeepAgentsHandler — the DeepAgents rung entry point", () => {
  it("is a function", () => {
    expect(typeof createDeepAgentsHandler).toBe("function");
  });

  it("returns a handler function (factory smoke test)", () => {
    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    expect(typeof handler).toBe("function");
  });

  it("does not throw at construction time on an empty backendUrl", () => {
    // The handler is a factory — construction must succeed regardless of backendUrl value;
    // runtime guards (e.g. 503) live in the handler body.
    // DESIGNED TO FAIL if the factory eagerly validates and throws.
    expect(() => createDeepAgentsHandler({ backendUrl: "" })).not.toThrow();
  });
});
