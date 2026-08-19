/**
 * Public API type tests for @deepagents-nextjs/mcp.
 */
import { describe, it, expectTypeOf } from "vitest";
import {
  createDeepAgentsMcpServer,
  type DeepAgentsMcpOptions,
} from "./index";

describe("@deepagents-nextjs/mcp — public API surface", () => {
  it("createDeepAgentsMcpServer is a factory taking DeepAgentsMcpOptions", () => {
    expectTypeOf(createDeepAgentsMcpServer).toBeFunction();
    expectTypeOf(createDeepAgentsMcpServer)
      .parameter(0)
      .toEqualTypeOf<DeepAgentsMcpOptions>();
  });

  it("DeepAgentsMcpOptions has apiUrl + apiKey strings", () => {
    expectTypeOf<DeepAgentsMcpOptions["apiUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<DeepAgentsMcpOptions["apiKey"]>().toEqualTypeOf<string>();
  });
});
