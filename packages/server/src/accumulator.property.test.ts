/**
 * Property-based tests for SseFrameAccumulator.
 *
 * Unit tests verify specific scenarios; properties verify INVARIANTS
 * across a large fuzz-style input space. Key invariants we encode:
 *
 *   1. Re-assembly: regardless of how a complete SSE body is split
 *      into chunks (1-byte slices, large blocks, mixed sizes), feeding
 *      them in order to the accumulator + flushing yields the same set
 *      of frames as feeding the whole body at once.
 *
 *   2. Boundary independence: the `\n\n` event separator is correctly
 *      detected even when it straddles a chunk boundary (e.g. `\n` in
 *      chunk N, `\n` in chunk N+1).
 *
 *   3. No phantom output: an empty accumulator that's flushed produces
 *      no frames.
 */
import { describe, it } from "vitest";
import fc from "fast-check";
import { SseFrameAccumulator } from "./accumulator";

// Arbitrary frame body — alphanumeric to keep the assertions readable,
// no `\n` characters that would corrupt the event boundary.
const arbFrameBody = fc.string({
  minLength: 1,
  maxLength: 200,
  unit: fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}:\",.[]-_ "
      .split("")
  ),
});

const arbFrames = fc.array(arbFrameBody, { minLength: 1, maxLength: 20 });

function buildBody(frames: string[]): string {
  return frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n";
}

function allFramesViaAccumulator(body: string, chunkSizes: number[]): string[] {
  const acc = new SseFrameAccumulator();
  const out: string[] = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= body.length) break;
    const chunk = body.slice(offset, offset + size);
    offset += size;
    for (const f of acc.push(chunk)) out.push(f);
  }
  if (offset < body.length) {
    for (const f of acc.push(body.slice(offset))) out.push(f);
  }
  for (const f of acc.flush()) out.push(f);
  return out;
}

describe("SseFrameAccumulator — properties", () => {
  it("re-assembly invariant: any chunking of a valid SSE body yields the same frames as feeding the whole body", () => {
    fc.assert(
      fc.property(
        arbFrames,
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 50 }),
        (frames, chunkSizes) => {
          const body = buildBody(frames);
          const whole = allFramesViaAccumulator(body, [body.length]);
          const chunked = allFramesViaAccumulator(body, chunkSizes);
          // Both paths must yield the same frame sequence.
          return JSON.stringify(whole) === JSON.stringify(chunked);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("byte-by-byte slicing produces the same output as bulk feed", () => {
    fc.assert(
      fc.property(arbFrames, (frames) => {
        const body = buildBody(frames);
        const bulk = allFramesViaAccumulator(body, [body.length]);
        const byByte = allFramesViaAccumulator(
          body,
          new Array(body.length).fill(1)
        );
        return JSON.stringify(bulk) === JSON.stringify(byByte);
      }),
      { numRuns: 100 }
    );
  });

  it("flushing a fresh accumulator produces no frames", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const acc = new SseFrameAccumulator();
        const out = [...acc.flush()];
        return out.length === 0;
      }),
      { numRuns: 10 }
    );
  });
});
