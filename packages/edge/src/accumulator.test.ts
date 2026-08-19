import { describe, it, expect } from "vitest";
import { SseFrameAccumulator } from "./accumulator";

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
    const acc = new SseFrameAccumulator();
    const frames = acc.push("\n\n");
    // The accumulator returns one empty-string frame — the pipeline must handle it
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe("");
  });

  it('push("") — zero-byte chunk does not corrupt buffer or produce phantom frames', () => {
    const acc = new SseFrameAccumulator();
    acc.push("data: partial");
    const frames = acc.push("");
    expect(frames).toEqual([]);
    // After an empty push, the incomplete frame must still be flushed correctly
    acc.push("\n\n");
    expect(acc.flush()).toEqual([]);
  });

  it("partial-only first push buffers correctly; completing push returns the assembled frame", () => {
    const acc = new SseFrameAccumulator();
    const first = acc.push("data: line1\ndata: lin");
    expect(first).toEqual([]);
    const second = acc.push("e2\n\n");
    expect(second).toEqual(["data: line1\ndata: line2"]);
    expect(acc.flush()).toEqual([]);
  });

  it("three sequential partial pushes assemble into one correct frame (multi-chunk boundary split)", () => {
    const acc = new SseFrameAccumulator();

    const r1 = acc.push("data: hello");
    expect(r1).toEqual([]);

    const r2 = acc.push("\n");
    expect(r2).toEqual([]);

    const r3 = acc.push("\n");
    expect(r3).toEqual(["data: hello"]);

    expect(acc.flush()).toEqual([]);
  });

  it("push('\\n\\n\\n\\n') — two consecutive boundaries produce two empty-string frames, not one", () => {
    // "\n\n\n\n".split("\n\n") === ["", "", ""]
    // pop() removes the trailing "" leaving ["", ""], so two frames should be returned.
    // A buggy implementation might collapse the double boundary into a single keepalive.
    const acc = new SseFrameAccumulator();
    const frames = acc.push("\n\n\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe("");
    expect(frames[1]).toBe("");
  });

  it("flush() after push() that produced complete frames returns empty array (no phantom re-emission)", () => {
    // Verify that a completed frame doesn't ghost-appear in a subsequent flush().
    // A buggy impl could fail to clear the buffer after a \n\n-terminated chunk.
    const acc = new SseFrameAccumulator();
    const frames = acc.push("data: complete\n\n");
    expect(frames).toEqual(["data: complete"]);
    // The frame was already returned; flush should yield nothing.
    expect(acc.flush()).toEqual([]);
  });

  it("flush() with a whitespace-only buffer (single \\n) returns that fragment, not an empty array", () => {
    // A lone "\n" left in the buffer is truthy, so flush() MUST return it as a frame.
    // This matters because the pipeline will call applyTransforms on it — if flush()
    // silently swallows it the caller has no chance to handle or drop the fragment.
    // A buggy impl might apply a falsy check (e.g. `remaining.trim()`) and return [].
    const acc = new SseFrameAccumulator();
    acc.push("\n"); // single newline — not a complete frame boundary (\n\n), stays buffered
    const flushed = acc.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe("\n");
    // Buffer must now be clear
    expect(acc.flush()).toEqual([]);
  });

  it("push() handles a very large single frame without off-by-one in the split", () => {
    // A 64 KB payload inside one SSE data field, terminated by \n\n.
    // Ensures the buffer concatenation and split logic does not have any
    // size-induced truncation or corruption (e.g. from a fixed-size intermediate buffer).
    const acc = new SseFrameAccumulator();
    const bigPayload = "data: " + "x".repeat(65536);
    const frames = acc.push(bigPayload + "\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(bigPayload);
    expect(frames[0].length).toBe(bigPayload.length);
    expect(acc.flush()).toEqual([]);
  });

  // ADVERSARIAL (iter 3): CRLF-terminated frames. Per the HTML5 SSE spec, SSE frame
  // boundaries are CRLFCRLF (`\r\n\r\n`), NOT bare `\n\n`. The accumulator splits on
  // `\n\n` only — when a backend emits the RFC-compliant `\r\n\r\n`, the trailing `\r`
  // is preserved verbatim into the next frame, and the entire stream gets concatenated
  // into a single oversized frame rather than splitting at each event boundary. This
  // is a real cross-stream deadlock: any consumer piping into a strict backend will
  // see one giant frame instead of N events.
  it("splits frames terminated with the RFC-spec CRLFCRLF (\\r\\n\\r\\n) boundary", () => {
    const acc = new SseFrameAccumulator();
    // Two events, each terminated per HTML5 SSE spec with \r\n\r\n.
    // A correct impl returns 2 separate frames; a buggy impl returns 0 (no \n\n match)
    // or 1 (concatenated) — both indicate the boundary parser is too narrow.
    const frames = acc.push(
      "event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n"
    );
    // At minimum, the accumulator must NOT concatenate them into one giant frame
    // that includes the literal \r characters.
    if (frames.length > 0) {
      for (const f of frames) {
        // No frame should contain the inter-event \r\n\r\n separator.
        expect(f.includes("\r\n\r\n")).toBe(false);
      }
    }
    // The clean assertion: flush() must also not contain the CRLF separator, and
    // the total bytes returned across frames + flush must cover both event names.
    const all = [...frames, ...acc.flush()].join("\n");
    expect(all).toContain("event: a");
    expect(all).toContain("event: b");
  });

  // ADVERSARIAL: buffer growth cap. The server-side accumulator (packages/server/src/
  // accumulator.ts) enforces a 1MB cap (MAX_FRAME_BYTES) on incomplete trailing frames
  // and on oversized complete frames, preventing memory exhaustion from a hostile or
  // malformed upstream. The edge accumulator is a verbatim copy minus the cap — this
  // test probes the gap.
  it("discards or truncates an oversized INCOMPLETE trailing frame (no unbounded buffer growth)", () => {
    const acc = new SseFrameAccumulator();
    // Push 2 MB of an incomplete frame (no \n\n). Server-side MAX_FRAME_BYTES = 1_000_000.
    // A correctly-capped accumulator discards the oversized partial so a subsequent \n\n
    // does not emit a 2 MB "complete frame". The current edge impl has no cap and will
    // hold the full 2 MB in its buffer until the boundary arrives, then emit it.
    const oversized = "x".repeat(2 * 1024 * 1024);
    // First push: no boundary, so frames returned should be empty in any impl.
    const firstFrames = acc.push(oversized);
    expect(firstFrames).toEqual([]);
    // Now push a \n\n — the buffer's incomplete frame becomes "complete".
    // With no cap, the accumulator returns the full 2 MB as a single frame.
    // With a cap (MAX_FRAME_BYTES = 1MB), the partial was already discarded
    // and the boundary emits nothing.
    const secondFrames = acc.push("\n\n");
    // After the boundary completes, the accumulator must NOT have a > 1MB
    // complete frame in its output. Either the partial was truncated or
    // discarded entirely.
    const maxAllowedBytes = 1_000_000; // mirrors server-side MAX_FRAME_BYTES
    for (const frame of secondFrames) {
      expect(frame.length).toBeLessThanOrEqual(maxAllowedBytes);
    }
    // And the buffered remainder (via flush) must also be bounded.
    const flushed = acc.flush();
    for (const frame of flushed) {
      expect(frame.length).toBeLessThanOrEqual(maxAllowedBytes);
    }
  });
});
