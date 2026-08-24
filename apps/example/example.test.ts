import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderHook,
  act,
  waitFor,
  render,
  cleanup,
} from "@testing-library/react";
import { useDeepAgentsChat } from "@deepagents-nextjs/react";
import { createMockDeepAgentsServer } from "@deepagents-nextjs/test-utils";

describe("useDeepAgentsChat with createMockDeepAgentsServer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates messages from SSE stream", async () => {
    // createMockDeepAgentsServer returns a mock Response with AI SDK v6 UIMessageStream
    const mockResponse = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() =>
      useDeepAgentsChat({
        sessionId: "test-session-1",
        endpoint: "/api/chat/stream",
      })
    );

    await act(async () => {
      result.current.sendMessage("hello");
    });

    // Wait for the hook's status to settle to "idle" — a fixed-duration sleep
    // is racy on slower CI runners (100ms isn't always enough). waitFor polls
    // until the assertion passes or the default 1s timeout, which is robust.
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.messages.length).toBeGreaterThan(0);
  });

  it("reports error status when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("network error")
    );

    const { result } = renderHook(() =>
      useDeepAgentsChat({
        sessionId: "test-session-2",
        endpoint: "/api/chat/stream",
      })
    );

    await act(async () => {
      result.current.sendMessage("hello");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("renders empty state placeholder when there are no messages", async () => {
    // Adversarial: the example page renders a "Send a message to start the demo"
    // placeholder when messages.length === 0. If the placeholder is removed, the
    // empty chat would just show a blank area — breaking the discoverability
    // contract for first-time users.
    //
    // We cannot render the page via @testing-library/react here because the page
    // imports @deepagents-nextjs/react which resolves a separate copy of React
    // (the "Invalid hook call" duplicate-React error). Instead we test the
    // empty-state contract by reading the page source — the placeholder MUST
    // exist, MUST be gated on the empty condition, and MUST be visible.
    //
    // If a future change refactors this away (e.g., removes the placeholder,
    // changes the gate condition, or hides it), this test fails.
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "./app/page.tsx"),
      "utf8"
    );

    // (1) The placeholder text must be present in the source
    expect(source).toMatch(/send a message to start the demo/i);

    // (2) The placeholder must be gated on messages.length === 0 (or !messages.length).
    // A stray unconditional copy would not be a real empty-state.
    expect(source).toMatch(/messages\.length\s*===\s*0|!messages\.length/);

    // (3) The placeholder must be rendered BEFORE the messages.map block,
    // NOT inside it. We assert source-order placement.
    const placeholderIdx = source.search(/send a message to start the demo/i);
    const mapIdx = source.search(/messages\.map\(/);
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeLessThan(mapIdx);

    // (4) The placeholder container must be visible to the user (not display:none,
    // not aria-hidden). A regression that hides the empty state would defeat its
    // discoverability purpose.
    //
    // The class assertion moved from `text-gray` to `text-muted-foreground`
    // when the app adopted @digitalfrontier/theme — a hardcoded palette class
    // is now a theme violation, so matching one would assert the wrong thing.
    //
    // It also gained the negative below. The comment above claims this checks
    // the element is not hidden, but a class match alone never did: adding
    // `hidden` or `aria-hidden` beside `text-center text-muted-foreground`
    // satisfies the regex while the placeholder is invisible. The check is
    // still source-text rather than a render, so it is not a full guarantee —
    // but it no longer passes over the exact regression its comment names.
    // Window, not a single line: the className sits on the opening tag, one
    // line above the text itself.
    const lines = source.split("\n");
    const hit = lines.findIndex((l) => /send a message to start the demo/i.test(l));
    expect(hit).toBeGreaterThan(-1);
    const placeholderBlock = lines.slice(Math.max(0, hit - 3), hit + 2).join("\n");
    expect(placeholderBlock).toMatch(/text-center[^"]*text-muted-foreground/);
    expect(placeholderBlock).not.toMatch(/\bhidden\b|aria-hidden/);
  });
});