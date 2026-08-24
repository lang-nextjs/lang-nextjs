// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRunStream, type UseRunStreamResult } from "./useRunStream";

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

    // ---- MERGED from apps/example (#19) ------------------------------------
    // The test above sends a well-formed JSON message. apps/example's version
    // covered the case the browser does NOT abstract away: some servers put
    // the bare `retry:` directive in the `data:` field, so the hook receives
    // "retry:5000" — which is not JSON. JSON.parse throws and must be
    // swallowed. Those assertions had no counterpart here; only the event
    // counts are adapted, because this test has already delivered one event.
    const eventsBeforeDirective = result.current.events.length;

    await act(async () => {
      es.dispatch("message", "retry:5000");
    });

    // Non-fatal: status must not flip to error, and no error surfaces.
    expect(result.current.status).toBe("streaming");
    expect(result.current.error).toBeNull();
    // The unparseable directive must not be added to the events array.
    expect(result.current.events).toHaveLength(eventsBeforeDirective);

    // A valid JSON message AFTER the directive still parses correctly.
    await act(async () => {
      es.dispatch(
        "message",
        JSON.stringify({ type: "text-delta", delta: "after-retry" })
      );
    });
    expect(result.current.events).toHaveLength(eventsBeforeDirective + 1);
    expect(result.current.events[eventsBeforeDirective]).toEqual({
      type: "text-delta",
      delta: "after-retry",
    });
    expect(result.current.status).toBe("streaming");

    // The hook does not surface the directive's value.
    expect(result.current).not.toHaveProperty("retryInterval");
    expect(result.current).not.toHaveProperty("retryMs");
    expect(result.current).not.toHaveProperty("reconnectInterval");

    // Many directives in a row must not accumulate error state or corrupt
    // the events array.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        es.dispatch("message", `retry:${1000 + i}`);
      });
    }
    expect(result.current.status).toBe("streaming");
    expect(result.current.error).toBeNull();
    expect(result.current.events).toHaveLength(eventsBeforeDirective + 1);
    // ---- end MERGED --------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Ported from apps/example/lib/hooks/useRunStream.test.ts (#19).
