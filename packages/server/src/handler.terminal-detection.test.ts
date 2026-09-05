import { describe, expect, it, vi, afterEach } from "vitest";
import { createSseProxyHandler } from "./handler";
import { NextRequest } from "next/server";

/**
 * TERMINAL DETECTION, ON THE WIRE FORMATS THE BACKENDS ACTUALLY SEND.
 *
 * Reported as "every time I try to use the chat, I have this error: upstream
 * backend disconnected mid-stream" — on streams that produced text and ended
 * with their own `finish` frame. The client received a contradiction:
 *
 *   data: {"type":"finish","finishReason":"stop"}
 *   data: {"type":"data-error","code":"upstream_disconnect", ...}
 *
 * THE PREDICATE WAS ANCHORED TO THE FRAME, AND A FRAME IS NOT A LINE. Measured
 * against the old implementation:
 *
 *   data: {"type":"finish",...}                                -> true
 *   data: {"type":"text-end"...}\n\ndata: {"type":"finish"...}  -> FALSE
 *   data: [DONE]                                               -> FALSE
 *   [DONE]                                                     -> true
 *
 * The second is what every adapter that closes an open text block emits. The
 * third is what ai_backends/langgraph.py writes. The fourth — a bare sentinel
 * with no `data:` prefix — was the ONLY shape the existing test fed, so the
 * check named the property and could not fail on real traffic.
 *
 * EACH CASE IS A PAIR, AND THE PAIR IS THE POINT. A clean stream must not
 * report a disconnect; a truncated one must. Either half alone is worthless
 * here, and not symmetrically: the truncated half PASSED against the buggy
 * build. Adding only that would have read as coverage while proving nothing.
 */

const enc = new TextEncoder();

function upstream(frames: string[]): void {
  vi.stubGlobal("fetch", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(frames.join("\n\n") + "\n\n"));
        c.close();
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

afterEach(() => vi.unstubAllGlobals());

/**
 * PER-ADAPTER WIRE FORMATS ARE TESTED WITH THEIR RUNG, NOT HERE.
 *
 * The first version of this file imported langchainAdapter and langGraphAdapter
 * to prove the fix against the shapes those backends actually send. It was
 * correct about the shapes and wrong about the location: severability.test.ts
 * failed it immediately —
 *
 *   handler.terminal-detection.test.ts -> adapters/langchain.ts
 *   handler.terminal-detection.test.ts -> adapters/langgraph.ts
 *
 * — because a SHARED file must not reach a rung-owned one. A fork that ejects
 * langchain would have taken the adapter and left a shared test importing it.
 *
 * The paired clean/truncated cases now live in adapters/langchain.test.ts and
 * adapters/langgraph.test.ts, which are owned by those rungs and travel with
 * them. What stays here is what is genuinely core: the sentinel and the frame
 * parsing, which no rung owns.
 */

describe("the predicate itself, on the shapes that defeated it", () => {
  it("a COMPOUND frame carrying finish alongside another part is terminal", async () => {
    // `closeText(state) + finishFrame` — what an adapter emits when a text
    // block is open, which is every non-degenerate stream. The old greedy
    // `data:\s*(\{.*\})` swallowed the frame boundary and JSON.parse threw.
    upstream([
      `data: {"type":"text-end","id":"t1"}\n\ndata: {"type":"finish","finishReason":"stop"}`,
    ]);
    const out = await drain(
      await createSseProxyHandler({ backendUrl: "http://b" })(request())
    );
    expect(out).not.toContain("upstream_disconnect");
  });

  it("`data: [DONE]` is terminal — the sentinel as it appears on the wire", async () => {
    // The old check tested the WHOLE frame against /^\s*\[DONE\]\s*$/, so it
    // recognised a bare sentinel that no backend sends and missed the prefixed
    // one that two of them do.
    upstream([`data: {"type":"text","content":"x"}`, `data: [DONE]`]);
    const out = await drain(
      await createSseProxyHandler({ backendUrl: "http://b" })(request())
    );
    expect(out).not.toContain("upstream_disconnect");
  });

  it("a frame merely CONTAINING the word finish is not terminal", async () => {
    // The over-broad direction, which is the dangerous one: it would latch on
    // model output and silence a genuine truncation.
    upstream([
      `data: {"type":"text-delta","delta":"let me finish that thought"}`,
    ]);
    const out = await drain(
      await createSseProxyHandler({ backendUrl: "http://b" })(request())
    );
    expect(out).toContain("upstream_disconnect");
  });
});
