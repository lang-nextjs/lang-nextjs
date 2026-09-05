/**
 * RUNG 2's ACCEPTANCE CRITERION, PROVEN THE WAY #7's WAS.
 *
 * "Emit astream_events v2 frames so `langGraphAdapter` consumes both languages
 * unchanged." As on #348, "it did not throw" is not the assertion — the adapter
 * has a pass-through path, so a wrong wire produces valid-looking frames rather
 * than an error. Two checks make the criterion real:
 *
 *   1. GROUND TRUTH. The Python frames captured in
 *      packages/server/src/__fixtures__/langgraph-astream-events-v2.json are run
 *      through THIS module's filter and serialiser. If node's treatment of a
 *      real Python frame differs, the two runtimes are not interchangeable and
 *      that is what "consumes both languages unchanged" is about.
 *   2. FULL NORMALISATION. Frames this module emits go through the REAL
 *      langGraphAdapter, and every output must be an AI SDK v6 part carrying
 *      content — not merely "some frame came out the other end".
 *
 * Nothing in packages/server is touched.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  langGraphAdapter,
  transformSseStream,
} from "@deepagents-nextjs/server";
import {
  eventFrame,
  lcSerialize,
  shouldEmit,
  DONE_FRAME,
} from "./langgraph.js";

const FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/server/src/__fixtures__/langgraph-astream-events-v2.json",
    import.meta.url
  )
);

type Frame = {
  event: string;
  name?: string;
  run_id?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

function fixtureFrames(): Frame[] {
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8")) as { frames: Frame[] };
  // Anti-vacuity: a fixture that failed to load would make every assertion
  // below pass over an empty list.
  expect(doc.frames.length, "the fixture is empty").toBeGreaterThan(0);
  return doc.frames;
}

/** Run raw frames through the real adapter and return the AI SDK v6 parts. */
async function throughAdapter(
  raw: string
): Promise<Array<Record<string, unknown>>> {
  const upstream = new Response(raw).body!;
  const out = await new Response(
    transformSseStream(upstream, langGraphAdapter.transforms)
  ).text();
  return out
    .split("\n\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => {
      expect(f.startsWith("data: "), `not an SSE data frame: ${f}`).toBe(true);
      return JSON.parse(f.slice(6)) as Record<string, unknown>;
    });
}

describe("against the captured Python frames", () => {
  it("this module's filter keeps exactly the events the Python wire carries", () => {
    const frames = fixtureFrames();
    const kept = frames.filter(shouldEmit).map((f) => f.event);

    // The fixture is a REACT run, so its model streams come from the `agent`
    // node and none are suppressed. Written as a literal rather than derived
    // from shouldEmit — deriving both sides gives a test that passes for any
    // filter, which is how a stale expectation survives (#145).
    expect(kept).toEqual([
      "on_chat_model_stream",
      "on_chat_model_stream",
      "on_chat_model_stream",
      "on_chat_model_stream",
      "on_chat_model_stream",
      "on_tool_start",
      "on_tool_end",
    ]);

    // And the negative: the chain lifecycle events are dropped, not forwarded.
    const dropped = frames.filter((f) => !shouldEmit(f)).map((f) => f.event);
    expect(new Set(dropped)).toEqual(
      new Set([
        "on_chain_start",
        "on_chat_model_start",
        "on_chat_model_end",
        "on_chain_stream",
        "on_chain_end",
      ])
    );
  });

  it("re-serialising a Python frame does not change it", () => {
    // lcSerialize exists to make JS objects look like Python's model_dump().
    // Applied to something Python already produced it must be the IDENTITY —
    // otherwise node would be rewriting frames the two runtimes are supposed to
    // agree on, and the divergence would be invisible until a client rendered.
    for (const frame of fixtureFrames()) {
      expect(lcSerialize(frame)).toEqual(frame);
    }
  });

  it("the real adapter normalises the Python frames end to end", async () => {
    const raw =
      fixtureFrames().filter(shouldEmit).map(eventFrame).join("") + DONE_FRAME;
    const parts = await throughAdapter(raw);

    const types = parts.map((p) => p.type);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");

    // CONTENT, not just shape. The reassembled text is what a person reads, and
    // a stream of empty deltas would satisfy every type assertion above.
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text.length, "the deltas carried no text").toBeGreaterThan(0);
  });
});

describe("frames this module emits", () => {
  it("carry content through the adapter, envelope and all", async () => {
    // The JS-side shape: a LangChain constructor envelope, which is what
    // JSON.stringify produces and what lcSerialize has to flatten. If it did
    // not, `data.chunk.content` would be undefined, the adapter would emit
    // nothing, and NOTHING WOULD FAIL — see langgraph.test.ts.
    const raw =
      eventFrame({
        event: "on_chat_model_stream",
        name: "ChatOpenAI",
        run_id: "r1",
        data: {
          chunk: {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { content: "hello from node" },
          },
        },
        metadata: { langgraph_node: "agent" },
      }) + DONE_FRAME;

    const parts = await throughAdapter(raw);
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(
      text,
      "the adapter produced no text — data.chunk.content was not where it reads it"
    ).toBe("hello from node");
  });
});