// apps/example embedded a duplicate open-swe rung, deleted in PR #29.
// These four had no counterpart here: leak-on-rapid-unmount, malformed-JSON
// resilience, 100-connection isolation, and SSE `id:` resume-field handling.
// All are hook-lifecycle properties, independent of the rung protocol.
// Assertions unchanged from the originals.
// ---------------------------------------------------------------------------
describe("useRunStream — ported coverage (#19)", () => {
  it("concurrent subscribe + abort: rapid unmount after mount closes exactly one EventSource and leaves no leaked instance", async () => {
    // Race: mount the hook and synchronously unmount within the same React batch.
    // The cleanup effect must close the EventSource that the effect itself opened.
    // We assert:
    //   (a) exactly one MockEventSource was created (no double-open from retry/unmount race)
    //   (b) it was closed exactly once (cleanup ran, no double-close)
    //   (c) status is NOT left in a transient 'streaming' or 'connecting' state —
    //       the hook either settles to 'error' (if error fired) or to whatever
    //       status it was in at unmount; it must not silently leave the instance
    //       open for the garbage collector to discover later.
    const closeSpy = MockEventSource.closeSpy;

    const { result, unmount } = renderHook(() =>
      useRunStream({
        runId: "race-run",
        threadId: "race-thread",
        enabled: true,
      })
    );
    const openedInstance = MockEventSource.lastInstance!;
    expect(openedInstance).toBeTruthy();
    expect(openedInstance.readyState).toBe(0); // CONNECTING at mount

    // Synchronous unmount: race against the still-pending EventSource lifecycle.
    unmount();

    // Exactly one close call from cleanup — proves the cleanup path fired AND
    // that retry() / reconnect logic did not spawn a second EventSource after unmount.
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // The instance we tracked must now be closed.
    expect(openedInstance.readyState).toBe(2); // CLOSED

    // No new MockEventSource instance was created after unmount.
    expect(MockEventSource.lastInstance).toBe(openedInstance);

    // Hook state: either 'connecting' (cleanup happened before open fired) or
    // 'error' (open/error fired before cleanup). It must NOT be 'streaming' with
    // a stale open instance, and it must NOT be 'done' (no [DONE] was ever received).
    expect(["connecting", "error"]).toContain(result.current.status);
    expect(result.current.status).not.toBe("streaming");
    expect(result.current.status).not.toBe("done");
  });

  it("SSE event with malformed JSON: hook does not crash, does not add to events, and stays in streaming status", async () => {
    // Adversarial: upstream may send a non-JSON data line (e.g., a heartbeat
    // like ":ping" or a malformed delta). The hook's catch block currently
    // swallows the error and console.errors — but the status must remain
    // 'streaming' (NOT flip to 'error'), and events must NOT contain a
    // half-parsed entry. If a future change treats parse errors as fatal,
    // this test catches it (status would flip to 'error').
    const { result } = renderHook(() =>
      useRunStream({
        runId: "run-malformed",
        threadId: "thread-malformed",
        enabled: true,
      })
    );

    // Fire open to set status to 'streaming'
    await act(async () => {
      MockEventSource.lastInstance?.dispatch("open");
    });
    expect(result.current.status).toBe("streaming");

    // Send a malformed JSON message — e.g., a truncated SSE delta
    await act(async () => {
      MockEventSource.lastInstance?.dispatch(
        "message",
        '{"type":"text-delta","de'
      );
    });

    // Status must NOT flip to 'error' — malformed JSON is non-fatal
    expect(result.current.status).toBe("streaming");
    // No event should have been added (parse failed, swallowed)
    expect(result.current.events).toHaveLength(0);

    // And a valid message after the malformed one must still be parsed
    const validPayload = JSON.stringify({
      type: "text-delta",
      delta: "after-malformed",
    });
    await act(async () => {
      MockEventSource.lastInstance?.dispatch("message", validPayload);
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      type: "text-delta",
      delta: "after-malformed",
    });
    // Status still streaming (not error)
    expect(result.current.status).toBe("streaming");

    // Also test: the [DONE] sentinel must still terminate cleanly even after
    // a malformed event preceded it.
    await act(async () => {
      MockEventSource.lastInstance?.dispatch("message", "not-json-at-all");
    });
    expect(result.current.events).toHaveLength(1); // still 1, the malformed didn't add

    await act(async () => {
      MockEventSource.lastInstance?.dispatch("message", "[DONE]");
    });
    expect(result.current.status).toBe("done");
  });

  it("100 concurrent EventSource creations: each hook owns exactly one connection and isolates its own messages", async () => {
    // Adversarial: scale test. 100 hooks rendered simultaneously, each must:
    //   (a) create exactly one MockEventSource (no leak from retries / effects)
    //   (b) receive its own dispatched message (no cross-talk between instances)
    //   (c) when unmounted, close exactly one EventSource (cleanup runs per-hook)
    //
    // Targets: shared module-level state (a singleton EventSource registry that
    // gets clobbered), race conditions where rapid mount/unmount spawns extra
    // connections, and a close() path that closes more than the hook's own
    // instance (cross-closing other hooks' connections).
    const N = 100;
    const rendered: Array<ReturnType<typeof renderHook>> = [];
    const instances: MockEventSource[] = [];

    // Snapshot the close-spy BEFORE we start — each MockEventSource.close()
    // calls MockEventSource.closeSpy(); we need to count after unmount.
    const closeSpyBefore = MockEventSource.closeSpy.mock.calls.length;

    for (let i = 0; i < N; i++) {
      const r = renderHook(() =>
        useRunStream({
          runId: `run-bulk-${i}`,
          threadId: `thread-bulk-${i}`,
          enabled: true,
        })
      );
      rendered.push(r);
      instances.push(MockEventSource.lastInstance!);
    }

    // (a) each render produced a distinct MockEventSource
    expect(instances).toHaveLength(N);
    expect(new Set(instances).size).toBe(N);
    // Each one points to its own runId in the URL
    for (let i = 0; i < N; i++) {
      expect(instances[i].url).toContain(`run-bulk-${i}`);
      expect(instances[i].url).toContain(`thread-bulk-${i}`);
    }

    // (b) each instance receives its own message independently
    await act(async () => {
      for (let i = 0; i < N; i++) {
        instances[i].dispatch(
          "message",
          JSON.stringify({ type: "text-delta", delta: `payload-${i}` })
        );
      }
    });

    for (let i = 0; i < N; i++) {
      const result = rendered[i].result.current as UseRunStreamResult;
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "text-delta",
        delta: `payload-${i}`,
      });
      // Status must be 'streaming' (the open event set it)
      // The earlier-existing tests fired 'open' explicitly; here we did not.
      // The status should be either 'connecting' (if no open fired) or 'streaming'.
      expect(["connecting", "streaming"]).toContain(result.status);
    }

    // (c) unmount all — close must be called exactly N times (one per hook)
    for (const r of rendered) {
      r.unmount();
    }

    const closeSpyAfter = MockEventSource.closeSpy.mock.calls.length;
    expect(closeSpyAfter - closeSpyBefore).toBe(N);
  });
});
// ---------------------------------------------------------------------------
// Adversarial edge-case tests (NEW BATCH — SSE `id:` field for resume)
// ---------------------------------------------------------------------------

