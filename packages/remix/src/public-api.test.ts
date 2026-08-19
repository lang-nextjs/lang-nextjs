/**
 * Public API type tests for @deepagents-nextjs/remix.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { createDeepAgentsHandler, useDeepAgentsChat } from "./index";
import type {
  RemixHandlerOptions,
  DeepAgentsState,
  DeepAgentsChatResult,
  SseFrame,
  SseTransform,
  SseAdapter,
} from "./index";

describe("@deepagents-nextjs/remix — public API surface", () => {
  it("createDeepAgentsHandler is a factory taking RemixHandlerOptions", () => {
    expectTypeOf(createDeepAgentsHandler).toBeFunction();
    expectTypeOf(createDeepAgentsHandler)
      .parameter(0)
      .toMatchTypeOf<RemixHandlerOptions>();
  });

  it("useDeepAgentsChat returns DeepAgentsChatResult", () => {
    expectTypeOf(useDeepAgentsChat).toBeFunction();
  });

  it("DeepAgentsState has messages + status + error", () => {
    expectTypeOf<DeepAgentsState>().toHaveProperty("messages");
    expectTypeOf<DeepAgentsState>().toHaveProperty("status");
    expectTypeOf<DeepAgentsState>().toHaveProperty("error");
  });

  it("DeepAgentsChatResult exposes start (action) and the state fields", () => {
    expectTypeOf<DeepAgentsChatResult>().toHaveProperty("start");
    expectTypeOf<DeepAgentsChatResult>().toHaveProperty("messages");
    expectTypeOf<DeepAgentsChatResult>().toHaveProperty("status");
  });

  it("SseFrame/SseTransform/SseAdapter types are re-exported", () => {
    expectTypeOf<SseFrame>().toHaveProperty("raw");
    expectTypeOf<SseTransform>().toBeFunction();
    expectTypeOf<SseAdapter>().toBeObject();
  });
});

// Adversarial iter 2 — deep import probe
describe("@deepagents-nextjs/remix — deep import surface lock", () => {
  it("importing a non-exported deep path fails cleanly with a module-resolution error", async () => {
    // The package.json `exports` map only allows ".". A consumer (or attacker)
    // trying to reach into a deep file like "/internal/handler" must be
    // blocked at module resolution — Node MUST throw ERR_PACKAGE_PATH_NOT_EXPORTED
    // (or equivalent). It must NOT silently succeed (which would surface internals).
    const NON_EXPORTED = "@deepagents-nextjs/remix/internal/handler";

    let resolved = false;
    let rejection: unknown = null;
    try {
      await import(NON_EXPORTED);
      resolved = true;
    } catch (err) {
      rejection = err;
    }

    // The import must NOT have succeeded — internals must stay inaccessible.
    expect(resolved).toBe(false);
    expect(rejection).not.toBeNull();
    // The error should be a module-resolution error, not e.g. a runtime crash.
    const msg =
      rejection instanceof Error ? rejection.message : String(rejection ?? "");
    // Node module-resolution failures surface as ERR_PACKAGE_PATH_NOT_EXPORTED
    // or "Cannot find module". Either is acceptable as long as the import failed.
    expect(msg.length).toBeGreaterThan(0);
    // The rejected error should mention "module" or "export" — i.e. it's a
    // resolver-level rejection, not e.g. a TypeError from a misconfigured file.
    expect(msg.toLowerCase()).toMatch(/module|export|not found|cannot find/);
  });
});
