// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRunStream } from "./useRunStream";

// Complete MockEventSource with all required fields for full EventSource compatibility
class MockEventSource {
  url: string;
  readyState: number = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSED
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private listeners: Map<string, Array<(e: Event | MessageEvent) => void>> =
    new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }

  addEventListener(type: string, fn: (e: Event | MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (e: Event | MessageEvent) => void
  ): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== fn)
    );
  }

  close(): void {
    this.readyState = 2;
    MockEventSource.closeSpy();
  }

  // Test helpers
  dispatch(type: string, data?: string): void {
    const evt =
      type === "message"
        ? new MessageEvent(type, { data: data ?? "" })
        : new Event(type);
    this.listeners.get(type)?.forEach((fn) => fn(evt));
    if (type === "message" && this.onmessage)
      this.onmessage(evt as MessageEvent);
    if (type === "error" && this.onerror) this.onerror(evt);
    if (type === "open" && this.onopen) this.onopen(evt);
  }

  static lastInstance: MockEventSource | null = null;
  static closeSpy = vi.fn();
}

beforeEach(() => {
  MockEventSource.lastInstance = null;
  MockEventSource.closeSpy = vi.fn();
  (global as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRunStream", () => {
  it("connects to the correct URL with runId and threadId", () => {
    renderHook(() =>
      useRunStream({ runId: "run-abc", threadId: "thread-xyz", enabled: true })
    );
    expect(MockEventSource.lastInstance?.url).toContain(
      "/api/open-swe/runs/run-abc/stream"
    );
    expect(MockEventSource.lastInstance?.url).toContain("threadId=thread-xyz");
  });

  it("updates events state when a message event arrives", async () => {
    const { result } = renderHook(() =>
      useRunStream({ runId: "run-1", threadId: "thread-1", enabled: true })
    );

    const payload = JSON.stringify({ type: "text-delta", delta: "hello" });
    await act(async () => {
      MockEventSource.lastInstance?.dispatch("message", payload);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      type: "text-delta",
      delta: "hello",
    });
  });

  it("calls EventSource.close() on unmount", () => {
    const { unmount } = renderHook(() =>
      useRunStream({ runId: "run-2", threadId: "thread-2", enabled: true })
    );
    unmount();
    expect(MockEventSource.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("sets status to error when EventSource fires error event", async () => {
    const { result } = renderHook(() =>
      useRunStream({ runId: "run-3", threadId: "thread-3", enabled: true })
    );

    await act(async () => {
      MockEventSource.lastInstance?.dispatch("error");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("ADV: SSE 'retry: <ms>' directive on a message does NOT close the EventSource (browser handles auto-reconnect)", async () => {
    // The SSE spec allows a `retry: <ms>` line before the `data:` line of
    // any message — when present, the browser EventSource will use that
    // value as the reconnect delay after a disconnect. The hook does NOT
    // implement its own reconnection on `retry:` — it relies on the browser.
    // This test pins: the hook does NOT call close() or trigger its own
    // reconnect logic when a mid-stream message arrives (regardless of any
    // retry directive the server may have emitted on the wire).
    const { result } = renderHook(() =>
      useRunStream({
        runId: "run-retry",
        threadId: "thread-retry",
        enabled: true,
      })
    );
    const es = MockEventSource.lastInstance!;

    // Simulate the browser firing the `open` event on the EventSource when
    // the response headers arrive. Without this, the hook stays in
    // 'connecting' — but the test's assertion is about message handling,
    // not connection lifecycle, so we put the hook into a streaming state
    // first.
    await act(async () => {
      es.dispatch("open");
    });

    // Dispatch a normal SSE message event. In real SSE wire format this
    // frame would be preceded by `retry: 5000\n`, but the browser abstracts
    // that away — the hook only sees the parsed MessageEvent.
    const payload = JSON.stringify({ type: "text-delta", delta: "partial" });
    await act(async () => {
      es.dispatch("message", payload);
    });

    expect(result.current.status).toBe("streaming");
    expect(result.current.events).toHaveLength(1);
    // The hook must NOT have closed the EventSource in response to a
    // mid-stream message — only on `[DONE]` or an actual error.
    expect(es.readyState).not.toBe(2);
    // No manual close — the hook lets the browser drive reconnection.
    expect(MockEventSource.closeSpy).not.toHaveBeenCalled();
  });

  it("stream isolation: two separate instances with different runIds do not share events", async () => {
    // Mount two hooks simultaneously — events dispatched via one MockEventSource
    // must not appear in the other's state.
    const { result: resultA } = renderHook(() =>
      useRunStream({ runId: "run-A", threadId: "thread-A", enabled: true })
    );
    const instanceA = MockEventSource.lastInstance!;

    const { result: resultB } = renderHook(() =>
      useRunStream({ runId: "run-B", threadId: "thread-B", enabled: true })
    );
    const instanceB = MockEventSource.lastInstance!;

    expect(instanceA).not.toBe(instanceB);
    expect(instanceA.url).toContain("run-A");
    expect(instanceB.url).toContain("run-B");

    const payloadA = JSON.stringify({ type: "text-delta", delta: "from-A" });
    await act(async () => {
      instanceA.dispatch("message", payloadA);
    });

    // resultA has the event; resultB does not
    expect(resultA.current.events).toHaveLength(1);
    expect(resultB.current.events).toHaveLength(0);
  });
});
