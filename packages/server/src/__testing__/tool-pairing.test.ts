import { describe, expect, it } from "vitest";
import {
  countToolCalls,
  resultsAfterFinish,
  unpairedToolCalls,
} from "./tool-pairing";

/**
 * The invariant itself, tested before it is trusted to judge anything.
 *
 * A checker that cannot fail is worse than no checker, and this one is about to
 * be pointed at every adapter — so the cases below are mostly about the ways it
 * could report "all paired" on a stream that is not.
 */

const frame = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}`;
const sse = (...lines: string[]) => lines.join("\n\n") + "\n\n";

const OPEN = frame({
  type: "tool-input-available",
  toolCallId: "tc-1",
  toolName: "increment",
});
const CLOSE = frame({
  type: "tool-output-available",
  toolCallId: "tc-1",
  output: "ok",
});
const FINISH = frame({ type: "finish", finishReason: "stop" });

describe("unpairedToolCalls", () => {
  it("a call with a result is paired", () => {
    expect(unpairedToolCalls(sse(OPEN, CLOSE, FINISH))).toEqual([]);
  });

  it("A CALL WITHOUT A RESULT IS REPORTED — the defect this exists for", () => {
    const un = unpairedToolCalls(sse(OPEN, FINISH));
    expect(un).toHaveLength(1);
    expect(un[0].toolCallId).toBe("tc-1");
    // The name matters: "one tool call was never resolved" sends someone
    // reading frames; "increment was never resolved" sends them to the tool.
    expect(un[0].toolName).toBe("increment");
  });

  it("pairs by ID, not by order", () => {
    // Two calls in flight at once is normal. Matching positionally would call
    // them paired while each holds the other's result.
    const a = frame({
      type: "tool-input-available",
      toolCallId: "a",
      toolName: "x",
    });
    const b = frame({
      type: "tool-input-available",
      toolCallId: "b",
      toolName: "y",
    });
    const closeB = frame({
      type: "tool-output-available",
      toolCallId: "b",
      output: 1,
    });
    const un = unpairedToolCalls(sse(a, b, closeB, FINISH));
    expect(un.map((u) => u.toolCallId)).toEqual(["a"]);
  });

  it("a result arriving BEFORE its input still pairs", () => {
    // Out-of-order frames are a real shape here — useToolState has a whole
    // reconciliation pass for them. Pairing must not depend on arrival order.
    expect(unpairedToolCalls(sse(CLOSE, OPEN, FINISH))).toEqual([]);
  });

  it("`tool-input-start` alone counts as an announced call", () => {
    // The deepagents adapter emits start then available. A card appears on the
    // first of those, so a stream that stops after it owes a result.
    const start = frame({
      type: "tool-input-start",
      toolCallId: "tc-9",
      toolName: "write_file",
    });
    expect(unpairedToolCalls(sse(start, FINISH))).toHaveLength(1);
  });

  it("a tool ERROR counts as resolved — the card has an ending", () => {
    // A failed tool is not a pending tool. Treating an error as unpaired would
    // make this checker fire on correct behaviour, which is how a checker gets
    // deleted.
    const err = frame({
      type: "tool-output-error",
      toolCallId: "tc-1",
      errorText: "boom",
    });
    expect(unpairedToolCalls(sse(OPEN, err, FINISH))).toEqual([]);
  });

  it("a duplicate announcement does not produce two unpaired entries", () => {
    expect(unpairedToolCalls(sse(OPEN, OPEN, FINISH))).toHaveLength(1);
  });

  it("ignores non-tool frames and malformed data lines", () => {
    const noise = [
      frame({ type: "text-delta", delta: "hello" }),
      "data: not json at all",
      "event: token",
      "",
    ];
    expect(unpairedToolCalls(sse(...noise, OPEN, CLOSE, FINISH))).toEqual([]);
  });
});

describe("countToolCalls — the half that makes emptiness mean something", () => {
  it("a stream with NO tool calls has none unpaired, and that is not coverage", () => {
    // The vacuity this repo keeps finding: "no unpaired calls" is trivially
    // true of a stream that never called a tool. Any assertion on
    // unpairedToolCalls must be accompanied by this one, which is why both are
    // exported rather than one convenience helper that hides the distinction.
    const plain = sse(frame({ type: "text-delta", delta: "hi" }), FINISH);
    expect(unpairedToolCalls(plain)).toEqual([]);
    expect(countToolCalls(plain)).toBe(0);
  });

  it("counts distinct ids, not frames", () => {
    expect(countToolCalls(sse(OPEN, OPEN, CLOSE, FINISH))).toBe(1);
  });
});

describe("resultsAfterFinish", () => {
  it("a result after the terminal frame is reported separately", () => {
    // Different defect, different fix: the pairing exists, but the client has
    // stopped listening, so the card is pending on screen while the data sits
    // in a frame nobody read.
    expect(resultsAfterFinish(sse(OPEN, FINISH, CLOSE))).toEqual(["tc-1"]);
  });

  it("a result before finish is not reported", () => {
    expect(resultsAfterFinish(sse(OPEN, CLOSE, FINISH))).toEqual([]);
  });

  it("a stream with no finish frame reports nothing rather than everything", () => {
    // A truncated stream is a different problem, owned by terminal detection.
    // Reporting every result as late here would double-count that failure.
    expect(resultsAfterFinish(sse(OPEN, CLOSE))).toEqual([]);
  });
});
