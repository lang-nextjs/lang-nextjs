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
