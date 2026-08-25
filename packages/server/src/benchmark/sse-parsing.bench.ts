/**
 * Benchmark: SSE parsing speed via stripMessageIdTransform
 *
 * Measures how fast stripMessageIdTransform processes finish frames
 * (with messageId to strip), regular messages, tool calls, and mixed sequences.
 */
import { bench, describe } from "vitest";
import { stripMessageIdTransform } from "../transforms";
import type { SseFrame } from "../accumulator";

const makeFrame = (data: string): SseFrame => ({ raw: `data: ${data}\n\n` });

const FINISH_FRAME_WITH_ID = makeFrame(
  JSON.stringify({ type: "finish", messageId: "msg_123", finishReason: "stop" })
);
const FINISH_FRAME_NO_ID = makeFrame(
  JSON.stringify({ type: "finish", finishReason: "stop" })
);
const MESSAGE_FRAME = makeFrame(
  JSON.stringify({
    type: "chunk",
    content: "Hello world this is a test message",
  })
);
const TOOL_CALL_FRAME = makeFrame(
  JSON.stringify({
    type: "tool_call",
    toolCallId: "tc_456",
    toolName: "get_weather",
    input: {},
  })
);

describe("stripMessageIdTransform", () => {
  bench("transform finish frame (with messageId to strip)", () => {
    for (let i = 0; i < 1000; i++) {
      stripMessageIdTransform(FINISH_FRAME_WITH_ID);
    }
  });

  bench("transform regular message frame (passthrough)", () => {
    for (let i = 0; i < 1000; i++) {
      stripMessageIdTransform(MESSAGE_FRAME);
    }
  });

  bench("transform tool-call frame (passthrough)", () => {
    for (let i = 0; i < 1000; i++) {
      stripMessageIdTransform(TOOL_CALL_FRAME);
    }
  });

  bench("transform mixed frame sequence", () => {
    const frames = [
      MESSAGE_FRAME,
      TOOL_CALL_FRAME,
      FINISH_FRAME_WITH_ID,
      FINISH_FRAME_NO_ID,
    ];
    for (let i = 0; i < 250; i++) {
      for (const frame of frames) {
        stripMessageIdTransform(frame);
      }
    }
  });
});
