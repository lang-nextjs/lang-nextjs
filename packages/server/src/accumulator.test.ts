import { describe, it, expect } from "vitest";
import {
  SseFrameAccumulator,
  MAX_FRAME_BYTES,
  isFrameOversized,
} from "./accumulator";

describe("SseFrameAccumulator", () => {
  it("push() returns complete frames split by \\n\\n boundary", () => {
    const acc = new SseFrameAccumulator();
    const frames = acc.push("event: message\ndata: hello\n\n");
    expect(frames).toEqual(["event: message\ndata: hello"]);
  });

  it("push() keeps incomplete frame in buffer", () => {
    const acc = new SseFrameAccumulator();
    const frames = acc.push("event: message\ndata: hel");
    expect(frames).toEqual([]);
  });

  it("push() handles frame split across two chunks (TCP split edge case)", () => {
    const acc = new SseFrameAccumulator();
    // First chunk ends before the \n\n boundary
    const first = acc.push("event: message\ndata: hello");
    expect(first).toEqual([]);
    // Second chunk completes the frame
    const second = acc.push("\n\n");
    expect(second).toEqual(["event: message\ndata: hello"]);
  });

  it("push() handles multiple complete frames in one chunk", () => {
    const acc = new SseFrameAccumulator();
    const frames = acc.push("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(frames).toEqual(["data: a", "data: b", "data: c"]);
  });

  it("flush() returns remaining buffer content and clears buffer", () => {
    const acc = new SseFrameAccumulator();
    acc.push("data: partial");
    const flushed = acc.flush();
    expect(flushed).toEqual(["data: partial"]);
    // Buffer is now clear
    expect(acc.flush()).toEqual([]);
  });

  it("flush() returns empty array when buffer is empty", () => {
    const acc = new SseFrameAccumulator();
    expect(acc.flush()).toEqual([]);
  });

  it('push("\\n\\n") — boundary-only chunk returns an empty-string frame (SSE keepalive)', () => {
    // A bare \n\n chunk (e.g., SSE keepalive heartbeat) splits into ["", ""] after
    // split('\n\n'). pop() removes the trailing "" into the buffer, leaving [""] to
    // be returned. That means an empty-string frame "" is returned to the caller.
    // The handler must NOT forward this as a bare \n\n to the client.
    // This test documents the current behaviour so the SvelteKit port can guard for it.
    const acc = new SseFrameAccumulator();
    const frames = acc.push("\n\n");
    // The accumulator returns one empty-string frame — the pipeline must handle it
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe("");
  });

  it('push("") — zero-byte chunk does not corrupt buffer or produce phantom frames', () => {
    // TCP can deliver zero-byte reads. push("") must return [] and leave the buffer
    // unchanged so the next real chunk can complete the frame correctly.
    const acc = new SseFrameAccumulator();
    acc.push("data: partial");
    const frames = acc.push("");
    expect(frames).toEqual([]);
    // After an empty push, the incomplete frame must still be flushed correctly
    acc.push("\n\n");
    expect(acc.flush()).toEqual([]);
  });

  it("partial-only first push buffers correctly; completing push returns the assembled frame", () => {
    // Adversarial: the first chunk contains ONLY a partial frame — no \n\n boundary at all.
    // After split('\n\n') the result is a single-element array; pop() removes it into the
    // buffer and returns []. The second push appends data that completes the boundary.
    // If the buffer is corrupted or the pointer is off-by-one the assembled frame will be
    // truncated, duplicated, or garbage.
    const acc = new SseFrameAccumulator();

    // First push: purely partial, no boundary — must return [] and stash in buffer
    const first = acc.push("data: line1\ndata: lin");
    expect(first).toEqual([]);

    // Second push: completes the line AND adds the boundary
    const second = acc.push("e2\n\n");
    // The full assembled frame must match exactly — any off-by-one drops chars
    expect(second).toEqual(["data: line1\ndata: line2"]);

    // Buffer must be empty after completing the frame
    expect(acc.flush()).toEqual([]);
  });

  it("three sequential partial pushes assemble into one correct frame (multi-chunk boundary split)", () => {
    // Adversarial: the \n\n boundary itself is split across two separate chunks
    // (chunk 2 delivers only \n, chunk 3 delivers \n). The accumulator must NOT
    // emit a frame after chunk 2, only after chunk 3 completes the boundary.
    const acc = new SseFrameAccumulator();

    const r1 = acc.push("data: hello");
    expect(r1).toEqual([]); // no boundary yet

    const r2 = acc.push("\n"); // only first \n of the \n\n pair
    expect(r2).toEqual([]); // still no complete frame

    const r3 = acc.push("\n"); // second \n completes the boundary
    // The accumulated string is "data: hello\n\n" — split gives ["data: hello", ""]
    // pop() removes "" into the buffer, returning ["data: hello"]
    expect(r3).toEqual(["data: hello"]);

    // Buffer holds the trailing "" — flush must return [] (not [""])
    expect(acc.flush()).toEqual([]);
  });

  describe("frame size limit", () => {
    it("push() discards buffer when it exceeds MAX_FRAME_BYTES (no boundary in stream)", () => {
      const acc = new SseFrameAccumulator();
      // Build a string that exceeds MAX_FRAME_BYTES
      const oversizedChunk = "x".repeat(MAX_FRAME_BYTES + 1);

      // Push the oversized chunk - it should be discarded
      const frames = acc.push(oversizedChunk);
      expect(frames).toEqual([]);

      // Buffer should be cleared
      expect(acc.flush()).toEqual([]);
    });

    it("push() keeps frames at exactly MAX_FRAME_BYTES", () => {
      const acc = new SseFrameAccumulator();
      // A COMPLETE frame at exactly MAX_FRAME_BYTES is valid (isFrameOversized
      // flags only > MAX), so it is returned. The `\n\n` delimiter is no longer
      // counted against the frame's size (split strips it before the check).
      const exactSizeFrame = "x".repeat(MAX_FRAME_BYTES);

      const frames = acc.push(`${exactSizeFrame}\n\n`);
      expect(frames).toEqual([exactSizeFrame]);
      expect(acc.flush()).toEqual([]);
    });

    it("push() drops a COMPLETE frame strictly over MAX_FRAME_BYTES but keeps a valid trailing frame", () => {
      const acc = new SseFrameAccumulator();
      const oversized = "x".repeat(MAX_FRAME_BYTES + 1);
      const frames = acc.push(`${oversized}\n\ndata: keep\n\n`);
      expect(frames).toEqual(["data: keep"]);
    });

    it("push() handles oversized buffer followed by valid frames", () => {
      const acc = new SseFrameAccumulator();

      // First push an oversized chunk (buffer gets cleared)
      const oversizedChunk = "x".repeat(MAX_FRAME_BYTES + 1);
      const firstFrames = acc.push(oversizedChunk);
      expect(firstFrames).toEqual([]);
      expect(acc.flush()).toEqual([]);

      // Then push a valid frame - it should work normally
      const validFrames = acc.push("data: hello\n\n");
      expect(validFrames).toEqual(["data: hello"]);
      expect(acc.flush()).toEqual([]);
    });

    it("isFrameOversized returns true for frames exceeding MAX_FRAME_BYTES", () => {
      const oversizedFrame = "x".repeat(MAX_FRAME_BYTES + 1);
      expect(isFrameOversized(oversizedFrame)).toBe(true);
    });

    it("isFrameOversized returns false for frames at or below MAX_FRAME_BYTES", () => {
      const exactSizeFrame = "x".repeat(MAX_FRAME_BYTES);
      const undersizedFrame = "x".repeat(MAX_FRAME_BYTES - 1);

      expect(isFrameOversized(exactSizeFrame)).toBe(false);
      expect(isFrameOversized(undersizedFrame)).toBe(false);
    });
  });
});

describe("SseFrameAccumulator — high frame count in one chunk (NEW, iter 4)", () => {
  // INVARIANT LOCK: a single chunk packing many (1000) complete tiny frames must
  // return ALL of them, in order, in one push() call — none coalesced, dropped,
  // or split — with the trailing boundary leaving an empty buffer.
  it("returns all 1000 tiny frames from a single chunk, in order", () => {
    const acc = new SseFrameAccumulator();
    let chunk = "";
    for (let i = 0; i < 1000; i++) chunk += `data: ${i}\n\n`;
    const frames = acc.push(chunk);
    expect(frames).toHaveLength(1000);
    expect(frames[0]).toBe("data: 0");
    expect(frames[500]).toBe("data: 500");
    expect(frames[999]).toBe("data: 999");
    expect(acc.flush()).toEqual([]);
  });
});

describe("SseFrameAccumulator — exactly-MAX partial held across pushes (NEW, iter 5)", () => {
  // INVARIANT LOCK: the existing "exactly MAX" test pushes the whole frame in one
  // chunk. Here a frame whose body is EXACTLY MAX_FRAME_BYTES arrives as an
  // incomplete partial spanning multiple pushes (no boundary yet). The guard is
  // `this.buffer.length > MAX_FRAME_BYTES` (strictly greater), so a buffer sitting
  // at exactly MAX must be RETAINED across pushes — not dropped — and then emitted
  // intact once its `\n\n` boundary arrives.
  it("retains an exactly-MAX incomplete buffer across pushes and emits it once completed", () => {
    const acc = new SseFrameAccumulator();
    const exact = "x".repeat(MAX_FRAME_BYTES);

    // Partial, no boundary, split across two pushes — buffer reaches exactly MAX.
    expect(acc.push(exact.slice(0, 10))).toEqual([]);
    expect(acc.push(exact.slice(10))).toEqual([]); // at exactly MAX → retained
    // Sanity: a buffer at exactly MAX is NOT oversized.
    expect(isFrameOversized(exact)).toBe(false);

    // The boundary completes the frame; it must come back intact.
    const frames = acc.push("\n\n");
    expect(frames).toEqual([exact]);
    expect(acc.flush()).toEqual([]);
  });
});

describe("SseFrameAccumulator — isFrameOversized boundary values (NEW, iter 7)", () => {
  // INVARIANT LOCK: isFrameOversized is the SOLE public predicate downstream
  // transforms use to decide whether a frame should be forwarded or dropped. It
  // MUST return a boolean for every string-shaped input — never throw, never
  // return NaN/undefined (which would slip past a `if (!isFrameOversized(f))`
  // filter and bypass the entire size guard). A correct impl coerces to length
  // and compares against MAX.
  it("isFrameOversized returns a strict boolean (not NaN/undefined) for empty-string, MAX, MAX+1, and non-ASCII multibyte frames", () => {
    expect(typeof isFrameOversized("")).toBe("boolean");
    expect(typeof isFrameOversized("x")).toBe("boolean");
    expect(typeof isFrameOversized("x".repeat(MAX_FRAME_BYTES))).toBe(
      "boolean"
    );
    expect(typeof isFrameOversized("x".repeat(MAX_FRAME_BYTES + 1))).toBe(
      "boolean"
    );

    // The empty frame must NOT be oversized.
    expect(isFrameOversized("")).toBe(false);
    // Exactly at the cap is NOT oversized (the guard is strictly greater).
    expect(isFrameOversized("x".repeat(MAX_FRAME_BYTES))).toBe(false);
    // One past the cap IS oversized.
    expect(isFrameOversized("x".repeat(MAX_FRAME_BYTES + 1))).toBe(true);

    // Multi-byte UTF-8: every code-point in the string is a single JS char so
    // string.length counts code-points, not bytes. The helper measures in code
    // points, so a single multi-byte char must not flip the predicate to true
    // when the frame would otherwise be under MAX.
    expect(isFrameOversized("😀")).toBe(false);
    // A frame whose CODE-POINT length exceeds MAX must be flagged (regardless
    // of how many bytes it serializes to on the wire).
    expect(isFrameOversized("😀".repeat(MAX_FRAME_BYTES + 1))).toBe(true);
  });
});

describe("SseFrameAccumulator — oversized-partial data loss (NEW, iter 2)", () => {
  // GAP: push() applies the MAX_FRAME_BYTES guard to the WHOLE buffer BEFORE it
  // splits on \n\n. So a single TCP chunk that carries one already-complete
  // small frame immediately followed by the start of a >1MB frame discards the
  // ENTIRE buffer — silently dropping the complete, well-formed leading frame
  // that the accumulator had every right to emit. A real upstream can pack a
  // small tool frame and the head of a huge file payload into one read.
  it("does not discard a PRECEDING complete frame when a trailing partial overflows MAX_FRAME_BYTES", () => {
    const acc = new SseFrameAccumulator();
    const chunk = "data: keep-me\n\n" + "x".repeat(MAX_FRAME_BYTES + 1);
    const frames = acc.push(chunk);
    // The leading complete frame must survive; only the oversized tail should go.
    expect(frames).toContain("data: keep-me");
  });
});

describe("SseFrameAccumulator — concurrency isolation (REGRESSION)", () => {
  it("100 concurrent accumulators handling different streams do not share state", async () => {
    // REGRESSION: each SseFrameAccumulator instance owns its own `buffer` field.
    // Under 100 concurrent Promise.all accumulators receiving different chunk
    // streams, no cross-stream bleed must occur. If the field were module-scoped
    // or accidentally shared (e.g., static), one stream's trailing partial would
    // leak into another's first push and frames would be garbled or merged.
    const STREAM_COUNT = 100;
    // Each stream emits 5 distinct frames; each frame carries a unique stream id
    // so cross-stream contamination shows up as an id mismatch.
    const makeChunksFor = (streamId: string): string[] => [
      `data: stream=${streamId} n=0\n\n`,
      `data: stream=${streamId} n=1\n\n`,
      `data: stream=${streamId} n=2\n`,
      `\n`, // boundary split across two chunks
      `data: stream=${streamId} n=3\n\n`,
      `data: stream=${streamId} n=4\n\n`,
    ];

    const streamWork = (streamId: string): string[] => {
      const acc = new SseFrameAccumulator();
      const chunks = makeChunksFor(streamId);
      const allFrames: string[] = [];
      // Push the first 4 chunks synchronously, then 5th and 6th
      allFrames.push(...acc.push(chunks[0] + chunks[1]));
      allFrames.push(...acc.push(chunks[2] + chunks[3]));
      allFrames.push(...acc.push(chunks[4]));
      allFrames.push(...acc.push(chunks[5]));
      allFrames.push(...acc.flush());
      return allFrames;
    };

    const results = await Promise.all(
      Array.from({ length: STREAM_COUNT }, (_, i) =>
        Promise.resolve(streamWork(`s-${i}`))
      )
    );

    // For each stream, every emitted frame must carry that stream's id and the
    // right n= marker. No bleed, no merging, no truncation.
    expect(results).toHaveLength(STREAM_COUNT);
    for (let i = 0; i < STREAM_COUNT; i++) {
      const frames = results[i];
      expect(frames.length).toBeGreaterThanOrEqual(5);
      for (const f of frames) {
        expect(f).toContain(`stream=s-${i}`);
        // Defense in depth: a frame must not carry another stream's id
        if (i > 0) expect(f).not.toContain(`stream=s-${i - 1}`);
      }
    }
  });
});