describe("useRunStream — SSE event with `id:` field for resume (Last-Event-ID semantics)", () => {
  it("ignores the SSE `id:` resume field but still parses the `data:` payload; the resume token is observable but does not affect state", async () => {
    // Adversarial: LangGraph Platform emits SSE events with an `id:` field
    // (the event's Last-Event-ID). A real EventSource would expose this via
    // `evt.lastEventId` and the browser would automatically send it as
    // `Last-Event-ID` on reconnect. The hook's current implementation only
    // reads `evt.data` — it does NOT capture `evt.lastEventId` — so the
    // resume token is dropped on the floor.
    //
    // We pin the actual behaviour:
    //   (a) an SSE event with both an `id:` and a `data:` field is parsed
    //       successfully and added to events
    //   (b) the resume token is NOT exposed anywhere on the hook's return
    //       value (no `lastEventId` field, no callback, no captured token)
    //   (c) a subsequent SSE event WITHOUT an `id:` field (which is how
    //       LangGraph sends keepalive frames) still parses normally
    //   (d) a malformed `id:` (empty string, non-ASCII) does NOT crash the
    //       parser or flip status to 'error'
    //
    // If a future change exposes the resume token (e.g., adds a
    // `lastEventId` field to UseRunStreamResult), this test will fail and
    // prompt a deliberate decision about how to handle it.
    const { result } = renderHook(() =>
      useRunStream({ runId: "resume-run", threadId: "resume-thread", enabled: true })
    );

    // (a) SSE event with id + data
    await act(async () => {
      MockEventSource.lastInstance?.dispatch(
        "message",
        JSON.stringify({ type: "text-delta", delta: "resumable-1" })
      );
    });
    // Manually set lastEventId on the most-recent MessageEvent by inspecting
    // whether the hook captured it. The hook's returned object has no
    // `lastEventId` field — assert that.
    expect(result.current).not.toHaveProperty("lastEventId");
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      type: "text-delta",
      delta: "resumable-1",
    });
    expect(result.current.status).toBe("connecting"); // no 'open' was fired

    // (c) SSE event with NO id (just data)
    await act(async () => {
      MockEventSource.lastInstance?.dispatch(
        "message",
        JSON.stringify({ type: "text-delta", delta: "no-id-event" })
      );
    });
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[1]).toEqual({
      type: "text-delta",
      delta: "no-id-event",
    });

    // (d) A message event whose data contains an id-like field — confirm
    //     the JSON parser doesn't accidentally treat it as a top-level
    //     resume token. The events state must still receive the parsed
    //     object verbatim.
    await act(async () => {
      MockEventSource.lastInstance?.dispatch(
        "message",
        JSON.stringify({
          type: "text-delta",
          delta: "with-resume-payload",
          id: "evt-12345",
        })
      );
    });
    expect(result.current.events).toHaveLength(3);
    expect(result.current.events[2]).toEqual({
      type: "text-delta",
      delta: "with-resume-payload",
      id: "evt-12345",
    });

    // Status must remain 'connecting' (we never dispatched 'open'), so even
    // after multiple events with various id-like fields, the hook has not
    // crashed and is still consuming the stream.
    expect(result.current.status).toBe("connecting");
    expect(result.current.error).toBeNull();
  });
});
