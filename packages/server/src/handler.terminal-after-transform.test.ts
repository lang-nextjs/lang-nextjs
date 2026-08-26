import { describe, expect, it, vi, afterEach } from "vitest";
import { createSseProxyHandler } from "./handler";
import type { SseFrame, SseTransform } from "./accumulator";
import { NextRequest } from "next/server";

/**
 * A SUCCESSFUL STREAM MUST NOT END WITH AN ERROR FRAME.
 *
 * Reported as "every time I try to use the chat, I have this error:
 * upstream backend disconnected mid-stream" — on streams that had worked. The
 * client received, in this order:
 *
 *   data: {"type":"finish","finishReason":"stop"}
 *   data: {"type":"data-error","code":"upstream_disconnect", ...}
 *
 * A finish frame followed by a disconnection report is a contradiction, and it
 * is the kind that erodes trust in every other error the system produces: once
 * a person learns that this error appears on working requests, they stop
 * reading errors.
 *
 * THE CAUSE IS AN ORDERING. The terminal marker is frequently CREATED by a
 * transform rather than received. The langchain adapter's upstream emits
 * `{"text": "..."}` frames and closes with `{"content": ""}` — no `type` field
 * anywhere — and the adapter is what produces `{"type":"finish"}`. Terminal
 * detection that reads only the raw upstream frame therefore never sees one for
 * that whole class of adapter.
 *
 * These fixtures use the REAL upstream shape, captured from a running backend,
 * rather than a shape invented to make the point.
 */

const enc = new TextEncoder();

/** The exact frames a langchain-adapter backend emits — no `type` field. */
const UPSTREAM_LANGCHAIN = [
  `data: {"text": "The counter has been"}`,
  `data: {"text": " incremented to 5."}`,
  `data: {"content": ""}`,
];

function upstreamServing(frames: string[]): void {
  vi.stubGlobal("fetch", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(frames.join("\n\n") + "\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

const request = () =>
  new NextRequest("http://localhost/api/chat/stream", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    headers: { "content-type": "application/json" },
  });

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

/**
 * A transform that SYNTHESISES the terminal frame, as a real adapter does.
 *
 * A transform is a plain function `(frame) => frame[]`, not an object with a
 * `frame` method — my first version of this fixture used the latter and the
 * handler skipped every frame with "transform error: t is not a function",
 * which failed the tests for a reason that had nothing to do with the subject.
 */
const finishSynthesisingTransform: SseTransform = (frame: SseFrame) => {
  const m = frame.raw.match(/data:\s*(\{.*\})/s);
  if (!m) return frame;
  const parsed = JSON.parse(m[1]) as { text?: string; content?: string };
  if (parsed.text !== undefined) {
    return {
      raw: `data: ${JSON.stringify({ type: "text-delta", delta: parsed.text })}`,
    };
  }
  // The close frame becomes the terminal marker — the case that broke, because
  // the marker does not exist until this line runs.
  return {
    raw: `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}`,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal detection reads the transformed frames", () => {
  it("a stream whose finish frame is SYNTHESISED by a transform is not reported as a disconnect", async () => {
    upstreamServing(UPSTREAM_LANGCHAIN);
    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      transforms: [finishSynthesisingTransform],
    });
    const out = await drain(await handler(request()));

    expect(out).toContain('"type":"finish"');
    // The assertion the report came from. Not `not.toContain("data-error")` —
    // the code is what identifies this specific false alarm, and a different
    // error appearing here would be a different bug worth seeing.
    expect(out).not.toContain("upstream_disconnect");
  });

  it("the finish frame is still the LAST thing the client sees", async () => {
    // Ordering, not just absence. An error frame appended after finish is what
    // made the original report confusing: the stream had already said it was
    // done.
    upstreamServing(UPSTREAM_LANGCHAIN);
    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      transforms: [finishSynthesisingTransform],
    });
    const out = await drain(await handler(request()));
    const frames = out
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    expect(frames[frames.length - 1]).toContain('"type":"finish"');
  });

  it("A GENUINELY TRUNCATED stream is STILL reported — the fix must not silence real ones", async () => {
    // The control, and the reason this cannot be fixed by simply deleting the
    // error frame. An upstream that stops without any terminal marker, through
    // a transform that synthesises none, is a real truncation and has to say so.
    upstreamServing([`data: {"text": "half a sen"}`]);
    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      transforms: [finishSynthesisingTransform],
    });
    const out = await drain(await handler(request()));
    expect(out).toContain("upstream_disconnect");
  });

  it("a terminal frame arriving UNTRANSFORMED is still recognised", async () => {
    // The other direction: an adapter that passes finish through unchanged, or
    // no adapter at all. Checking only the transformed side would break this.
    upstreamServing([`data: {"type":"finish","finishReason":"stop"}`]);
    const handler = createSseProxyHandler({ backendUrl: "http://backend" });
    const out = await drain(await handler(request()));
    expect(out).not.toContain("upstream_disconnect");
  });
});
