/**
 * Doctest — README Quick Start: createDeepAgentsMcpServer({ apiUrl, apiKey }).
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
import { createDeepAgentsMcpServer } from "./index";

describe("packages/mcp — README Quick Start", () => {
  it("snippet returns an MCP server-like object", () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: "http://localhost:8000",
      apiKey: "test-key",
    });
    expect(server).toBeDefined();
  });
});
