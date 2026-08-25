import { describe, it, expect, vi } from "vitest";
import { transformSseStream } from "./stream-transform";
import type { SseFrame, SseMultiTransform } from "./accumulator";

/**
 * `transformSseStream` must drain a paused transform before closing (#25b/#39,
 * re-found in #160).
 *
 * WHY THIS TEST EXISTS. `createDeepAgentsHandler` has called
 * `hasPending()`/`drainOnClose()` at upstream close since #39. This helper —
 * the one open-swe's chat route actually uses — did not, so a gating transform
 * composed through it buffered frames that became unreachable the moment
 * upstream ended: no frame, no error, and an approval POST that still returned
 * 200. The bug was fixed in one caller and left live in the other.
 *
 * The fake below is deliberately a plain object with the two optional methods
 * rather than the real approval transform: this helper's contract is structural
 * ("anything that can pause and release later"), and testing it against the
 * real gate would prove the pair works together while leaving the contract
 * itself unasserted.
 */

/** The structural contract transformSseStream looks for at close. */
type Drainable = SseMultiTransform & {
  hasPending?: () => boolean;
  drainOnClose?: () => Promise<SseFrame[]>;
};

function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function upstreamOf(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`${f}\n\n`));
      c.close();
    },
  });
}

/** A transform that swallows frames after `pauseAfter` and releases them later. */
function pausingTransform(opts: { releases: SseFrame[]; pending: boolean }) {
  const t: SseMultiTransform & {
    hasPending?: () => boolean;
    drainOnClose?: () => Promise<SseFrame[]>;
  } = (frame: SseFrame) => {
    if (frame.raw.includes("SWALLOW")) return null;
    return frame;
  };
  t.hasPending = () => opts.pending;
  t.drainOnClose = async () => opts.releases;
  return t;
}

describe("transformSseStream — drain before close", () => {
  it("emits frames released at upstream close", async () => {
    const t = pausingTransform({
      pending: true,
      releases: [
        { raw: 'data: {"type":"text-delta","delta":"held back"}' },
        { raw: 'data: {"type":"finish"}' },
      ],
    });

    const out = await collect(
      transformSseStream(
        upstreamOf(['data: {"type":"start"}', "data: SWALLOW"]),
        [t]
      )
    );

    expect(out).toContain('"type":"start"');
    // The whole point: these exist only because drainOnClose was called.
    expect(out).toContain("held back");
    expect(out).toContain('"type":"finish"');
  });

  it("does NOT call drainOnClose when nothing is pending", async () => {
    const drain = vi.fn(async () => []);
    const t: Drainable = (f: SseFrame) => f;
    t.hasPending = () => false;
    t.drainOnClose = drain;

    await collect(
      transformSseStream(upstreamOf(['data: {"type":"start"}']), [t])
    );

    // A helper that drained unconditionally would pass the test above while
    // doing needless work on every stream — and would mask a hasPending() that
    // had stopped reporting correctly.
    expect(drain).not.toHaveBeenCalled();
  });

  it("tolerates a plain transform with neither method", async () => {
    const plain: SseMultiTransform = (f: SseFrame) => f;
    const out = await collect(
      transformSseStream(upstreamOf(['data: {"type":"start"}']), [plain])
    );
    expect(out).toContain('"type":"start"');
  });

  it("a throwing drain does not crash the stream or lose earlier frames", async () => {
    const t: Drainable = (f: SseFrame) => f;
    t.hasPending = () => true;
    t.drainOnClose = async () => {
      throw new Error("registry unreachable");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await collect(
      transformSseStream(upstreamOf(['data: {"type":"start"}']), [t])
    );

    // Draining is a best-effort recovery of frames that would otherwise be
    // lost; a failure there must not turn a partial stream into a broken one.
    expect(out).toContain('"type":"start"');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("drains EVERY pending transform, not just the first", async () => {
    const a = pausingTransform({
      pending: true,
      releases: [{ raw: "data: FROM-A" }],
    });
    const b = pausingTransform({
      pending: true,
      releases: [{ raw: "data: FROM-B" }],
    });

    const out = await collect(
      transformSseStream(upstreamOf(['data: {"type":"start"}']), [a, b])
    );

    // A `find`-then-drain implementation would satisfy the first test and drop
    // the second transform's frames.
    expect(out).toContain("FROM-A");
    expect(out).toContain("FROM-B");
  });
});
