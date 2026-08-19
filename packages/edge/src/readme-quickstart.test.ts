/**
 * Doctest — README Quick Start snippets compile and instantiate.
 *
 * README claims (Deno):
 *   const handler = createDenoHandler({ backendUrl: ..., adapter: ... });
 * README claims (Cloudflare):
 *   const handler = createCloudflareHandler({ backendUrl: ..., adapter: ... });
 *
 * Note: deepagentsAdapter from @deepagents-nextjs/server isn't usable from
 * the edge package's vitest run without cross-package import resolution.
 * Use a minimal local adapter shape that satisfies the adapter contract.
 */
import { describe, it, expect } from "vitest";
import { createDenoHandler, createCloudflareHandler } from "./index";

const minimalAdapter = { transforms: [] };

describe("packages/edge — README Quick Start", () => {
  it("createDenoHandler snippet returns a function", () => {
    const handler = createDenoHandler({
      backendUrl: "http://localhost:8000/stream",
      adapter: minimalAdapter,
    });
    expect(typeof handler).toBe("function");
  });

  it("createCloudflareHandler snippet returns a function", () => {
    const handler = createCloudflareHandler({
      backendUrl: "http://localhost:8000/stream",
      adapter: minimalAdapter,
    });
    expect(typeof handler).toBe("function");
  });

  // ---------------------------------------------------------------------------
  // Adversarial edge-case tests (iteration 6)
  // ---------------------------------------------------------------------------

  it("createDenoHandler with empty-string backendUrl returns 503 (not a throw)", async () => {
    // README snippet uses a literal backendUrl. Real-world: BACKEND_URL env
    // may be unset, yielding "". The handler must construct cleanly AND return
    // a 503 Response — not throw — when the resolved backendUrl is empty.
    const handler = createDenoHandler({
      backendUrl: "",
      adapter: minimalAdapter,
    });
    const response = await handler(
      new Request("https://example.com/api/chat", {
        method: "POST",
        body: "{}",
      })
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("BACKEND_URL");
  });

  it("createCloudflareHandler with empty-string backendUrl returns 503 (not a throw)", async () => {
    const handler = createCloudflareHandler({
      backendUrl: "",
      adapter: minimalAdapter,
    });
    const response = await handler(
      new Request("https://example.com/api/chat", {
        method: "POST",
        body: "{}",
      })
    );
    expect(response.status).toBe(503);
  });
});
