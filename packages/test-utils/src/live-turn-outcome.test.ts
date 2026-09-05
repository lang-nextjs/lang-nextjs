import { describe, it, expect } from "vitest";
import { readTurn, classifyTurn, describeTurn } from "./live-turn-outcome";

/**
 * THE CASE THIS EXISTS FOR IS THE ONE THE OLD MESSAGE GOT WRONG (#530).
 *
 * On main, for 34 consecutive runs, the live matrix printed
 *
 *     langgraph called the tool but reported a different number than 4
 *     Received string: ""
 *
 * A wrong number is not an empty string. The first case below reconstructs that exact stream
 * and requires the verdict to be `tool_called_no_text` — if it came back `wrong_number` the
 * classifier would be reproducing the defect it replaces.
 *
 * AND THE FIXTURE IS REQUIRED TO DISCRIMINATE. A reconstruction that yields the right verdict
 * has not shown it is reading anything: the last case holds the frames fixed, varies ONLY the
 * synthesis text, and requires the verdict to move across all three outcomes. A fixture whose
 * verdict does not move is not the case.
 */

const sse = (...frames: unknown[]) =>
  frames
    .map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}`)
    .join("\n\n") + "\n\ndata: [DONE]\n";

const CALL = {
  type: "tool-input-available",
  toolCallId: "t1",
  toolName: "get_counter",
  input: {},
};
const RESULT = {
  type: "tool-output-available",
  toolCallId: "t1",
  toolName: "get_counter",
  output: { value: 4 },
};
const finish = (r: string) => ({ type: "finish", finishReason: r });
const text = (s: string) => ({ type: "text-delta", id: "m1", delta: s });
const OPTS = { tool: "get_counter", expect: "4" };

describe("readTurn / classifyTurn — naming which outcome a turn was", () => {
  it("THE #530 SHAPE: tool called, no synthesis text — not a wrong number", () => {
    const t = readTurn(sse(CALL, RESULT, finish("stop")));
    expect(t.toolCalls).toContain("get_counter");
    expect(t.text).toBe("");

    const v = classifyTurn(t, OPTS);
    expect(v.outcome).toBe("tool_called_no_text");
    // The precise claim the old message could not make.
    expect(v.why).toContain("no number");
    expect(v.outcome).not.toBe("wrong_number");
  });

  it("a genuinely wrong number is reported as one", () => {
    const v = classifyTurn(
      readTurn(sse(CALL, RESULT, text("The counter is 7."), finish("stop"))),
      OPTS
    );
    expect(v.outcome).toBe("wrong_number");
  });

  it("the healthy turn is ok", () => {
    const v = classifyTurn(
      readTurn(sse(CALL, RESULT, text("4"), finish("stop"))),
      OPTS
    );
    expect(v.outcome).toBe("ok");
  });

  it("a swallowed upstream error is named as one, not as a missing tool call", () => {
    /*
     * THE ORDER OF THE BRANCHES IS LOAD-BEARING. An upstream failure also produces no text and
     * no tool call, so a reader that asked "did it call the tool" first would report
     * `no_tool_call` — accusing the app of the defect the provider caused.
     */
    const err = {
      type: "data-error",
      data: {
        id: "stream-error",
        seq: 0,
        code: "backend_error",
        message: "Service temporarily overloaded",
        retryable: false,
        origin: "provider",
      },
    };
    const t = readTurn(sse(err, finish("error")));
    expect(t.errors).toHaveLength(1);
    const v = classifyTurn(t, OPTS);
    expect(v.outcome).toBe("upstream_error");
    expect(v.why).toContain("provider");
    expect(v.why).toContain("Service temporarily overloaded");
    expect(v.outcome).not.toBe("no_tool_call");
  });

  it("answering from context without calling the tool is its own outcome", () => {
    const v = classifyTurn(
      readTurn(sse(text("The counter is 4."), finish("stop"))),
      OPTS
    );
    expect(v.outcome).toBe("no_tool_call");
    expect(v.why).toContain("never called");
  });

  it("a stream with no frames at all is not any of the model outcomes", () => {
    const v = classifyTurn(readTurn("data: [DONE]\n"), OPTS);
    expect(v.outcome).toBe("empty_stream");
  });

  it("nothing is silently dropped: unknown types are counted, bad payloads are counted", () => {
    const t = readTurn(
      sse(
        CALL,
        { type: "data-something-new", data: {} },
        "{not json",
        finish("stop")
      )
    );
    expect(t.frameTypes["data-something-new"]).toBe(1);
    expect(t.unparsable).toBe(1);
    // The census is the point — a frame this repo starts emitting shows up as a number rather
    // than as silence, which is how the old reader lost data-error.
    expect(Object.keys(t.frameTypes)).toContain("tool-input-available");
  });

  it("describeTurn prints the turn, so a failure is readable without re-running", () => {
    const d = describeTurn(
      readTurn(sse(CALL, RESULT, text("hi"), finish("stop")))
    );
    for (const field of [
      "frames",
      "frame types",
      "tool calls",
      "tool results",
      "finish reason",
      "errors",
      "text",
    ]) {
      expect(d).toContain(field);
    }
    expect(d).toContain("get_counter");
    expect(d).toContain("stop");
  });

  it("MUTATION: holding the frames fixed and varying only the text moves the verdict", () => {
    /*
     * Without this the cases above could all pass against a classifier that returned a
     * constant. The frames are identical in all three; only the synthesis text differs, and
     * the verdict has to follow it.
     */
    const verdicts = ["", "7", "4"].map(
      (s) =>
        classifyTurn(
          readTurn(sse(CALL, RESULT, ...(s ? [text(s)] : []), finish("stop"))),
          OPTS
        ).outcome
    );
    expect(verdicts).toEqual(["tool_called_no_text", "wrong_number", "ok"]);
    expect(new Set(verdicts).size).toBe(3);
  });
});
