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
 * A single SSE frame — the text between \n\n boundaries.
 */
export interface SseFrame {
  /** The full frame text (everything between \n\n boundaries) */
  raw: string;
}

/**
 * Returns true if a frame exceeds the maximum size limit.
 * Use this to check complete frames before passing to transforms.
 */
export function isFrameOversized(frame: string): boolean {
  return frame.length > MAX_FRAME_BYTES;
}

/**
 * SSE transform function.
 * Returns the (optionally modified) frame, or null to drop the frame entirely.
 */
export type SseTransform = (frame: SseFrame) => SseFrame | null;

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
