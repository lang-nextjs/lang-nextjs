import { describe, expect, it } from "vitest";
import { dataPayloads, frameToEvents, isTerminal } from "./live-run.mjs";
import { liveFinalState, cannedFinalState } from "./canned-run.mjs";

/**
 * A REAL RUN, TRANSLATED INTO THE EVENTS THIS BACKEND SPEAKS.
 *
 * Reported as "we need real run, not fake ones": the queue served a scripted
 * parser fix while the chat surface, on the same machine, answered real
 * questions from the same backend.
 *
 * The two sides speak different protocols and both are load-bearing:
 *
 *   the model backend   AI SDK v6 data-stream frames (text-delta, tool-*)
 *   this backend        LangGraph astream_events v2 (on_chat_model_stream, …)
 *
 * The app proxies this backend through openSweAdapter, which converts
 * LangGraph events INTO AI SDK frames. Emitting AI SDK frames here would be
 * double-converted; bypassing the adapter would stop exercising the code path
 * this rung exists to demonstrate. So frames are translated back into the
 * vocabulary the adapter reads, and the field names below are taken from
 * packages/server/src/adapters/openSwe.ts rather than from memory.
 */

const one = (frame: object, runId = "run-1") =>
  frameToEvents(JSON.stringify(frame), runId)[0];

describe("what the model said becomes what the adapter reads", () => {
  it("a text delta becomes on_chat_model_stream", () => {
    const ev = one({ type: "text-delta", delta: "Hello" });
    expect(ev).toMatchObject({
      event: "on_chat_model_stream",
      data: { chunk: { content: "Hello" } },
    });
  });

  it("a whitespace-only delta is dropped", () => {
    // The adapter drops these anyway (`!content.trim()`), so sending them is
    // harmless — but a blank delta is not content, and not sending it keeps
    // the stream honest about what the model produced.
    for (const d of ["", " ", "\n", "  \t"]) {
      expect(frameToEvents(JSON.stringify({ type: "text-delta", delta: d }), "r")).toEqual([]);
    }
  });

  it("a tool call becomes on_tool_start with its INPUT", () => {
    const ev = one({
      type: "tool-input-available",
      toolCallId: "tc-1",
      toolName: "increment",
      input: { by: 1 },
    });
    expect(ev).toMatchObject({
      event: "on_tool_start",
      name: "increment",
      data: { input: { by: 1 } },
    });
  });

  it("A TOOL EVENT IS KEYED BY THE TOOL CALL, NOT THE RUN", () => {
    // The adapter keys cards by run_id. Using the run's id would collapse
    // every tool in a turn into a single card — two increments would render
    // as one, and the second would overwrite the first.
    const a = one({ type: "tool-input-available", toolCallId: "tc-a", toolName: "x", input: {} });
    const b = one({ type: "tool-input-available", toolCallId: "tc-b", toolName: "x", input: {} });
    expect(a.run_id).toBe("tc-a");
    expect(b.run_id).toBe("tc-b");
    expect(a.run_id).not.toBe(b.run_id);
  });

  it("a tool result becomes on_tool_end with its OUTPUT", () => {
    const ev = one({
      type: "tool-output-available",
      toolCallId: "tc-1",
      toolName: "increment",
      output: "Counter incremented to 38",
    });
    expect(ev).toMatchObject({
      event: "on_tool_end",
      data: { output: "Counter incremented to 38" },
    });
  });

  it("A FAILED TOOL STILL ENDS — it does not hang as pending", () => {
    // #250 was exactly this: a tool card that never resolved because the
    // result never arrived. Dropping an error frame would rebuild it.
    const ev = one({
      type: "tool-output-error",
      toolCallId: "tc-1",
      toolName: "increment",
      errorText: "counter unavailable",
    });
    expect(ev.event).toBe("on_tool_end");
    // `data` is a union across the three event shapes, so the output field is
    // reached through the narrowed member rather than asserted on the union.
    expect(String((ev.data as { output: unknown }).output)).toContain(
      "counter unavailable"
    );
  });

  it("frames it does not understand produce nothing, and do not throw", () => {
    for (const f of ['{"type":"start"}', '{"type":"text-end"}', "not json", "", "{}"]) {
      expect(() => frameToEvents(f, "r"), f).not.toThrow();
      expect(frameToEvents(f, "r"), f).toEqual([]);
    }
  });
});

describe("reading the wire", () => {
  it("splits per LINE, not per frame", () => {
    // The mistake that cost this repo an evening: a greedy match over a whole
    // frame swallowed the boundary, and JSON.parse threw on `text-end` and
    // `finish` arriving together — which is what every adapter emits when it
    // closes a text block.
    const body =
      'data: {"type":"text-end","id":"t1"}\n\ndata: {"type":"finish"}\n\n';
    expect(dataPayloads(body)).toHaveLength(2);
  });

  it("ignores the [DONE] sentinel and blank lines", () => {
    expect(dataPayloads('data: [DONE]\n\n\n\ndata: {"a":1}\n')).toEqual(['{"a":1}']);
  });

  it("handles CRLF, which a proxy can introduce", () => {
    expect(dataPayloads('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it("recognises the terminal frame, and only it", () => {
    expect(isTerminal('{"type":"finish"}')).toBe(true);
    expect(isTerminal('{"type":"text-delta","delta":"finish"}')).toBe(false);
    expect(isTerminal("garbage")).toBe(false);
  });
});

describe("the transcript a live run leaves behind", () => {
  it("CARRIES WHAT THE MODEL SAID", () => {
    const s = liveFinalState("count to three", "1, 2, 3");
    expect(s.values.messages[0].content).toBe("count to three");
    expect(s.values.messages[1].content).toBe("1, 2, 3");
  });

  it("NEVER BORROWS THE SCRIPTED APOLOGY", () => {
    // The failure this split exists to prevent: a real reply rendered under
    // "no model was called", or the scripted sentence shown for a live run.
    const live = JSON.stringify(liveFinalState("t", "a real answer"));
    expect(live).not.toMatch(/scripted|no model was called/i);
  });

  it("invents no files — a live run writes only what its tools wrote", () => {
    // cannedFinalState writes SCRIPTED_RUN.md so the file surface has
    // something to show. Doing that here would put scripted content into a
    // real transcript.
    expect(liveFinalState("t", "answer").values.files).toEqual({});
    expect(Object.keys(cannedFinalState("t").values.files)).toEqual([
      "SCRIPTED_RUN.md",
    ]);
  });

  it("a live run with no text says so, rather than falling back to the script", () => {
    for (const empty of [undefined, "", "   "]) {
      const s = liveFinalState("t", empty as string | undefined);
      expect(s.values.messages[1].content).toMatch(/no text/i);
      expect(s.values.messages[1].content).not.toMatch(/scripted/i);
    }
  });

  it("carries the thread status it was given", () => {
    expect(liveFinalState("t", "a", "busy").status).toBe("busy");
    expect(liveFinalState("t", "a").status).toBe("idle");
  });
});
