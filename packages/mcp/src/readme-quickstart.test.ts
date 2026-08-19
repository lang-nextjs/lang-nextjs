/**
 * Doctest — README Quick Start: createDeepAgentsMcpServer({ apiUrl, apiKey }).
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
