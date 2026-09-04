import { describe, expect, it } from "vitest";
import {
  collectToolCalls,
  dataPayloads,
  frameErrorText,
  frameToEvents,
  isTerminal,
  toolMessages,
} from "./live-run.mjs";
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
      expect(
        frameToEvents(JSON.stringify({ type: "text-delta", delta: d }), "r")
      ).toEqual([]);
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
    const a = one({
      type: "tool-input-available",
      toolCallId: "tc-a",
      toolName: "x",
      input: {},
    });
    const b = one({
      type: "tool-input-available",
      toolCallId: "tc-b",
      toolName: "x",
      input: {},
    });
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
    for (const f of [
      '{"type":"start"}',
      '{"type":"text-end"}',
      "not json",
      "",
      "{}",
    ]) {
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
    expect(dataPayloads('data: [DONE]\n\n\n\ndata: {"a":1}\n')).toEqual([
      '{"a":1}',
    ]);
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

/**
 * THE TOOLS A RUN CALLED, KEPT FOR THE TRANSCRIPT.
 *
 * Reported as "I wish we could see the input and outputs of the tasks in this
 * page". They were on screen while the run streamed and gone the moment it
 * finished: the live path kept only the assistant TEXT, so a run that called
 * three tools persisted as a bare reply. ConversationView has rendered tool
 * args and results all along — it was never given any.
 */
describe("collecting a run's tool calls", () => {
  const feed = (...frames: object[]) => {
    const c = collectToolCalls();
    for (const f of frames) c.accept(JSON.stringify(f));
    return c.list();
  };

  it("pairs an input with its output BY ID", () => {
    const [t] = feed(
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "increment",
        input: { by: 1 },
      },
      {
        type: "tool-output-available",
        toolCallId: "a",
        output: "Counter is 38",
      }
    );
    expect(t).toMatchObject({
      name: "increment",
      args: { by: 1 },
      result: "Counter is 38",
    });
  });

  it("THE NAME IS TAKEN FROM `tool-input-start` TOO", () => {
    // Only the input frames carry a name — `tool-output-available` is
    // `{toolCallId, output}` by the SDK's own strictObject schema. Reading
    // only `input-available` left calls named after the literal fallback.
    const [t] = feed(
      { type: "tool-input-start", toolCallId: "a", toolName: "get_counter" },
      { type: "tool-output-available", toolCallId: "a", output: "37" }
    );
    expect(t.name).toBe("get_counter");
  });

  it("A KNOWN NAME IS NEVER DOWNGRADED by a later frame", () => {
    // The output frame has no name. Merging it must not overwrite one already
    // learned, or every completed call reverts to the fallback.
    const [t] = feed(
      { type: "tool-input-start", toolCallId: "a", toolName: "increment" },
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "increment",
        input: {},
      },
      { type: "tool-output-available", toolCallId: "a", output: "ok" }
    );
    expect(t.name).toBe("increment");
  });

  it("keeps CALL ORDER — a reordered transcript misrepresents the run", () => {
    const out = feed(
      { type: "tool-input-start", toolCallId: "a", toolName: "first" },
      { type: "tool-input-start", toolCallId: "b", toolName: "second" },
      { type: "tool-output-available", toolCallId: "b", output: "2" },
      { type: "tool-output-available", toolCallId: "a", output: "1" }
    );
    expect(out.map((t) => t.name)).toEqual(["first", "second"]);
  });

  it("A FAILED TOOL IS RECORDED, not dropped", () => {
    // Dropping it leaves a tool that appears to have run and returned nothing
    // — the #250 shape, persisted this time.
    const [t] = feed(
      { type: "tool-input-start", toolCallId: "a", toolName: "increment" },
      {
        type: "tool-output-error",
        toolCallId: "a",
        errorText: "counter unavailable",
      }
    );
    expect(String(t.result)).toContain("counter unavailable");
    expect(t.failed).toBe(true);
  });

  it("an output with no announcement is still recorded", () => {
    // Defensive: a backend that fails to announce a call still sends its
    // result, and losing it entirely is worse than a card with no name. This
    // exact shape was live until the backend's buffer-reuse bug was fixed.
    const [t] = feed({
      type: "tool-output-available",
      toolCallId: "z",
      output: "42",
    });
    expect(t.result).toBe("42");
  });

  it("ignores frames with no tool-call id, and junk", () => {
    expect(feed({ type: "text-delta", delta: "hi" })).toEqual([]);
    const c = collectToolCalls();
    expect(() => c.accept("not json")).not.toThrow();
    expect(c.list()).toEqual([]);
  });
});

