import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDeepAgentsChat } from "./hook";

/**
 * `stop` ABORTS THE REQUEST — asserted on the AbortSignal, not on the function.
 *
 * #262 asks for exactly this distinction, and it is the whole point: the defect
 * was never that `stop` threw. `useChat` has always returned it; the wrapper
 * simply did not pass it on. So a test that calls `stop()` and checks it did not
 * crash would have passed against the broken build too — the function would just
 * have been `undefined`, and `undefined?.()` is quiet.
 *
 * NO `vi.mock("@ai-sdk/react")` IN THIS FILE, deliberately. hook.test.ts mocks
 * the SDK, which is right for testing the wrapper's own logic and useless here:
 * against a mocked `stop`, "stop was called" is a statement about the mock. What
 * makes this an abort is the real SDK reaching the real fetch, so this file
 * stubs one layer lower — global fetch — and reads the signal it was handed.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A response that opens and never finishes, so the request stays in flight. */
function stallingFetch(): { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
        // never closed — the point is that the stream is still open when we abort
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  }) as unknown as typeof fetch;
  return { signals };
}

describe("stop() aborts the in-flight request (#262)", () => {
  it("the AbortSignal the request was made with actually fires", async () => {
    const { signals } = stallingFetch();
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "s1", endpoint: "/api/chat/stream" })
    );

    await act(async () => {
      result.current.sendMessage("hello");
    });
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    // The control: before stop, the request is genuinely live. Without this an
    // already-aborted signal would satisfy the assertion below for free.
    expect(
      signals[0].aborted,
      "the request was already aborted before stop() — the assertion below proves nothing"
    ).toBe(false);

    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(signals[0].aborted).toBe(true));
  });

  it("stop is a function on the returned surface, not undefined", async () => {
    // Weak on its own — kept because it names the ACTUAL regression shape. The
    // wrapper dropped the key entirely, so `stop` was `undefined` and every call
    // site using `stop?.()` stayed silent. This fails loudly on that.
    stallingFetch();
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "s1", endpoint: "/api/chat/stream" })
    );
    expect(typeof result.current.stop).toBe("function");
  });

  it("calling stop while idle does not throw", async () => {
    stallingFetch();
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "s1", endpoint: "/api/chat/stream" })
    );
    await act(async () => {
      result.current.stop();
    });
    expect(result.current.status).toBe("idle");
  });
});
