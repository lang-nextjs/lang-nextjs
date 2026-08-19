/**
 * Doctest — verifies the README Quick Start renders without error.
 *
 * The README claims:
 *
 *   import { useDeepAgentsChat } from '@deepagents-nextjs/react';
 *   const { messages, sendMessage, status } = useDeepAgentsChat({
 *     sessionId: 'abc-123', endpoint: '/api/chat/stream',
 *   });
 *
 * This test renders a minimal component using the documented hook
 * signature so the README example can't drift from the actual API.
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDeepAgentsChat } from "./index";

describe("packages/react — README Quick Start", () => {
  it("exact useDeepAgentsChat snippet returns messages + sendMessage + status", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc-123",
        endpoint: "/api/chat/stream",
      })
    );
    expect(result.current).toHaveProperty("messages");
    expect(result.current).toHaveProperty("sendMessage");
    expect(result.current).toHaveProperty("status");
    expect(typeof result.current.sendMessage).toBe("function");
    expect(Array.isArray(result.current.messages)).toBe(true);
  });
});
