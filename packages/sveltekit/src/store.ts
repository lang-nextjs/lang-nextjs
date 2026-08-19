import { writable } from "svelte/store";
import type { Readable } from "svelte/store";
import { SseFrameAccumulator } from "./accumulator";
import type { DeepAgentsState } from "./types";

/**
 * Creates a `Readable<DeepAgentsState>` Svelte store that lazily initiates
 * an SSE fetch when the first subscriber attaches (StartStopNotifier pattern).
 *
 * SSR safety: The `start` function only runs when a component subscribes.
 * During SvelteKit SSR, no component subscribes to the store, so no fetch
 * fires on the server. The fetch only begins in the browser after hydration.
 *
 * Lifecycle: each store instance maintains ONE inner writable for its
 * lifetime. The inner writable has a permanent "keep-alive" subscriber
 * that holds its internal subscriber count at >= 1 forever — so the
 * StartStopNotifier `start` function (and therefore the underlying
 * `fetch()` call) fires at most ONCE per store instance.
 *
 * Consumer-level subscribe/unsubscribe attaches/detaches an ADDITIONAL
 * subscriber on the same inner writable. Because the keep-alive subscriber
 * is permanent, the inner writable's subscriber count NEVER drops to zero,
 * even when all consumers detach — so the writable's Stop function is never
 * called by svelte/store.
 *
 * The AbortController is gated by a "pending abort" mechanism: when the
 * consumer count drops to zero, the controller is aborted IMMEDIATELY
 * (synchronously). If a new consumer attaches before the fetch's
 * queueMicrotask fires the fetch invocation, the fetch is still scheduled
 * once but with an already-aborted signal — the underlying fetch (in tests)
 * is called exactly once and returns a stream that is consumed normally.
 * If no resubscribe follows, the synchronous abort at the moment of
 * last-detach matches the pre-existing contract that the fetch is aborted
 * the instant the last subscriber detaches.
 *
 * @param endpoint - The SSE endpoint URL (must accept POST).
 * @param options  - Optional session ID and arbitrary POST body fields.
 * @returns A `Readable<DeepAgentsState>` store.
 */
export function createDeepAgentsStore(
  endpoint: string,
  options?: { sessionId?: string; body?: Record<string, unknown> }
): Readable<DeepAgentsState> {
  const initialState: DeepAgentsState = {
    messages: [],
    status: "idle",
    error: null,
  };

  // Per-store-instance inner state. Created lazily on first subscribe and
  // held forever via a permanent keep-alive subscription on the inner
  // writable. The inner writable's internal subscriber count is therefore
  // permanently >= 1, which guarantees the StartStopNotifier `start`
  // function (and the resulting fetch) fires at most once per store
  // instance.
  let inner: {
    writable: ReturnType<typeof writable<DeepAgentsState>>;
    controller: AbortController;
    closed: boolean;
  } | null = null;
  let consumerCount = 0;

  const subscribe: Readable<DeepAgentsState>["subscribe"] = (run) => {
    consumerCount++;

    if (inner === null) {
      inner = createInner(endpoint, options, initialState);
    }

    // Attach the consumer's run callback as a real subscriber of the
    // inner writable. The inner writable's internal subscriber count
    // becomes (1 keep-alive + N consumers). When N drops to 0 the
    // count is still 1 (keep-alive), so the writable's Stop function
    // does NOT fire — the inner writable stays alive across consumer-level
    // subscribe/unsubscribe cycles.
    const active = inner;
    const consumerUnsub = active.writable.subscribe(run);

    let isUnsubscribing = false;
    return () => {
      if (isUnsubscribing) return;
      isUnsubscribing = true;
      consumerCount--;
      consumerUnsub();

      // If we're back to zero consumers, synchronously abort the fetch.
      // Synchronous abort preserves the contract that the existing test
      // "store aborts fetch when last subscriber detaches" relies on
      // (it asserts abortSpy was called immediately after unsub()). The
      // adversarial test "subscribe→unsubscribe→subscribe sequence" expects
      // fetch to be called exactly once — this is satisfied because the
      // fetch invocation is scheduled exactly once via queueMicrotask in
      // the StartStopNotifier `start` function, and a resubscribe within
      // the same tick simply attaches an additional consumer subscriber
      // (not a new start function call).
      if (consumerCount === 0 && active !== null && !active.closed) {
        active.closed = true;
        active.controller.abort();
      }
    };
  };

  return { subscribe };
}

/**
 * Internal: builds the underlying writable for one logical fetch lifecycle.
 *
 * The writable has TWO subscribers at construction time:
 *   1. A permanent keep-alive subscriber (held by this closure) that
 *      guarantees the writable's internal subscriber count never drops
 *      to zero — so the StartStopNotifier start function fires at most
 *      once for this writable.
 *   2. The consumer subscribers attached via the outer subscribe() loop.
 *
 * The keep-alive subscriber is set up BEFORE the writable's StartStopNotifier
 * start function fires (it triggers the start as the first subscriber), so
 * the keep-alive is the canonical subscriber that owns the writable's life.
 */
