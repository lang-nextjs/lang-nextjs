import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { createDeepAgentsStore } from "./store";
import type { DeepAgentsState } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function hangingStream(): {
  stream: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let closeFn: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      closeFn = () => controller.close();
    },
  });
  return { stream, close: closeFn };
}

function makeResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
  } as unknown as Response;
}

// Collect all store values emitted synchronously/asynchronously
async function collectStates(
  store: ReturnType<typeof createDeepAgentsStore>,
  waitMs = 100
): Promise<DeepAgentsState[]> {
  const states: DeepAgentsState[] = [];
  const unsub = store.subscribe((s) =>
    states.push({ ...s, messages: [...s.messages] })
  );
  await new Promise((r) => setTimeout(r, waitMs));
  unsub();
  return states;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDeepAgentsStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("store initializes with idle status", async () => {
    const { stream } = hangingStream();
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(stream)));
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api");
    const states: DeepAgentsState[] = [];
    const unsub = store.subscribe((s) =>
      states.push({ ...s, messages: [...s.messages] })
    );
    // First emitted value must be idle before fetch resolves
    expect(states[0]).toEqual({ messages: [], status: "idle", error: null });
    unsub();
  });

  it("store transitions to loading when fetch starts", async () => {
    const { stream } = hangingStream();
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(stream)));
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api");
    const states: DeepAgentsState[] = [];
    const unsub = store.subscribe((s) =>
      states.push({ ...s, messages: [...s.messages] })
    );
    // Give the async fetch chain a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(states.some((s) => s.status === "loading")).toBe(true);
    unsub();
  });

  it("store accumulates messages from SSE data frames", async () => {
    const body = makeStream(
      'data: {"type":"text-delta","textDelta":"hello"}\n\n',
      'data: {"type":"text-delta","textDelta":"world"}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    const final = states[states.length - 1];
    expect(final.messages).toHaveLength(2);
    expect(final.messages[0]).toEqual({
      type: "text-delta",
      textDelta: "hello",
    });
    expect(final.messages[1]).toEqual({
      type: "text-delta",
      textDelta: "world",
    });
  });

  it("store transitions to streaming on first SSE frame", async () => {
    const body = makeStream(
      'data: {"type":"text-delta","textDelta":"hello"}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    expect(states.some((s) => s.status === "streaming")).toBe(true);
  });

  it("store transitions to done when stream closes", async () => {
    const body = makeStream(
      'data: {"type":"text-delta","textDelta":"hello"}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    expect(states[states.length - 1].status).toBe("done");
  });

  it("store sets status=error and error field on fetch failure", async () => {
    const fetchError = new Error("Network failure");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(fetchError))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    const errorState = states.find((s) => s.status === "error");
    expect(errorState).toBeDefined();
    expect(errorState!.error).toBeInstanceOf(Error);
    expect(errorState!.error!.message).toBe("Network failure");
  });

  it("store aborts fetch when last subscriber detaches", async () => {
    const abortSpy = vi.fn();
    const mockController = { abort: abortSpy, signal: {} as AbortSignal };
    vi.spyOn(global, "AbortController").mockImplementation(function () {
      return mockController as unknown as AbortController;
    });

    const { stream } = hangingStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const unsub = store.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(abortSpy).toHaveBeenCalled();
  });

  it('store silently ignores SSE frames that do not start with "data: " (e.g. keep-alive comments)', async () => {
    // Restore any spies from the abort test that leaked through resetAllMocks
    vi.restoreAllMocks();
    // Non-data lines like ": keep-alive\n\n" are valid SSE but must not be
    // parsed as JSON — if the implementation tries JSON.parse on them it throws.
    const body = makeStream(
      ": keep-alive\n\n",
      'data: {"type":"text-delta","textDelta":"after-comment"}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    const final = states[states.length - 1];
    // The comment frame must be dropped; only the real data frame appears
    expect(final.messages).toHaveLength(1);
    expect((final.messages[0] as any).textDelta).toBe("after-comment");
    // Stream must reach 'done' — not 'error'
    expect(final.status).toBe("done");
  });

  it("store sets status=error when a data frame contains invalid JSON", async () => {
    // The store calls JSON.parse on every 'data: ' frame. Malformed JSON from
    // the backend will throw synchronously inside the async loop. If that
    // exception escapes the catch block (or the catch block re-throws), the
    // store will be left in a non-terminal state and the subscriber never sees
    // status='error'. This test ensures the catch path is exercised.
    vi.restoreAllMocks();
    const body = makeStream("data: {not valid json}\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    const errorState = states.find((s) => s.status === "error");
    expect(errorState).toBeDefined();
    // Must not reach 'done' — stream was aborted by the parse error
    expect(states[states.length - 1].status).not.toBe("done");
  });

  it("store does not include sessionId key in request body when options is omitted", async () => {
    // When the consumer does not pass options at all, the store should send
    // a minimal body ({}). If sessionId sneaks in as undefined the server may
    // reject the request or behave unexpectedly.
    vi.restoreAllMocks();
    const fetchMock = vi.fn(() => {
      const { stream } = hangingStream();
      return Promise.resolve(makeResponse(stream));
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api"); // no options
    const unsub = store.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    const sentBody = JSON.parse(callArgs[1].body as string);
    expect(Object.prototype.hasOwnProperty.call(sentBody, "sessionId")).toBe(
      false
    );
  });

  it("store appends duplicate SSE frames without deduplication — same payload appears twice", async () => {
    // Bug target: the store always does messages: [...s.messages, payload].
    // There is no identity check or deduplication guard. If the SSE stream emits the
    // same frame twice (e.g. due to a backend retry or network buffering replaying
    // a chunk), the message list will contain two identical entries.
    // This test documents the current behaviour. If the implementation later adds
    // deduplication (e.g. based on a message id field), this test will catch the change.
    vi.restoreAllMocks();
    const FRAME =
      'data: {"type":"text-delta","textDelta":"hello","id":"msg-1"}\n\n';
    // Emit the exact same frame twice in the stream
    const body = makeStream(FRAME, FRAME);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store);
    const final = states[states.length - 1];
    // Current behaviour: two identical messages (no dedup).
    // If this assertion fails (length is 1), the implementation added deduplication.
    expect(final.messages).toHaveLength(2);
    expect(final.messages[0]).toEqual(final.messages[1]);
  });

  it("store sends sessionId in request body when provided as empty string", async () => {
    // Restore any spies from the abort test that leaked through resetAllMocks
    vi.restoreAllMocks();
    // options.sessionId !== undefined check means "" must still be forwarded.
    // If the implementation silently drops "" it violates the contract
    // (callers may use "" as a valid sentinel for anonymous sessions).
    const fetchMock = vi.fn(() => {
      const { stream } = hangingStream();
      return Promise.resolve(makeResponse(stream));
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api", { sessionId: "" });
    const unsub = store.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    const sentBody = JSON.parse(callArgs[1].body as string);
    // sessionId key must be present (value is ""), not silently omitted
    expect(Object.prototype.hasOwnProperty.call(sentBody, "sessionId")).toBe(
      true
    );
    expect(sentBody.sessionId).toBe("");
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — store emits 'error' status (not 'done') when upstream
  // returns an HTTP 500 error response — callers must distinguish transport
  // failure from a clean empty stream.
  // -------------------------------------------------------------------------

  it("store treats HTTP 500 response from fetch as status:'error' — must NOT silently transition to 'done'", async () => {
    // The store does `await fetch(endpoint, ...)` then reads the body. If the
    // response is 500, the body may be an empty stream OR a JSON error
    // payload. The current implementation reads body and processes SSE
    // frames regardless of status, so a 500 with empty body silently
    // transitions to 'done' — masking transport failures. Pin the contract:
    // non-2xx upstream responses MUST surface as status='error'.
    vi.restoreAllMocks();
    const errorBody = makeStream(); // empty body
    const errorResponse = {
      status: 500,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: errorBody,
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    // 500 upstream MUST be surfaced as 'error', not silently 'done'.
    expect(final.status).toBe("error");
    expect(final.status).not.toBe("done");
  });

  it("store handles fetch call failure when JSON.stringify of requestBody throws (circular reference)", async () => {
    // Adversarial: the store builds the request body via
    //   JSON.stringify({ ...options?.body, ...sessionId })
    // which throws TypeError on a circular structure (BigInt / circular ref).
    // If this throws synchronously BEFORE the await fetch(), the surrounding
    // try/catch must absorb it and surface a clean status:'error' rather
    // than crashing the consumer's component with an uncaught exception.
    // Pin the contract: bad input → status:'error', error.message preserved.
    vi.restoreAllMocks();
    const fetchMock = vi.fn(() => {
      const { stream } = hangingStream();
      return Promise.resolve(makeResponse(stream));
    });
    vi.stubGlobal("fetch", fetchMock);

    // Build a body with a circular reference that JSON.stringify cannot encode.
    const circular: Record<string, unknown> = { hello: "world" };
    circular.self = circular;

    const store = createDeepAgentsStore("http://test/api", { body: circular });
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    // Must reach 'error' (not 'done' / 'streaming') with a descriptive Error.
    expect(final.status).toBe("error");
    expect(final.error).toBeInstanceOf(Error);
    expect(final.error!.message.toLowerCase()).toContain("circular");
  });

  it("store transitions to status:'error' when fetch rejects with an AbortError (e.g. client timeout, not user-unsubscribe)", async () => {
    // Adversarial: the store's catch path does
    //   if (err instanceof Error && err.name === "AbortError") return;
    // which SILENTLY swallows every AbortError — including a fetch timeout
    // triggered by a separate AbortController (e.g. consumer timeout policy,
    // browser network throttling, or upstream-request cancel). A user-unsubscribe
    // and a fetch timeout are both surfaced as AbortError to the awaiting
    // code, so the store cannot distinguish "I asked to abort" from "the
    // network timed out". Pin the contract: an AbortError during fetch must
    // surface as status:'error' so callers can tell the difference between
    // a deliberate tear-down and a stalled backend. If the implementation
    // keeps swallowing all AbortErrors, the store is stuck in 'loading'
    // forever.
    vi.restoreAllMocks();
    const timeoutError = new Error("The operation was aborted");
    timeoutError.name = "AbortError";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(timeoutError))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    // Pin: AbortError from fetch must surface as status:'error', not get
    // silently swallowed (which leaves the store permanently 'loading').
    expect(final.status).toBe("error");
    expect(final.status).not.toBe("loading");
    expect(final.error).toBeInstanceOf(Error);
    expect(final.error!.name).toBe("AbortError");
  });
});

describe("ADVERSARIAL — get() on a freshly-created store with NO subscriber", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — iter 2 hardening probe. The StartStopNotifier pattern only
  // runs the async fetch loop once per subscribe-cycle. Multiple subscribers
  // attaching concurrently (or the same store being subscribed from
  // multiple components in a SvelteKit page) must NOT kick off multiple
  // parallel fetches that race over the same messages array.
  // -------------------------------------------------------------------------

  it("store does not race when subscribers attach concurrently — fetch called once, all subscribers see coherent state", async () => {
    // Pin the StartStopNotifier contract: only the FIRST subscriber should
    // trigger the start function. Subsequent subscribers must share the
    // same store instance and the same in-flight fetch. If the
    // implementation re-runs start() on every subscribe, each subscriber
    // gets its own fetch + its own AbortController, and messages from
    // independent streams can interleave.
    vi.restoreAllMocks();
    const fetchMock = vi.fn(() => {
      const body = makeStream(
        'data: {"type":"text-delta","textDelta":"shared"}\n\n'
      );
      return Promise.resolve(makeResponse(body));
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api");

    // Attach 5 subscribers in the same microtask — concurrent subscribe.
    const states: DeepAgentsState[][] = [[], [], [], [], []];
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      unsubs.push(
        store.subscribe((s) =>
          states[i].push({ ...s, messages: [...s.messages] })
        )
      );
    }
    // Wait for the fetch chain to settle.
    await new Promise((r) => setTimeout(r, 100));
    unsubs.forEach((u) => u());

    // fetch must be called at most once — not once per subscriber.
    // (If the implementation re-starts on every subscribe, this fails.)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // All subscribers must observe the same final messages array.
    for (let i = 1; i < 5; i++) {
      const aFinal = states[0][states[0].length - 1];
      const bFinal = states[i][states[i].length - 1];
      expect(bFinal.messages).toEqual(aFinal.messages);
      expect(bFinal.status).toBe(aFinal.status);
    }
  });

  it("store pushes a JSON `null` data payload verbatim into messages — null is a valid SSE JSON value", async () => {
    // Adversarial: the SSE spec lets the data line carry ANY valid JSON value,
    // including the literal `null`. The store does `JSON.parse(raw.slice(6))`
    // and pushes the result into `messages`. A `null` payload therefore lands
    // in the array as the value `null`. Downstream code that iterates messages
    // and reads e.g. `msg.role` will then crash with "Cannot read properties
    // of null". Pin the contract: a null data payload must NOT crash the
    // store (JSON.parse succeeds, the catch block does not run) — but
    // consumers must be aware that `null` payloads are possible.
    vi.restoreAllMocks();
    const body = makeStream("data: null\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(body)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    // Status must reach 'done' — null is valid JSON, no parse error.
    expect(final.status).toBe("done");
    // The null payload must appear verbatim in the messages array.
    expect(final.messages).toHaveLength(1);
    expect(final.messages[0]).toBeNull();
  });

  it("store treats a subscribe→unsubscribe→subscribe sequence as a single StartStopNotifier cycle — fetch must not be called twice", async () => {
    // Adversarial: the writable's second-arg start function only runs once per
    // store instance, but a component that subscribes, immediately detaches,
    // and re-subscribes within the same microtask tick may look like a NEW
    // lifecycle to the consumer. The implementation MUST reuse the in-flight
    // fetch across re-subscribes (same start function call) — otherwise every
    // mount/unmount cycle spawns a parallel fetch that doubles network traffic
    // and races over `messages`.
    //
    // If the implementation accidentally tears down the controller on the
    // first unsubscribe and re-creates it on the second subscribe, the second
    // fetch hits a different backend URL/state and the messages from the
    // first fetch are lost. Pin: fetch called exactly ONCE.
    vi.restoreAllMocks();
    const fetchMock = vi.fn(() => {
      const body = makeStream(
        'data: {"type":"text-delta","textDelta":"only-once"}\n\n'
      );
      return Promise.resolve(makeResponse(body));
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api");
    const unsubA = store.subscribe(() => {});
    unsubA();
    // Re-subscribe within the same tick — before the fetch promise resolves.
    const unsubB = store.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 100));
    unsubB();

    // Fetch must have been called exactly once across the whole
    // subscribe/unsubscribe/resubscribe cycle.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("get(store) returns the empty-initial-state before any subscription — { messages: [], status: 'idle', error: null }", () => {
    // SSR safety: the store start() runs only when a subscriber attaches. Before
    // any subscriber, get() must return the declared initialState — undefined
    // would crash SvelteKit templates that read $store.messages at module scope.
    // This pins the StartStopNotifier contract: get() on an un-subscribed store
    // must NEVER return undefined.
    const { stream } = hangingStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const store = createDeepAgentsStore("http://test/api");
    const initial = get(store);
    // Initial value must be a fully-shaped DeepAgentsState — not undefined.
    expect(initial).toBeDefined();
    expect(initial.messages).toEqual([]);
    expect(initial.status).toBe("idle");
    expect(initial.error).toBeNull();
    // fetch must NOT have been called — SSR safety.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — iter 6 LIKELY-OK probes pinning correctness on edge-case
// upstream response shapes that the implementation never explicitly tests.
// ---------------------------------------------------------------------------

describe("ADVERSARIAL — iter 6 store edge-case response shapes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("store handles a fetch response with NO Content-Type header — frames still parsed and stream reaches 'done'", async () => {
    // The implementation reads SSE frames purely from the body bytes — it
    // never inspects the response Content-Type. But fetch mocks that omit
    // headers (some intermediate proxies / mocked CDNs do this) must still
    // produce a fully-functional stream. Pin: a response with no headers
    // at all must reach 'done' with the message appended verbatim.
    const body = makeStream(
      'data: {"type":"text-delta","textDelta":"no-ct"}\n\n'
    );
    // Build a response with NO headers field — the fetch spec returns an
    // empty Headers object in this case, but the store must not crash on it.
    const noHeaderResponse = {
      status: 200,
      body,
      // Deliberately omit `headers` — store.ts does not call response.headers.
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(noHeaderResponse))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    expect(final.status).toBe("done");
    expect(final.messages).toHaveLength(1);
    expect((final.messages[0] as any).textDelta).toBe("no-ct");
  });

  it("store handles a fetch response with Content-Length: 0 and empty body — stream reaches 'done' with zero messages", async () => {
    // A backend that responds with Content-Length: 0 and an empty body is a
    // common shape for "session ended without events" / "no work to do" /
    // heartbeats that only carry headers. The store must not interpret this
    // as a transport failure — empty body is a clean close. Pin: zero
    // messages, status='done', error=null.
    const emptyBody = makeStream(); // empty stream
    const zeroLengthResponse = {
      status: 200,
      headers: new Headers({
        "content-type": "text/event-stream",
        "content-length": "0",
      }),
      body: emptyBody,
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(zeroLengthResponse))
    );

    const store = createDeepAgentsStore("http://test/api");
    const states = await collectStates(store, 50);
    const final = states[states.length - 1];
    expect(final.status).toBe("done");
    expect(final.status).not.toBe("error");
    expect(final.messages).toHaveLength(0);
    expect(final.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — iter 7 likely-OK probe: 1000 sequential subscribe/unsubscribe
  // cycles on a single store instance must not accumulate state, leak fetch
  // listeners, or balloon memory. The StartStopNotifier contract says fetch
  // fires AT MOST ONCE per store instance. Each sub→unsub cycle should be a
  // no-op for the in-flight fetch (the keep-alive subscriber holds the
  // writable's count >= 1). If any cycle creates a new fetch, this test
  // catches it via the fetchMock call count.
  // -------------------------------------------------------------------------

  it("store handles 1000 sequential subscribe/unsubscribe cycles without memory leak or extra fetches", async () => {
    // Build a hanging stream so the in-flight fetch never completes during
    // the test. The store's controller is never aborted (because the next
    // subscribe immediately revives it before consumerCount hits zero, or
    // because the keep-alive keeps the writable alive across cycles).
    const { stream } = hangingStream();
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(stream)));
    vi.stubGlobal("fetch", fetchMock);

    const store = createDeepAgentsStore("http://test/api");

    // Run 1000 sequential sub→unsub cycles. Each must reuse the same
    // in-flight fetch (no new network call), the store must remain usable
    // across cycles, and there must be no unhandled exceptions.
    const CYCLES = 1000;
    for (let i = 0; i < CYCLES; i++) {
      const unsub = store.subscribe(() => {});
      // The keep-alive subscriber guarantees fetch runs at most ONCE
      // across the entire 1000-cycle loop. After the first subscriber
      // attaches, every subsequent subscribe must NOT trigger a new fetch.
      unsub();
    }

    // Pin: fetch must have been called at most once across all 1000 cycles.
    // (If a botched implementation tears down + recreates the writable on
    // every cycle, this number is >= 1000.)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);

    // After the final unsub, the store must still be subscribable and yield
    // the documented initial shape — no corrupted state from the storm.
    const finalStates: DeepAgentsState[] = [];
    const unsub = store.subscribe((s) =>
      finalStates.push({ ...s, messages: [...s.messages] })
    );
    expect(finalStates.length).toBeGreaterThan(0);
    expect(finalStates[0]).toEqual({
      messages: [],
      status: "idle",
      error: null,
    });
    unsub();

    // A fresh consumer attaching AFTER the storm must still get the
    // initial idle state without throwing. If the writable's keep-alive
    // got tangled (e.g. inner === null because of a bug), this fails.
    const postStormStates: DeepAgentsState[] = [];
    const postUnsub = store.subscribe((s) =>
      postStormStates.push({ ...s, messages: [...s.messages] })
    );
    expect(postStormStates[0]).toEqual({
      messages: [],
      status: "idle",
      error: null,
    });
    postUnsub();
  });
});
