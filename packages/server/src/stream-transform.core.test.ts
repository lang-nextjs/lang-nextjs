/**
 * transformSseStream's OWN contract, exercised with no rung in sight (#63).
 *
 * WHY A SECOND FILE RATHER THAN MORE CASES IN THE FIRST. `stream-transform.test.ts`
 * drives this same function through `openSweAdapter`, and every case in it is
 * written in open-swe's tool vocabulary — write_file, save_plan, sub-agent tasks.
 * That file is correct and stays as it is: it tests a real integration.
 *
 * But it is the ONLY exercise of transformSseStream anywhere, and `eject langchain`
 * deletes it along with the rung it speaks for. So core shipped a re-exported,
 * rung-independent function whose entire behavioural coverage lived inside a rung —
 * invisible to every gate here, because `classify.mjs`'s C7 checks that a shared
 * FILE's path does not name a rung, and nothing checks the same claim for BEHAVIOUR.
 * A shared module whose only exercise runs through a rung only surfaces when
 * somebody actually ejects.
 *
 * So the transforms below are stubs declared in this file. Nothing here imports an
 * adapter, and that is the property under test as much as any assertion is: this
 * suite must still run, and still mean something, in a rung-1 fork.
 */
import { describe, it, expect, vi } from "vitest";
import { transformSseStream } from "./stream-transform";
import type { SseFrame, SseMultiTransform } from "./accumulator";

/** An upstream that emits exactly the chunks given, then closes. */
function sourceFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

/** Drain a stream to the list of frames it emitted, boundaries removed. */
async function framesOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text.split("\n\n").filter((s) => s.length > 0);
}

const identity: SseMultiTransform = (f) => f;

describe("transformSseStream — the pipeline's own contract", () => {
  it("passes frames through and re-emits the \\n\\n boundary", async () => {
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\ndata: b\n\n"]), [identity])
    );
    expect(out).toEqual(["data: a", "data: b"]);
  });

  it("emits nothing for an empty upstream, and closes rather than hanging", async () => {
    const out = await framesOf(transformSseStream(sourceFrom([]), [identity]));
    expect(out).toEqual([]);
  });

  it("runs with NO transforms at all — the pipeline is not required to be non-empty", async () => {
    // A fork that ejected every transform-contributing rung passes []. If that
    // threw or dropped everything, the fork would proxy nothing and the failure
    // would look like an upstream problem.
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: x\n\n"]), [])
    );
    expect(out).toEqual(["data: x"]);
  });

  it("drops a frame when a transform returns null", async () => {
    const dropB: SseMultiTransform = (f) => (f.raw.includes("b") ? null : f);
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\ndata: b\n\ndata: c\n\n"]), [
        dropB,
      ])
    );
    expect(out).toEqual(["data: a", "data: c"]);
  });

  it("fans out when a transform returns an array, preserving its order", async () => {
    const split: SseMultiTransform = (f) => [
      { raw: `${f.raw}-1` },
      { raw: `${f.raw}-2` },
    ];
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\n"]), [split])
    );
    expect(out).toEqual(["data: a-1", "data: a-2"]);
  });

  it("chains transforms in order, feeding each fan-out into the next stage", async () => {
    // ORDER IS THE ASSERTION. The two stages are not commutative: doubling then
    // suffixing gives two suffixed frames, suffixing then doubling gives the
    // suffix inside both copies. A pipeline that ran stages in the wrong order
    // would still emit two frames, so a count-only assertion would pass.
    const double: SseMultiTransform = (f) => [f, { raw: `${f.raw}-copy` }];
    const mark: SseMultiTransform = (f) => ({ raw: `${f.raw}!` });
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\n"]), [double, mark])
    );
    expect(out).toEqual(["data: a!", "data: a-copy!"]);
  });

  it("forwards the INPUT frame unchanged when a stage throws, and keeps going", async () => {
    // A transform is third-party-ish code; one bad frame must not kill the
    // stream. The frame after the throwing one proves the pipeline recovered
    // rather than simply surviving to the end of a one-frame stream.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: SseMultiTransform = (f) => {
      if (f.raw.includes("bad")) throw new Error("stage exploded");
      return { raw: `${f.raw}-ok` };
    };
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: bad\n\ndata: good\n\n"]), [boom])
    );
    expect(out).toEqual(["data: bad", "data: good-ok"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("transformSseStream — framing over chunk boundaries", () => {
  it("reassembles a frame split across two chunks", async () => {
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: he", "llo\n\n"]), [identity])
    );
    expect(out).toEqual(["data: hello"]);
  });

  it("accepts CRLF framing — the LangGraph Platform sends \\r\\n\\r\\n", async () => {
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\r\n\r\ndata: b\r\n\r\n"]), [
        identity,
      ])
    );
    expect(out).toEqual(["data: a", "data: b"]);
  });

  it("handles a \\r\\n SPLIT ACROSS CHUNKS — chunk A ends \\r, chunk B starts \\n", async () => {
    // The case the implementation comment claims and nothing asserted.
    //
    // WHAT THIS PINS, STATED HONESTLY. It pins the COMPOSED behaviour and does
    // NOT isolate stream-transform's `.replace(/\r/g, "")`. I wrote the opposite
    // here first — "a pair-replacing implementation yields one frame instead of
    // two, so this discriminates" — then mutated the source to pair-replacement
    // and the case still passed. The reason is that SseFrameAccumulator.push
    // ALREADY normalizes, `.replace(/\r\n/g,"\n").replace(/\r/g,"\n")`, on the
    // accumulated buffer before splitting. Two layers normalize the same thing,
    // so nothing reaching the framing path can tell them apart.
    //
    // The property is still worth asserting and the split IS the hard case — a
    // `\r\n` divided across two reads exists in neither chunk as a pair. It is
    // just guaranteed one layer lower than the comment above it implied.
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"]), [
        identity,
      ])
    );
    expect(out).toEqual(["data: a", "data: b"]);
  });

  it("does not emit a trailing empty frame for a stream ending on a boundary", async () => {
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\n"]), [identity])
    );
    expect(out).toHaveLength(1);
  });

  it("flushes a final frame that arrived WITHOUT a trailing boundary", async () => {
    // Upstream closing mid-frame is a truncation, but what did arrive is still
    // the client's to keep — dropping it silently is the worse of the two.
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\ndata: tail"]), [identity])
    );
    expect(out).toEqual(["data: a", "data: tail"]);
  });
});

