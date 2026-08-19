import { describe, it, expect } from "vitest";
import { SseFrameAccumulator } from "./accumulator";

// ---------------------------------------------------------------------------
// Drift guard for the copy-not-import SseFrameAccumulator.
// Source of truth: packages/server/src/accumulator.ts. The sveltekit copy is
// kept verbatim so the same source compiles into the edge package without
// pulling in Next.js. These tests pin BEHAVIOR — a botched manual sync (e.g.
// split() only on \n\n but not \r\n\r\n) must fail here.
// ---------------------------------------------------------------------------

describe("SseFrameAccumulator — CRLF frame terminators (per SSE spec)", () => {
  // Per the SSE spec (HTML living standard, "server-sent events"), a frame is
  // terminated by either \n\n OR \r\n\r\n. The current implementation only
  // splits on the literal "\n\n" substring. An upstream that emits proper
  // CRLF-delimited frames ("data: hello\r\n\r\n") therefore arrives as one
  // undelimited chunk — the \n\n split returns the entire input untouched,
  // so the frame stays buffered forever and the handler never sees it.

  it("splits a CRLF-delimited single frame in one chunk", () => {
    const acc = new SseFrameAccumulator();
    const frames = acc.push("data: hello\r\n\r\n");
    // Correct behavior: ["data: hello"] — frame emitted, trailing \r stripped.
    // Current bug: [] — no \n\n substring, so the whole input stays buffered.
    expect(frames).toEqual(["data: hello"]);
    expect(acc.flush()).toEqual([]);
  });

  it("handles many CRLF-delimited frames in a single chunk (100 frames)", () => {
    // Real-world high-volume case: a proxy streams hundreds of CRLF frames in
    // a single TCP read. Each \r\n\r\n boundary must produce one frame.
    const acc = new SseFrameAccumulator();
    let chunk = "";
    for (let i = 0; i < 100; i++) chunk += `data: ${i}\r\n\r\n`;
    const frames = acc.push(chunk);
    expect(frames).toHaveLength(100);
    expect(frames[0]).toBe("data: 0");
    expect(frames[99]).toBe("data: 99");
    expect(acc.flush()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — iter 7 likely-OK probe: pushing an empty-string chunk must
// be a no-op. The accumulator's contract is "push a decoded string chunk,
// returns frames found". A zero-length chunk must NOT (a) return phantom
// empty frames, (b) trigger the oversized-buffer reset, or (c) corrupt the
// partial frame already in the buffer. A network often delivers zero-byte
// reads (e.g. an idle keep-alive read on a stalled TCP socket), and the
// accumulator must treat them as nothing-happened.
// ---------------------------------------------------------------------------

describe("SseFrameAccumulator — empty chunk no-op (iter 7 likely-OK probe)", () => {
  it("pushing an empty string returns [] and does not corrupt a pending partial frame", () => {
    const acc = new SseFrameAccumulator();

    // 1. Empty chunk with no prior state — must return [] and flush [].
    expect(acc.push("")).toEqual([]);
    expect(acc.flush()).toEqual([]);

    // 2. Empty chunk after a partial frame is in the buffer — the partial
    //    must survive intact (empty push must NOT be treated as a frame
    //    boundary, must NOT flush the buffer, must NOT reset state).
    const acc2 = new SseFrameAccumulator();
    // Push half a frame (no terminating \n\n yet).
    expect(acc2.push("data: partial")).toEqual([]);
    // Empty push must be a true no-op: nothing returned, buffer preserved.
    expect(acc2.push("")).toEqual([]);
    // The pending partial must still be in the buffer — flushed as-is on
    // flush(). This pins that "" is not a frame delimiter.
    expect(acc2.flush()).toEqual(["data: partial"]);

    // 3. Empty chunk interleaved with real frames — the real frames must
    //    still split correctly. If empty-push corrupted the buffer or
    //    counter state, the boundary detection would break here.
    const acc3 = new SseFrameAccumulator();
    expect(acc3.push("data: a\n\n")).toEqual(["data: a"]);
    expect(acc3.push("")).toEqual([]);
    expect(acc3.push("data: b\n\n")).toEqual(["data: b"]);
    expect(acc3.push("")).toEqual([]);
    expect(acc3.flush()).toEqual([]);
  });
});