describe("the wire shape a transcript needs", () => {
  it("emits an ai message with tool_calls, and one tool message per result", () => {
    // The exact shape normalizeMessages pairs on: `tool_calls[].id` against
    // `tool_call_id`. Built here because it is a wire format — the same one a
    // real LangGraph thread returns — and the page must not learn two ways to
    // read a transcript.
    const msgs = toolMessages([
      { id: "a", name: "increment", args: { by: 1 }, result: "38" },
    ]);
    expect(msgs[0]).toMatchObject({
      type: "ai",
      tool_calls: [{ id: "a", name: "increment", args: { by: 1 } }],
    });
    expect(msgs[1]).toMatchObject({
      type: "tool",
      tool_call_id: "a",
      content: "38",
    });
  });

  it("a call with no result yields no tool message", () => {
    // An unresolved call must not fabricate an empty result, which would
    // render as a tool that returned nothing.
    const msgs = toolMessages([{ id: "a", name: "x", args: {} }]);
    expect(msgs).toHaveLength(1);
  });

  it("no tools means no messages at all", () => {
    expect(toolMessages([])).toEqual([]);
    expect(toolMessages(undefined as never)).toEqual([]);
  });

  it("a non-string result is serialised, not dropped", () => {
    const msgs = toolMessages([
      { id: "a", name: "x", args: {}, result: { n: 1 } },
    ]);
    expect(msgs[1].content).toBe('{"n":1}');
  });
});

/**
 * WHY A STREAM CARRIED NO ANSWER, IN THE BACKEND'S OWN WORDS.
 *
 * The fixture is a frame captured from the running backend, not one written
 * from the schema: the message lives at `data.message`, and every reader in
 * this repo that guessed a FLAT `message` returned nothing for it. A fixture
 * invented from the type would have shared that blind spot.
 */
const OVERLOADED = JSON.stringify({
  type: "data-error",
  data: {
    id: "stream-error",
    seq: 0,
    code: "backend_error",
    message: "Service temporarily overloaded",
    retryable: false,
    origin: "provider",
    cause: { exception: "APIError" },
  },
});

describe("frameErrorText", () => {
  it("reads the message a real backend actually sends", () => {
    expect(frameErrorText(OVERLOADED)).toBe("Service temporarily overloaded");
  });

  it("returns null for frames that are not errors, so a caller can tell", () => {
    // THREE ANSWERS, NOT TWO. `null` (not an error) and `""` (an error nobody
    // described) are different facts, and a reader that collapses them reports
    // a healthy stream as a failed one or the reverse.
    expect(
      frameErrorText('{"type":"text-delta","id":"t","delta":"hi"}')
    ).toBeNull();
    expect(
      frameErrorText('{"type":"finish","finishReason":"stop"}')
    ).toBeNull();
    expect(frameErrorText("not json at all")).toBeNull();
    expect(frameErrorText('{"type":"data-error","data":{"code":null}}')).toBe(
      ""
    );
  });

  it("accepts the AI SDK's flatter error shapes too", () => {
    expect(
      frameErrorText('{"type":"error","errorText":"upstream refused"}')
    ).toBe("upstream refused");
    expect(frameErrorText('{"type":"error","message":"rate limited"}')).toBe(
      "rate limited"
    );
  });

  it("cannot break the header it rides in", () => {
    // The reason travels as `x-openswe-agent-mode-reason`. A newline in a
    // header value is ERR_INVALID_CHAR — Node throws, inside the run's own
    // response, so a bad model day would become a broken queue.
    const said = frameErrorText(
      JSON.stringify({
        type: "data-error",
        data: { message: "line one\nline two\r\n\ttabbed  \u00e9" },
      })
    );
    expect(said).not.toMatch(/[\r\n]/);
    expect(said).toBe("line one line two tabbed");
  });

  it("redacts anything key-shaped, because this text ends up on screen", () => {
    // #262 keeps raw upstream detail out of the DOM; the provenance banner is
    // the argued exception, and this is the cost that exception has to pay.
    // A provider quoting the credential back is the realistic way one leaks.
    const said = frameErrorText(
      JSON.stringify({
        type: "data-error",
        data: {
          message:
            "invalid api key nvapi-Hs83jdKwoeMzQ1x9ZZa2LLpq7vv for account",
        },
      })
    );
    expect(said).toContain("[redacted]");
    expect(said).not.toContain("nvapi-Hs83jdKwoeMzQ1x9ZZa2LLpq7vv");
    // POSITIVE CONTROL: the redaction must not simply eat every message.
    expect(frameErrorText(OVERLOADED)).toBe("Service temporarily overloaded");
  });

  it("clips a provider that answers with a stack trace", () => {
    const said = frameErrorText(
      JSON.stringify({ type: "data-error", data: { message: "x".repeat(500) } })
    );
    expect(said!.length).toBeLessThanOrEqual(120);
  });
});
