/**
 * SSE frame boundary accumulator.
 *
 * Buffers raw stream chunks and splits on frame boundaries (\n\n).
 * Handles frames split across TCP chunks without corruption.
 */

/**
 * Maximum buffered frame size in bytes (character count for UTF-8 single-byte).
 * Frames exceeding this limit are discarded to prevent unbounded memory growth
 * from malformed or malicious streams. 1MB is configurable enough for any
 * legitimate SSE frame while preventing memory exhaustion.
 */
export const MAX_FRAME_BYTES = 1_000_000;

/**
 * Where a frame came from in a nested agent execution — provider-neutral.
 *
 * Deliberately NOT a raw provider namespace. LangGraph encodes this as a pipe-delimited
 * `checkpoint_ns` carrying uuids; expressing that verbatim in the rendering contract would
 * couple every consumer to one rung's internals and leave a Django or FastAPI agent unable to
 * describe its own nesting without faking a LangGraph namespace. Rung adapters parse their
 * own format and produce THIS.
 */
export interface FrameAttribution {
  /** 0 = the root graph (main agent). One level per nesting depth. */
  depth: number;
  /**
   * Node labels from the root down to this frame's scope, uuid-free.
   * Invariant: `path.length === depth + 1`, so it is never empty when attribution is present.
   */
  path: string[];
  /**
   * Stable id for THIS execution scope WITHIN THIS STREAM. Two concurrent sub-agents at the
   * same depth get different ids, which is what lets a renderer group a sub-agent's frames
   * and nest them under the right parent.
   *
   * Not stable across streams — a resumed or reconnected stream re-mints ids, exactly as
   * `seq` does. Do not use it as a durable key.
   */
  scopeId: string;
  /** scopeId of the enclosing scope; null at depth 0. */
  parentScopeId: string | null;
}

/**
 * A single SSE frame — the text between \n\n boundaries.
 */
export interface SseFrame {
  /** The full frame text (everything between \n\n boundaries) */
  raw: string;
  /**
   * Optional IN-PROCESS attribution, carried between transforms. NEVER SERIALIZED: the
   * handler writes only `frame.raw` to the wire.
   *
   * It has to travel out-of-band because AI SDK v6 parses standard frames with `strictObject`
   * and REJECTS unknown fields — that is the entire reason `stripMessageIdTransform` exists.
   * Adding a namespace field to `tool-input-start` would break client parsing for every
   * consumer. A rung's enrich stage copies this onto its `data-*` payloads, which are
   * user-defined and therefore safe to extend.
   */
  attribution?: FrameAttribution;
}

/**
 * Returns true if a frame exceeds the maximum size limit.
 * Use this to check complete frames before passing to transforms.
 */
export function isFrameOversized(frame: string): boolean {
  return frame.length > MAX_FRAME_BYTES;
}

/**
 * SSE transform function. Returns the (optionally modified) frame, or null
 * to drop the frame entirely.
 *
 * This is the LEGACY one-frame-in-one-frame-out contract — the common shape
 * for adapter transforms (langchain, langgraph, openSwe, etc.) that rewrite,
 * strip, or drop individual frames.
 */
export type SseTransform = (frame: SseFrame) => SseFrame | null;

/**
 * Multi-output SSE transform function. Variadic return type:
 *   - `null`        → drop the input frame entirely
 *   - `SseFrame`    → single-frame output (1-in-1-out, the common case)
 *   - `SseFrame[]`  → multi-frame output (e.g. an approval drain emitting
 *                     buffered + global + trigger frames in one shot)
 *
 * The N-output shape lets a transform emit several frames per input without
 * juggling internal queues that would otherwise consume subsequent input
 * frames as "shift triggers" (the legacy one-out contract had this
 * structural limitation around multi-frame drains).
 *
 * SseTransform is structurally assignable to SseMultiTransform (a narrower
 * return type assigns to a wider one), so the handler's applyTransforms
 * pipeline accepts both forms uniformly.
 */
export type SseMultiTransform = (
  frame: SseFrame
) => SseFrame | SseFrame[] | null;

/**
 * Buffers raw SSE stream chunks and splits on frame boundaries (\n\n).
 *
 * The Django backend may split SSE frames across multiple TCP chunks.
 * Regex-replacing on raw bytes would corrupt frames split mid-way.
 * This accumulator ensures we only process complete frames.
 */
export class SseFrameAccumulator {
  private buffer = "";

  /**
   * Push a decoded string chunk.
   * Returns all complete frames found in the accumulated buffer.
   * Any incomplete trailing frame is kept in the internal buffer.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    // Normalize CRLF/CR to LF BEFORE splitting. The SSE spec (HTML living
    // standard) allows a frame to be terminated by `\n\n`, `\r\n`, or
    // `\r\n\r\n` — splitting on the literal "\n\n" alone would leave
    // CRLF-delimited frames stuck in the buffer forever.
    const normalized = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Split FIRST, then size-check. The earlier guard discarded the WHOLE
    // buffer (delimiter included) before splitting, which (a) dropped a valid
    // complete frame that merely preceded an oversized partial in the same
    // chunk, and (b) counted the `\n\n` delimiter against a frame's size.
    const parts = normalized.split("\n\n");
    // The last element is either empty (trailing \n\n) or an incomplete frame.
    // Keep it in the buffer for the next chunk.
    this.buffer = parts.pop() ?? "";
    // Bound memory: drop an oversized INCOMPLETE trailing frame.
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = "";
    }
    // Drop oversized COMPLETE frames (consistent with isFrameOversized: only
    // strictly > MAX is oversized; a frame at exactly MAX is valid and kept).
    return parts.filter((f) => !isFrameOversized(f));
  }

  /**
   * Flush remaining buffer content. Call when the upstream reader signals done.
   * Returns the remaining buffer as a single-element array if non-empty, else [].
   * Clears the internal buffer after flushing.
   */
  flush(): string[] {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining ? [remaining] : [];
  }
}
