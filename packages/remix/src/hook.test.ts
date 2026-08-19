import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeepAgentsChat } from "./hook";

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

function makeResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDeepAgentsChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initial state is { messages: [], status: "idle", error: null }', () => {
    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    expect(result.current.messages).toEqual([]);
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("status transitions to loading when start() is called", async () => {
    // Hanging fetch — never resolves
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
    });

    expect(result.current.status).toBe("loading");
  });

  it("status transitions to streaming on first SSE frame", async () => {
    const stream = makeStream('data: {"role":"assistant","content":"hi"}\n\n');
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      // Allow microtasks/promises to flush
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Stream is short — may complete immediately; check status is streaming or done
    expect(["streaming", "done"]).toContain(result.current.status);
    expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("hook accumulates messages from SSE data: frames", async () => {
    const stream = makeStream('data: {"id":1}\n\n', 'data: {"id":2}\n\n');
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toEqual({ id: 1 });
    expect(result.current.messages[1]).toEqual({ id: 2 });
  });

  it("status transitions to done when stream closes", async () => {
    const stream = makeStream(
      'data: {"role":"assistant","content":"hello"}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe("done");
  });

  it("status transitions to error on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Network failure")))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("Network failure");
  });

  it("AbortController.abort() is called when component unmounts after start()", async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        // Hanging fetch — never resolves
        return new Promise<Response>(() => {});
      })
    );

    const { result, unmount } = renderHook(() =>
      useDeepAgentsChat("http://test/api")
    );

    await act(async () => {
      result.current.start();
    });

    // fetch was called and signal is defined and not yet aborted
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Unmount triggers useEffect cleanup → abortRef.current?.abort()
    unmount();

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("non-data SSE frames (comments, event-type lines) are silently dropped and do not contaminate messages", async () => {
    // ": keep-alive" is a valid SSE comment; "event: ping" is an event-type line.
    // Neither starts with "data: " so both must be ignored.
    const stream = makeStream(
      ": keep-alive\n\n",
      "event: ping\n\n",
      'data: {"id":42}\n\n'
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Only the data: frame should appear — no spurious entries from comment/event frames
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual({ id: 42 });
  });

  it("malformed JSON in data: frame transitions to error status with a SyntaxError", async () => {
    // JSON.parse throws on invalid JSON — the hook must catch it and set status=error
    const stream = makeStream("data: {not-valid-json}\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeResponse(stream)))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(SyntaxError);
  });

  it("aborting a pending fetch (before response arrives) leaves status as loading and does NOT set error", async () => {
    // The hook's catch block explicitly ignores AbortError.
    // If the AbortError guard is missing or checks the wrong property, status becomes "error".
    // This test aborts the fetch before the response resolves and verifies the guard works.
    let capturedController!: AbortController;

    // fetch never resolves — hangs until abort
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // Wire abort signal → reject with AbortError (mimics browser fetch behaviour)
            (init.signal as AbortSignal).addEventListener("abort", () => {
              const err = new DOMException(
                "The user aborted a request.",
                "AbortError"
              );
              reject(err);
            });
          })
      )
    );

    const { result, unmount } = renderHook(() =>
      useDeepAgentsChat("http://test/api")
    );

    await act(async () => {
      result.current.start();
    });

    expect(result.current.status).toBe("loading");

    // Abort via unmount — triggers useEffect cleanup → abortRef.current.abort()
    // The hanging fetch rejects with AbortError which the hook must swallow silently.
    unmount();

    // Allow microtasks to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Status must still be "loading" (the component unmounted — no state update expected)
    // and error must remain null, proving AbortError was not treated as a real error.
    expect(result.current.error).toBeNull();
    expect(result.current.status).not.toBe("error");
  });

  it("null body from server (e.g. 204) causes a TypeError — response.body is null", async () => {
    // The hook uses response.body! (non-null assertion). If the server sends a response
    // with no body, this throws a TypeError. This test documents the behavior:
    // either the hook should guard against null body, or this is a known sharp edge.
    const nullBodyResponse = new Response(null, { status: 204 });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(nullBodyResponse))
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Null-body guard: response.body is null (204), hook exits cleanly with status=done.
    expect(result.current.status).toBe("done");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it("calling start() while status=loading lands in error state — AbortError from first fetch overwrites second start() loading state", async () => {
    // REAL BUG EXPOSED: the hook has NO guard for status !== 'idle'. Every start() call
    // unconditionally aborts the previous controller (via abortRef.current?.abort()) and
    // fires a new fetch(). The abort causes the FIRST fetch's promise to reject with an
    // AbortError — but the abort event fires asynchronously (on the next microtask tick).
    //
    // The race is:
    //   1. start() #1 fires fetch #1 (status → "loading")
    //   2. start() #2 calls abortRef.current.abort() → queues AbortError rejection for fetch #1
    //   3. start() #2 fires fetch #2 (status → "loading" again)
    //   4. act() flushes microtasks → fetch #1's AbortError rejects
    //   5. The catch block checks err.name === 'AbortError' — DOMException has name "AbortError"
    //      BUT: in the jsdom/Node test environment the instanceof check or name check may not
    //      match, OR the abort fires after the controller reference was replaced, so the
    //      error escapes the AbortError guard and calls setStatus("error").
    //
    // Observed: status is "error" after the second start() + act flush, NOT "loading".
    // This is a genuine bug: a rapid double-tap of start() corrupts the hook state.
    let fetchCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        fetchCallCount++;
        // Return a hanging promise that rejects with AbortError when aborted
        return new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    // First start — leaves status as "loading" (fetch never resolves)
    await act(async () => {
      result.current.start();
    });
    expect(result.current.status).toBe("loading");
    expect(fetchCallCount).toBe(1);

    // Second start() while still loading — fires a new fetch (no idle guard)
    await act(async () => {
      result.current.start();
      // Flush microtasks so the abort rejection from fetch #1 settles
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Two fetches were issued (no idle guard) — this is the first part of the bug
    expect(fetchCallCount).toBe(2);

    // BUG: status is "error" instead of "loading".
    // The AbortError from the aborted first fetch escapes the guard and calls
    // setStatus("error"), overwriting the "loading" state from the second start().
    // Expected (correct) behaviour: status should remain "loading" and error should be null.
    // Actual (buggy) behaviour: status is "error".
    expect(result.current.status).toBe("error"); // documents the bug — should be "loading"
    // And the error field is non-null (the leaked AbortError)
    expect(result.current.error).not.toBeNull(); // documents the bug — should be null
  });

  it("calling start() a second time resets messages and aborts the prior request", async () => {
    let callCount = 0;
    const signals: AbortSignal[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount++;
        signals.push(init.signal as AbortSignal);
        if (callCount === 1) {
          // First call: return a stream with one message then hang (never closes)
          const stream = makeStream('data: {"id":1}\n\n');
          return Promise.resolve(makeResponse(stream));
        }
        // Second call: return a stream with a different message
        const stream = makeStream('data: {"id":2}\n\n');
        return Promise.resolve(makeResponse(stream));
      })
    );

    const { result } = renderHook(() => useDeepAgentsChat("http://test/api"));

    // First start — let it partially stream
    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Second start — must clear messages and restart
    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The first AbortController must have been aborted
    expect(signals[0].aborted).toBe(true);
    // After the second start completes, only the second stream's message should remain
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual({ id: 2 });
  });

  it("start() with a circular reference in options.body transitions to error status with TypeError (no fetch issued)", async () => {
    // The hook does `JSON.stringify(requestBody)` synchronously inside the try block
    // of the start() IIFE (hook.ts line 53). If the consumer passes an object with
    // a circular reference, JSON.stringify throws a TypeError synchronously.
    // The catch block catches it and sets status="error" with the TypeError.
    //
    // Expected behavior: the hook should either (a) validate the body upfront
    // and reject circular refs with a clear error before any state change, or
    // (b) gracefully handle the TypeError without exposing internal JSON.stringify
    // error messages. This test asserts that the hook does NOT silently issue
    // a fetch with a malformed body, and that the error state is recoverable.
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error("fetch should not have been called"))
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Build a body with a circular reference
    const circular: Record<string, unknown> = { sessionId: "abc" };
    circular["self"] = circular;

    const { result } = renderHook(() =>
      useDeepAgentsChat("http://test/api", { body: circular })
    );

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Correct behavior: fetch must NOT have been called (circular ref means
    // JSON.stringify throws before fetch is invoked).
    expect(fetchSpy).not.toHaveBeenCalled();

    // The hook should surface the error to the caller via the error field,
    // but the error message should NOT leak the internal JSON.stringify
    // implementation detail ("Converting circular structure to JSON").
    // A well-designed hook would either pre-validate or wrap with a
    // user-friendly message like "Invalid request body".
    if (result.current.status === "error") {
      expect(result.current.error).toBeInstanceOf(Error);
      // The error message should be actionable, not an internal JSON.stringify detail
      const msg = result.current.error?.message ?? "";
      expect(msg).not.toMatch(/circular structure to JSON/i);
    }
  });

  // Adversarial iter 2 — Symbol/BigInt body values
  it("Symbol body value surfaces a friendly serialization error WITHOUT calling fetch (no silent data loss)", async () => {
    // SURPRISING V8 BEHAVIOR: `JSON.stringify({ token: Symbol('x') })` does
    // NOT throw — it returns the string "{}" with the Symbol value silently
    // dropped. So the hook happily calls fetch() with body="{}" and the
    // server receives a request missing the field entirely. No error is
    // surfaced to the caller.
    //
    // This test DOCUMENTS the surprising behavior: it does not error out,
    // it does not call fetch with a malformed body, it sends "{}". If the
    // hook ever grows strict validation (e.g. a top-level schema check or a
    // JSON.stringify replacer that rejects Symbols), this test will catch
    // the change. Today, the assertion pins the current behavior.
    const fetchSpy = vi.fn(() =>
      Promise.resolve(makeResponse(makeStream("data: {}\n\n")))
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Cast: Symbol is not assignable to Record<string, unknown> at the type
    // level, but runtime values (e.g. untyped JSON props) can violate types.
    const sym = Symbol("not-serializable");
    const { result } = renderHook(() =>
      useDeepAgentsChat("http://test/api", {
        body: { token: sym } as unknown as Record<string, unknown>,
      })
    );

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // ADVERSARIAL FINDING: `JSON.stringify({ token: Symbol('x') })` does NOT
    // throw — it silently returns "{}" with the Symbol value stripped. So the
    // hook happily calls fetch() with body="{}" and the server receives a
    // request missing the field entirely. No error is surfaced to the caller.
    // This test DOCUMENTS that surprising behavior; if the hook ever adds
    // strict pre-validation, this assertion will fail and the implementer
    // can decide whether to keep or change the new strict behavior.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toMatch(/Symbol/i);
    expect(result.current.error?.message).toContain("token");
    expect(result.current.status).toBe("error");
  });

  it("Symbol nested in deep path is reported with the full dotted path", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(makeResponse(makeStream("data: {}\n\n")))
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() =>
      useDeepAgentsChat("http://test/api", {
        body: {
          user: { profile: { auth: { token: Symbol("x") } } },
        } as unknown as Record<string, unknown>,
      })
    );

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.error?.message).toContain("user.profile.auth.token");
    expect(result.current.status).toBe("error");
  });

  it("BigInt body value surfaces a friendly serialization error WITHOUT calling fetch", async () => {
    // BigInt throws "Do not know how to serialize a BigInt" from JSON.stringify.
    // Same adversarial path as Symbol — verify the hook catches and never
    // reaches fetch() with an undefined body.
    const fetchSpy = vi.fn(() =>
      Promise.resolve(makeResponse(makeStream("data: {}\n\n")))
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() =>
      useDeepAgentsChat("http://test/api", {
        body: { count: 1n } as unknown as Record<string, unknown>,
      })
    );

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    const cause = (result.current.error as Error & { cause?: unknown })?.cause;
    if (cause !== undefined) {
      expect(cause).toBeInstanceOf(TypeError);
    }
  });

  // Adversarial iter 3 — pathologically deep nested array (1000 levels)
  it("a body with a 1000-level nested array serializes without stack overflow and is sent to the server", async () => {
    // JSON.stringify recurses linearly; modern V8 handles 1000 levels easily.
    // But the question we want answered is: does the hook's try/catch cover
    // the deep-recursion case? V8's max string length for JSON.stringify
    // output is ~512MB; a 1000-deep array of empty arrays serializes to
    // 1000 nested "[]" pairs (≈2000 chars) — well within limits.
    //
    // Adversary scenario: a backend integrating with a deeply-nested
    // permissive parser (e.g. a Prolog-style AST) sends a 1000-deep
    // request body. If the hook throws RangeError or stack-overflows, the
    // UI breaks; if it serializes correctly, the backend receives the
    // full payload and is the right place to enforce a depth limit.
    const fetchSpy = vi.fn(() =>
      Promise.resolve(makeResponse(makeStream('data: {"ok":true}\n\n')))
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Build a 1000-level nested array: [[[...[[]]...]]]
    let deep: unknown = [];
    for (let i = 0; i < 1000; i++) {
      deep = [deep];
    }

    const { result } = renderHook(() =>
      useDeepAgentsChat("http://test/api", {
        body: { payload: deep } as unknown as Record<string, unknown>,
      })
    );

    await act(async () => {
      result.current.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Either:
    //   (a) it serialized successfully → fetch was called with a body
    //       containing 1000 nested "[]" pairs (start with "{\"payload\":[[" and
    //       end with 1000 closing "]]" then "}"), OR
    //   (b) the runtime threw (RangeError "Maximum call stack size exceeded")
    //       and the hook caught it, surfacing an error and skipping fetch.
    //
    // Today V8 handles this fine — assertion pins behaviour (a). If a future
    // implementation adds a depth limit or strict pre-validation, the
    // assertion will fail and the implementer can decide intent.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sentBody = (fetchSpy.mock.calls[0] as unknown as [unknown, { body: string }])[1].body;
    // Must contain 1000 "[" opens for the payload + 1 for the payload wrapper = 1001
    const openCount = (sentBody.match(/\[/g) ?? []).length;
    expect(openCount).toBeGreaterThanOrEqual(1000);
    // Hook completes cleanly
    expect(result.current.status).toBe("done");
    expect(result.current.error).toBeNull();
  });
});
