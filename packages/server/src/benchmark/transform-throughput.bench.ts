/**
 * Benchmark: stream transform throughput via SseFrameAccumulator.push()
 *
 * Measures how fast SseFrameAccumulator processes complete frames,
 * partial frames (TCP split), and multiple frames per push.
 */
import { bench, describe } from "vitest";
import { SseFrameAccumulator } from "../accumulator";

const COMPLETE_FRAME =
  'data: {"type":"chunk","content":"' + "x".repeat(1024) + '"}\n\n';
const PARTIAL_FRAME_1 = 'data: {"type":"chunk","content":"' + "x".repeat(512);
const PARTIAL_FRAME_2 = '"}\n\n';
const MULTI_FRAME =
  'data: {"type":"chunk","content":"a"}\n\ndata: {"type":"chunk","content":"b"}\n\n';

describe("SseFrameAccumulator.push()", () => {
  bench("push with complete frames", () => {
    const acc = new SseFrameAccumulator();
    for (let i = 0; i < 1000; i++) {
      acc.push(COMPLETE_FRAME);
    }
  });

  bench("push with partial frames (TCP split)", () => {
    const acc = new SseFrameAccumulator();
    for (let i = 0; i < 1000; i++) {
      acc.push(PARTIAL_FRAME_1);
      acc.push(PARTIAL_FRAME_2);
    }
  });

  bench("push with multiple complete frames", () => {
    const acc = new SseFrameAccumulator();
    for (let i = 0; i < 250; i++) {
      acc.push(MULTI_FRAME);
    }
  });

  bench("flush after complete frames", () => {
    const acc = new SseFrameAccumulator();
    for (let i = 0; i < 1000; i++) {
      acc.push(COMPLETE_FRAME);
    }
    acc.flush();
  });
});
