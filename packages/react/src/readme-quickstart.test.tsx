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
