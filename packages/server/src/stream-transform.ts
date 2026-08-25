/**
 * Apply an SSE transform pipeline to a raw upstream byte stream.
 *
 * A focused, reusable helper for proxy routes that already have a
 * `ReadableStream<Uint8Array>` of SSE bytes (e.g. open-swe's GET run-stream
 * passthrough) and want to run it through adapter transforms WITHOUT the full
 * `createDeepAgentsHandler` machinery (no circuit breaker / observability /
 * reconnection — just frame accumulation, transform, re-emit).
 *
 * Frames are split on `\n\n` (via SseFrameAccumulator), each complete frame is
 * run through the transforms (which may drop → `null`, rewrite → `SseFrame`, or
 * fan out → `SseFrame[]`), and the results are re-serialized with the `\n\n`
 * boundary. Backpressure-friendly: reads one chunk per `pull`.
 */
import { SseFrameAccumulator } from "./accumulator";
import type { SseFrame, SseMultiTransform } from "./accumulator";

/**
 * The two capabilities `createApprovalGatingTransform` adds to a plain
 * transform. Declared structurally rather than imported so this helper keeps no
 * dependency on the approval module — any transform that pauses a stream and
 * can release later is handled the same way.
 */
interface DrainableTransform {
  hasPending?: () => boolean;
  drainOnClose?: () => Promise<SseFrame[]>;
}

/** Run one frame through the transform pipeline. Mirrors the handler's
 * applyTransforms: chained stages, each fanning out, a throwing stage forwards
 * the input frame unchanged so the stream never breaks. */
function runPipeline(
  transforms: SseMultiTransform[],
  frame: SseFrame
): SseFrame[] {
  let current: SseFrame[] = [frame];
  for (const t of transforms) {
    const next: SseFrame[] = [];
    for (const f of current) {
      try {
        const r = t(f);
        if (r === null) continue;
        if (Array.isArray(r)) next.push(...r);
        else next.push(r);
      } catch (err) {
        console.error(
          "[open-swe/stream] transform error, forwarding frame:",
          err
        );
        next.push(f);
      }
    }
    current = next;
  }
  return current;
}

export function transformSseStream(
  upstream: ReadableStream<Uint8Array>,
  transforms: SseMultiTransform[]
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const acc = new SseFrameAccumulator();

  // Transform a batch of raw frames and enqueue outputs. Returns how many
  // output frames were enqueued (0 when every frame was dropped/filtered).
  const emit = (
    rawFrames: string[],
    controller: ReadableStreamDefaultController<Uint8Array>
  ): number => {
    let n = 0;
    for (const raw of rawFrames) {
      for (const out of runPipeline(transforms, { raw })) {
        controller.enqueue(encoder.encode(`${out.raw}\n\n`));
        n++;
      }
    }
    return n;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep reading until this pull has actually ENQUEUED at least one output
        // frame (or the upstream ends). Returning after a chunk whose frames all
        // got dropped — e.g. the on_chain_* noise between tool calls — yields a
        // no-output pull that some response layers (Next.js) treat as
        // stream-idle, truncating the SSE response after the first frame.
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            emit(acc.flush(), controller);

            /*
             * DRAIN BEFORE CLOSING. A gating transform buffers frames while a human
             * decides, and it only ever drains from inside a call — so once `done`
             * arrives there is no remaining call site and every buffered frame
             * becomes unreachable. Closing here discarded them with no frame and no
             * error: the approval POST still returned 200 and the registry still read
             * "success" while the continuation vanished. That is #25b, and handler.ts
             * has carried this guarantee since #39 — this helper did not, so any route
             * composing the gate through `transformSseStream` rather than
             * `createDeepAgentsHandler` silently had the old bug.
             *
             * Drained frames have ALREADY been through the pipeline (the gate returns
             * them as its own output), so they are enqueued directly rather than run
             * through `emit` a second time.
             */
            for (const t of transforms as DrainableTransform[]) {
              if (!t.hasPending?.()) continue;
              try {
                for (const out of await t.drainOnClose!()) {
                  controller.enqueue(encoder.encode(`${out.raw}\n\n`));
                }
              } catch (drainErr) {
                // Draining must never turn a recoverable truncation into a crashed
                // stream — the client keeps whatever it already received.
                console.error("[open-swe/stream] drain-on-close failed:", drainErr);
              }
            }

            controller.close();
            return;
          }
          // Strip ALL carriage returns before framing. SSE permits `\r\n` line
          // endings and the LangGraph Platform uses them (frames separated by
          // `\r\n\r\n`), but SseFrameAccumulator splits on `\n\n`. Removing each
          // `\r` independently — rather than replacing `\r\n` pairs — is correct
          // even when a `\r\n` is split across two chunk reads (chunk A ends
          // `\r`, chunk B starts `\n`): the lone `\r` is dropped and the `\n`s
          // still align into `\n\n`. (Raw `\r` never appears inside JSON data —
          // JSON escapes it as `\\r` — so this only affects SSE line endings.)
          const frames = acc.push(
            decoder.decode(value, { stream: true }).replace(/\r/g, "")
          );
          if (frames.length === 0) continue;
          if (emit(frames, controller) > 0) return;
          // else: all frames dropped — keep reading for real output.
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}