describe("transformSseStream — a pull whose frames all drop keeps reading", () => {
  it("does not return an empty pull when every frame in a chunk is filtered", async () => {
    // THE TRUNCATION BUG THIS LOOP EXISTS FOR. Returning from `pull` having
    // enqueued nothing reads as stream-idle to some response layers (Next.js),
    // which truncate the SSE response after the first frame. So a chunk of pure
    // noise must not end the pull — it must keep reading until real output
    // exists or upstream ends.
    //
    // The noise is in ITS OWN CHUNK deliberately: same-chunk noise would be
    // consumed by the same pull as the payload and the case would pass on an
    // implementation that returns early.
    const dropNoise: SseMultiTransform = (f) =>
      f.raw.includes("noise") ? null : f;
    const out = await framesOf(
      transformSseStream(
        sourceFrom([
          "data: noise-1\n\n",
          "data: noise-2\n\n",
          "data: payload\n\n",
        ]),
        [dropNoise]
      )
    );
    expect(out).toEqual(["data: payload"]);
  });

  it("closes cleanly when EVERY frame drops and there is never any output", async () => {
    const dropAll: SseMultiTransform = () => null;
    const out = await framesOf(
      transformSseStream(sourceFrom(["data: a\n\ndata: b\n\n"]), [dropAll])
    );
    expect(out).toEqual([]);
  });
});

/*
 * DRAIN-ON-CLOSE IS NOT COVERED HERE, DELIBERATELY.
 *
 * I wrote four cases for it, then checked what an actual `eject langchain` leaves
 * behind and found `stream-transform-drain.test.ts` already surviving with five —
 * including "drains EVERY pending transform, not just the first" and "a throwing
 * drain does not crash the stream". It imports no adapter, so that half of this
 * module's contract was never rung-bound.
 *
 * #63 says transformSseStream has "zero tests at rungs 1-3". That is true of its
 * PIPELINE contract and not of its drain, and the difference is worth recording
 * rather than papering over with a second copy: duplicate coverage of the drain
 * would have made this file look more thorough while adding nothing, and the next
 * person changing the drain would have had two files to keep in agreement.
 */

describe("transformSseStream — cancellation", () => {
  it("cancels the upstream reader when the consumer cancels", async () => {
    let cancelled: unknown = null;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\n"));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const stream = transformSseStream(upstream, [identity]);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("consumer went away");
    // The upstream must learn about it, or the connection leaks for as long as
    // the backend keeps writing.
    expect(cancelled).toBe("consumer went away");
  });

  it("surfaces an upstream error rather than closing as if it had finished", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("upstream died");
      },
    });
    await expect(
      framesOf(transformSseStream(upstream, [identity]))
    ).rejects.toThrow("upstream died");
  });
});
