import { describe, it, expect, vi, afterEach, expectTypeOf } from "vitest";
import { createHeartbeatStream } from "./openSweHeartbeat";
import type { HeartbeatOptions } from "./openSweHeartbeat";

describe("createHeartbeatStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes upstream bytes through unchanged when events arrive within interval", async () => {
    // Arrange: upstream that emits one chunk immediately
    const upstream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("data: hello\n\n"));
        ctrl.close();
      },
    });
    const heartbeat = createHeartbeatStream(upstream, { intervalMs: 30_000 });
    const chunks: string[] = [];
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (!done && result.value) chunks.push(decoder.decode(result.value));
    }
    expect(chunks.join("")).toBe("data: hello\n\n");
  });

  it("emits a heartbeat comment frame when upstream is idle beyond intervalMs", async () => {
    vi.useFakeTimers();
    // Arrange: upstream that never emits (simulates long-running quiet task)
    let resolveClose!: () => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Close after test advances timers
        new Promise<void>((res) => {
          resolveClose = res;
        }).then(() => ctrl.close());
      },
    });
    const heartbeat = createHeartbeatStream(upstream, { intervalMs: 30_000 });
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();

    // Read one chunk — before advancing timers, nothing comes
    const readPromise = reader.read();

    // Advance time past the interval
    await vi.advanceTimersByTimeAsync(30_001);

    const result = await readPromise;
    expect(result.done).toBe(false);
    const text = decoder.decode(result.value);
    // SSE comment frame: ": keep-alive\n\n"
    expect(text).toBe(": keep-alive\n\n");

    // Cleanup
    resolveClose();
    reader.releaseLock();
  });

  /*
   * THE DEFAULT INTERVAL IS THE SUBJECT, SO THE TEST MUST NOT SUPPLY ONE (ADAPT-03 v1.5).
   *
   * Every other case here passes `intervalMs: 30_000` explicitly, which makes the DEFAULT
   * unobservable: change `?? 25_000` to five minutes and nothing in this file moves. The
   * requirement is "heartbeat every 15–30s on idle", and until now the only description of
   * that band was a comment on the option and a line in a docblock. Prose is where a rule
   * goes when it is not a test.
   *
   * Asserted as the BAND rather than the number, in both directions, so it fails on a default
   * that is too slow AND on one that is too eager — a single "fires by 30s" assertion is
   * satisfied by a default of 1ms, which would flood the consumer and is the failure the
   * non-positive guard above exists to prevent.
   *
   * The number 25_000 is deliberately not asserted: pinning it would fail on any change
   * inside the band, which trains people to edit the expectation rather than read the
   * requirement.
   */
  it("with NO intervalMs, the DEFAULT lands in the documented 15–30s band", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        new Promise<void>((res) => {
          resolveClose = res;
        }).then(() => ctrl.close());
      },
    });
    // NO options argument at all — this is the whole point of the case.
    const heartbeat = createHeartbeatStream(upstream);
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();

    let frame: string | null = null;
    const readPromise = reader.read().then((r) => {
      if (!r.done && r.value) frame = decoder.decode(r.value);
      return r;
    });

    // NOT EARLY: a default below the band would already have fired by here.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(
      frame,
      "heartbeat fired before 15s — the default is below the band"
    ).toBeNull();

    // AND IT DOES FIRE: a default above the band would still be silent at 30s.
    await vi.advanceTimersByTimeAsync(30_000 - 14_999);
    expect(frame, "no heartbeat by 30s — the default is above the band").toBe(
      ": keep-alive\n\n"
    );

    resolveClose();
    await readPromise;
    reader.releaseLock();
  });

  it("does not emit heartbeat when upstream continuously provides data", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    // Upstream that emits 3 chunks at t=0, t=10s, t=20s — all within 30s interval
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const heartbeat = createHeartbeatStream(upstream, { intervalMs: 30_000 });
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];

    // Emit chunks within the interval — heartbeat must NOT fire
    ctrl.enqueue(encoder.encode("data: chunk1\n\n"));
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.enqueue(encoder.encode("data: chunk2\n\n"));
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.enqueue(encoder.encode("data: chunk3\n\n"));
    await vi.advanceTimersByTimeAsync(5_000);
    ctrl.close();

    let done = false;
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (!done && r.value) received.push(decoder.decode(r.value));
    }
    // Should have only the 3 data chunks, no heartbeat
    expect(received).toHaveLength(3);
    expect(received.every((c) => !c.startsWith(":"))).toBe(true);
  });

  // INVARIANT LOCK: openSweHeartbeat.ts defaults `intervalMs` to 25_000 and
  // passes it straight to `setTimeout`. If a caller (or a broken
  // `performance.now()` shim — see hardening iter 1) passes a non-positive
  // number (NaN, 0, negative), `setTimeout(..., 0)` fires immediately on the
  // next macrotask and reschedules forever, FLOODING the consumer with
  // `: keep-alive\n\n` frames and starving real upstream bytes. A safe default
  // (or a clamp to the documented 25_000ms minimum) is required. This test
  // asserts the safe behaviour: with a NaN/0/negative interval, no heartbeat
  // frames are emitted before upstream data arrives.
  it("ADVERSARIAL: heartbeat with NaN intervalMs must not flood the consumer — must clamp to default and NOT emit a keep-alive on the first read", async () => {
    // Upstream emits one chunk immediately so the heartbeat timer is reset
    // before it can fire. We assert that the very first read returns the real
    // upstream chunk, not a heartbeat frame.
    const upstream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("data: real\n\n"));
        ctrl.close();
      },
    });
    // NaN is the failure mode of a broken performance.now() shim — the openSwe
    // heartbeat code path can compute NaN if upstream-timing math is broken.
    const heartbeat = createHeartbeatStream(upstream, {
      intervalMs: Number.NaN,
    });
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();
    const result = await reader.read();
    expect(result.done).toBe(false);
    const text = decoder.decode(result.value);
    // The first read must be the real upstream byte, never a keep-alive.
    expect(text.startsWith(": keep-alive")).toBe(false);
    expect(text).toBe("data: real\n\n");
  });

  // INVARIANT LOCK: openSweHeartbeat.ts uses `setTimeout(fn, rawInterval)`. The
  // guard at L40 only rejects `rawInterval > 0` — anything positive passes
  // through, including `Number.MAX_SAFE_INTEGER` (9007199254740991). Setting a
  // ~285-million-year timer is harmless in terms of flooding (it never fires
  // in the test window), but two contracts must still hold:
  //   1. Upstream bytes must STILL pass through — the timer must not block
  //      the read loop.
  //   2. When the stream is cancelled mid-flight (reader.cancel()), the
  //      internal heartbeat timer MUST be cleared so the Node event loop has
  //      no outstanding handle (no leaked timer that keeps the process alive).
  // Probe both in one test: emit upstream, then cancel the reader. After
  // cancel the underlying finally-block in the start() handler must clear
  // the timer — if it doesn't, the test's afterEach (vi.useRealTimers) leaks
  // a pending fake timer across tests and subsequent tests see phantom
  // tick advancement.
  it("ADVERSARIAL: intervalMs = Number.MAX_SAFE_INTEGER must not block upstream bytes; cancelling the reader must clear the heartbeat timer (no leaked handle)", async () => {
    vi.useFakeTimers();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const heartbeat = createHeartbeatStream(upstream, {
      intervalMs: Number.MAX_SAFE_INTEGER,
    });
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];

    // Upstream emits data well before MAX_SAFE_INTEGER elapses. The timer
    // must not have fired and must not block the read.
    ctrl.enqueue(new TextEncoder().encode("data: real\n\n"));
    const r1 = await reader.read();
    expect(r1.done).toBe(false);
    received.push(decoder.decode(r1.value!));
    expect(received[0]).toBe("data: real\n\n");

    // No heartbeat should have fired in any reasonable window — advance by a
    // trivial amount and assert nothing extra comes through.
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual(["data: real\n\n"]);

    // Cancel the reader. The stream's start() finally-block clears
    // heartbeatTimer; if it doesn't, the timer keeps the fake-timer queue
    // non-empty after the test and bleeds into subsequent tests (observable
    // as vi.getTimerCount() > 0 after cancel+close).
    await reader.cancel();
    // Allow microtasks to drain the finally-block.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ADVERSARIAL: heartbeat with intervalMs=0 must not infinitely reschedule a same-tick flood", async () => {
    vi.useFakeTimers();
    // intervalMs=0 is `setTimeout(fn, 0)` which fires on the next macrotask and
    // then reschedules itself — every iteration of the event loop emits a
    // keep-alive frame. The first read should yield the upstream chunk, not a
    // keep-alive, OR if no upstream emits, the reader must not hang in a tight
    // loop of keep-alives. We pin the contract: no infinite flooding before
    // upstream provides data.
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const heartbeat = createHeartbeatStream(upstream, { intervalMs: 0 });
    const reader = heartbeat.getReader();
    const decoder = new TextDecoder();

    /*
     * THE PENDING READ IS THE ASSERTION (#390).
     *
     * This raced `reader.read()` against a REAL `setTimeout(…, 100)` and then
     * accepted either outcome. Against a correct implementation the read never
     * resolves — nothing has been enqueued upstream yet — so the race always
     * took the timeout branch, `result.done` was true, and the lone `expect`
     * sat inside an `if` that never ran. The test spent 100ms of wall clock on
     * every run to assert nothing, and would have gone on passing if the
     * flood it names had been reintroduced in a form that emits slightly late.
     *
     * Stated positively instead: give a flooding implementation a full second
     * of scheduler to flood in, and require the read to STILL be pending. That
     * is the contract — "no keep-alive before upstream emits" — and it is now
     * the thing that fails. Fake timers, like the four sibling cases here, so
     * the second is advanced rather than waited out.
     */
    let settled: ReadableStreamReadResult<Uint8Array> | null = null;
    const pending = reader.read().then((r) => (settled = r));

    // A zero-interval reschedule fires on every macrotask; 1000ms of them is
    // ample room for the flood this test forbids.
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      settled,
      "a keep-alive was emitted before upstream produced anything"
    ).toBeNull();

    // And the read still completes normally once upstream DOES emit — the
    // half that proves the stream was merely quiet, not broken.
    ctrl.enqueue(new TextEncoder().encode("data: bye\n\n"));
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(settled).not.toBeNull();
    const text = decoder.decode(settled!.value!);
    expect(text.startsWith(": keep-alive")).toBe(false);
    expect(text).toContain("data: bye");

    ctrl.close();
    reader.releaseLock();
  });
});