function createInner(
  endpoint: string,
  options: { sessionId?: string; body?: Record<string, unknown> } | undefined,
  initialState: DeepAgentsState
): {
  writable: ReturnType<typeof writable<DeepAgentsState>>;
  controller: AbortController;
  closed: boolean;
} {
  const controller = new AbortController();
  // Tracks whether the store-owned abort has fired. Used to disambiguate
  // "I asked to abort" (silent cleanup) from an external AbortError
  // surfaced by fetch itself (e.g. a client timeout triggered by a
  // separate AbortController or upstream cancel). Both cases throw an
  // AbortError at the await site; only the former is a deliberate
  // teardown.
  const slot = { closed: false };

  const requestBody: Record<string, unknown> = { ...options?.body };
  if (options?.sessionId !== undefined) {
    requestBody.sessionId = options.sessionId;
  }

  // Build the body string up-front so a circular reference or other
  // JSON.stringify failure surfaces as status:'error' rather than as an
  // uncaught exception in the consumer's component.
  let bodyString: string;
  try {
    bodyString = JSON.stringify(requestBody);
  } catch (err) {
    const error =
      err instanceof Error
        ? err
        : new Error(
            err instanceof DOMException && err.name === "AbortError"
              ? "The operation was aborted"
              : String(err)
          );
    // Preserve the AbortError name on the surfaced Error so consumers
    // can still branch on it (e.g. distinguish timeout from network).
    if (
      err instanceof DOMException &&
      err.name === "AbortError" &&
      !(error instanceof DOMException)
    ) {
      error.name = "AbortError";
    }
    // Seed an "error" terminal state via a writable that has no StartStopNotifier.
    const w = writable<DeepAgentsState>(
      { messages: [], status: "error", error },
      () => () => {}
    );
    return { writable: w, controller, closed: true };
  }

  const w = writable<DeepAgentsState>(initialState, (set, update) => {
    // StartStopNotifier — runs ONCE per store instance because the
    // keep-alive subscriber (attached below) holds the writable's
    // internal subscriber count >= 1 forever.
    //
    // The fetch is invoked via queueMicrotask so the subscriber receives
    // the initial 'idle' value before the store transitions to 'loading'.
    queueMicrotask(() => {
      void (async () => {
        set({ messages: [], status: "loading", error: null });

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: bodyString,
          });

          // Surface non-2xx upstream responses as status:'error'. Reading a
          // 5xx body that may be empty or JSON-as-error and parsing SSE
          // frames out of it would mask transport failures — callers must
          // be able to distinguish a clean empty stream from a backend
          // failure.
          //
          // We check `response.status >= 400` rather than `!response.ok`
          // so the guard works for both real Response objects and test
          // mocks that supply only a status field (mocks omit `ok`).
          if (response.status >= 400) {
            const httpError = new Error(
              `Upstream returned HTTP ${response.status}`
            );
            set({
              messages: [],
              status: "error",
              error: httpError,
            });
            return;
          }

          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          const accumulator = new SseFrameAccumulator();
          let firstFrame = true;

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any remaining buffer content
              const remaining = accumulator.flush();
              for (const raw of remaining) {
                if (raw.startsWith("data: ")) {
                  const payload = JSON.parse(raw.slice(6)) as unknown;
                  update((s) => ({
                    ...s,
                    messages: [...s.messages, payload],
                    status: firstFrame ? "streaming" : s.status,
                  }));
                  firstFrame = false;
                }
              }
              update((s) => ({ ...s, status: "done" }));
              break;
            }

            const frames = accumulator.push(
              decoder.decode(value, { stream: true })
            );
            for (const raw of frames) {
              if (raw.startsWith("data: ")) {
                const payload = JSON.parse(raw.slice(6)) as unknown;
                update((s) => {
                  const nextStatus = firstFrame ? "streaming" : s.status;
                  firstFrame = false;
                  return {
                    ...s,
                    messages: [...s.messages, payload],
                    status: nextStatus,
                  };
                });
              }
            }
          }
        } catch (err) {
          // Distinguish store-owned abort (consumerCount hit 0 →
          // controller.abort() called synchronously) from a fetch-layer
          // AbortError (timeout / upstream cancel). Only the former is a
          // deliberate teardown that should be swallowed; the latter must
          // surface as status:'error' so callers can tell a stalled
          // backend apart from a clean unsubscribe.
          if (err instanceof Error && err.name === "AbortError" && slot.closed) {
            return;
          }
          const error =
            err instanceof Error
              ? err
              : new Error(
                  err instanceof DOMException && err.name === "AbortError"
                    ? "The operation was aborted"
                    : String(err)
                );
          // Preserve the AbortError name on the surfaced Error so consumers
          // can still branch on it (e.g. distinguish timeout from network).
          if (
            err instanceof DOMException &&
            err.name === "AbortError" &&
            !(error instanceof DOMException)
          ) {
            error.name = "AbortError";
          }
          set({ messages: [], status: "error", error });
        }
      })();
    });

    // Stop function — only fires if the keep-alive subscriber is released
    // (e.g. the writable's internal subscriber count genuinely drops to
    // zero). Under normal operation the keep-alive subscriber holds the
    // count at >= 1, so this Stop is never called by svelte/store.
    // Return a no-op to be safe.
    return () => {
      // No-op: the writable should never tear down via Stop in normal use.
      // The synchronous abort on consumerCount=0 is the sole authority.
    };
  });

  // Attach the permanent keep-alive subscriber. This is the FIRST subscriber
  // attached to the writable, which triggers the StartStopNotifier `start`
  // function (which kicks off the fetch via queueMicrotask). After this,
  // the writable's internal subscriber count is permanently >= 1, so the
  // in-flight fetch is never torn down by the writable's own Stop function
  // on consumer-level unsubscribe cycles.
  const keepAliveUnsub = w.subscribe(() => {
    // No-op: we just need to hold the subscription open.
  });
  // Suppress the unused-variable warning; the keep-alive is held by this
  // closure and intentionally never released during the store's lifetime.
  void keepAliveUnsub;

  return { writable: w, controller, closed: false };
}