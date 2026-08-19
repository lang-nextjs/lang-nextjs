/**
 * createHeartbeatStream — SSE keep-alive for long-running open-swe runs.
 *
 * Wraps an upstream ReadableStream<Uint8Array> and injects an SSE comment frame
 * (": keep-alive\n\n") when no upstream bytes have arrived within intervalMs.
 * Resets the heartbeat timer each time an upstream chunk is received.
 *
 * DESIGN CONSTRAINT (from v1.5 roadmap):
 *   Heartbeat MUST NOT be a module-level timer — it is per-request state.
 *   MUST NOT be implemented inside a synchronous SseTransform (transforms cannot
 *   schedule timers). Correct placement: ReadableStream transform wrapping the
 *   upstream response body before the SseFrameAccumulator processes it.
 *
 * Usage in a Next.js App Router route:
 *   const lgResponse = await client.streamRun(...);
 *   const withHeartbeat = createHeartbeatStream(lgResponse.body!, { intervalMs: 25_000 });
 *   // Pass withHeartbeat as the upstream body to createDeepAgentsHandler or transform directly.
 */

export interface HeartbeatOptions {
  /** How long (ms) of upstream silence triggers a heartbeat. Default: 25_000 (25s). */
  intervalMs?: number;
}

const HEARTBEAT_FRAME = new TextEncoder().encode(": keep-alive\n\n");

/**
 * Wraps an upstream ReadableStream<Uint8Array> with SSE heartbeat injection.
 * Returns a new ReadableStream<Uint8Array> that is a drop-in replacement for the upstream.
 */
export function createHeartbeatStream(
  upstream: ReadableStream<Uint8Array>,
  options?: HeartbeatOptions
): ReadableStream<Uint8Array> {
  const rawInterval = options?.intervalMs ?? 25_000;
  // Guard: a non-positive or NaN interval would setTimeout(fn, 0)/NaN which
  // fires on the next macrotask and reschedules forever, flooding the consumer
  // with keep-alive frames before any real upstream data arrives. Treat any
  // non-positive value as "no heartbeat" by skipping the timer entirely.
  const heartbeatEnabled = rawInterval > 0;

  // Hoisted out of start() so cancel() can call reader.cancel(reason) to
  // propagate the cancellation upstream. Without propagation, the start()'s
  // pending reader.read() never resolves, the finally block never clears the
  // heartbeat timer, and the timer handle leaks across cancel.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = upstream.getReader();
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

      function scheduleHeartbeat() {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        if (!heartbeatEnabled) return;
        heartbeatTimer = setTimeout(() => {
          // Emit SSE comment keep-alive frame
          try {
            controller.enqueue(HEARTBEAT_FRAME);
          } catch {
            // Controller may be closed — ignore
          }
          // Reschedule until upstream closes
          scheduleHeartbeat();
        }, rawInterval);
      }

      scheduleHeartbeat();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Reset heartbeat timer: upstream is active
          scheduleHeartbeat();
          controller.enqueue(value);
        }
      } finally {
        // CRITICAL: clear the heartbeat timer on EVERY exit path of the read
        // loop — natural upstream close (done === true), read error (await
        // throws), and reader.cancel() (the consumer pulls the plug; the
        // pending reader.read() promise rejects and lands here). Without
        // this, a cancelled reader leaves a pending timer handle that keeps
        // the Node event loop alive (or, under vi.useFakeTimers, leaks a
        // pending timer across tests and bleeds into vi.getTimerCount()).
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        try {
          reader.releaseLock();
        } catch {
          // Reader may already be released by an upstream error path.
        }
        try {
          controller.close();
        } catch {
          // Controller may already be closed (cancel/error path).
        }
      }
    },

    cancel(reason) {
      // Propagate cancellation upstream so the pending reader.read() in
      // start() rejects and lands in the finally block — which clears the
      // heartbeat timer. Without this, calling reader.cancel() only releases
      // the heartbeat stream's own reader (the upstream's reader keeps its
      // pending read), the finally never fires, and the heartbeat timer
      // handle leaks (test-side: vi.getTimerCount() > 0 after cancel).
      // reader may be undefined if cancel fires before start (defensive).
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      reader?.cancel(reason);
    },
  });
}