describe("createHeartbeatStream — controller.enqueue throw cleans up timer (iter 5)", () => {
  // PROBE 5 (iter 5): what happens if controller.enqueue() throws mid-flight
  // (e.g. the consumer aborted and the underlying stream is errored)? The
  // try/catch around `controller.enqueue(HEARTBEAT_FRAME)` at L59 swallows
  // the throw and the timer's callback returns normally. The reschedule
  // (`scheduleHeartbeat()`) at L64 fires unconditionally — so if the consumer
  // has cancelled while the timer is mid-callback, the reschedule keeps
  // firing on a closed stream. Pin the contract: after consumer cancel
  // (which propagates upstream and lands in the start() finally-block),
  // vi.getTimerCount() must drop to 0 even if a reschedule was pending.
  // We provoke this by letting the heartbeat timer fire once (driving the
  // reschedule) and then cancelling mid-flight.
  it("ADVERSARIAL: heartbeat timer that has fired once must be cleared on cancel — no leaked reschedule when upstream is still open", async () => {
    vi.useFakeTimers();
    let _ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        _ctrl = c;
        // Intentionally do NOT close upstream — so the read loop is
        // suspended awaiting a chunk. The heartbeat timer is active and
        // will fire on its interval, then reschedule itself.
      },
    });
    const heartbeat = createHeartbeatStream(upstream, { intervalMs: 1000 });
    const reader = heartbeat.getReader();

    // Drive the heartbeat timer to fire ONCE so a reschedule has happened.
    await vi.advanceTimersByTimeAsync(1000);
    // One timer should now be pending (the rescheduled heartbeat).
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    // Now cancel the reader. The cancel() propagates upstream via
    // reader.cancel(reason); the upstream reader.read() in start() rejects,
    // and the finally-block clears the heartbeat timer. After cancel + a
    // tick to drain microtasks, no timer must remain.
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --- rung contract conformance (moved from public-api.test.ts) -----------------------------
describe("open-swe rung — heartbeat contract", () => {
  it("createHeartbeatStream wraps a ReadableStream<Uint8Array>", () => {
    expectTypeOf(createHeartbeatStream).toBeFunction();
    expectTypeOf(createHeartbeatStream)
      .parameter(0)
      .toEqualTypeOf<ReadableStream<Uint8Array>>();
    expectTypeOf(createHeartbeatStream).returns.toEqualTypeOf<
      ReadableStream<Uint8Array>
    >();
  });

  it("HeartbeatOptions has an intervalMs field", () => {
    expectTypeOf<HeartbeatOptions>().toHaveProperty("intervalMs");
  });
});
