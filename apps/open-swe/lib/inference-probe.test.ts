import { describe, expect, it } from "vitest";
import {
  INFERENCE_TTL_MS,
  isFresh,
  readInferenceStream,
} from "./inference-probe";

/**
 * THE BUTTON SAID IT COST A CALL, AND IT COST NOTHING.
 *
 * "Verify inference (costs a call)" fetched the backend's `/health`, which
 * reports {"configured": true, "provider": "nvidia"} — whether a KEY IS
 * PRESENT — and rendered that as `responding`, the state used for genuinely
 * observed dependencies. It could not fail for the reason it named.
 *
 * That gap is not theoretical. NVIDIA retired a model mid-session; every
 * stream returned 410 while the key stayed perfectly configured. The panel
 * would have reported the model healthy throughout.
 *
 * So these tests are all about one distinction: a stream that PROVES the model
 * spoke, versus every well-formed stream that does not.
 */

const sse = (...frames: string[]) =>
  frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n";

describe("what counts as the model having answered", () => {
  it("text deltas are proof", () => {
    expect(
      readInferenceStream(
        sse(
          '{"type":"text-start","id":"t1"}',
          '{"type":"text-delta","id":"t1","delta":"ok"}',
          '{"type":"finish","finishReason":"stop"}'
        )
      )
    ).toMatchObject({ answered: true, sample: "ok" });
  });

  it("deltas are joined, so a token-by-token answer is read whole", () => {
    const v = readInferenceStream(
      sse(
        '{"type":"text-delta","delta":"he"}',
        '{"type":"text-delta","delta":"llo"}',
        '{"type":"finish"}'
      )
    );
    expect(v.answered).toBe(true);
    expect(v.sample).toBe("hello");
  });

  it("A WELL-FORMED STREAM WITH NO TEXT IS NOT PROOF", () => {
    // The heart of it. A `finish` with no deltas is what a filtered or dead
    // model produces, and accepting it would rebuild the original bug one
    // level up: a check that passes on the absence of what it looks for.
    const v = readInferenceStream(
      sse('{"type":"finish","finishReason":"stop"}')
    );
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("without the model producing any text");
  });

  it("whitespace-only output is not an answer", () => {
    // A model that emits a newline has technically streamed a delta. It has
    // not demonstrated it can answer.
    expect(
      readInferenceStream(
        sse('{"type":"text-delta","delta":"  \\n "}', '{"type":"finish"}')
      ).answered
    ).toBe(false);
  });

  it("an empty stream is not an answer", () => {
    expect(readInferenceStream("").answered).toBe(false);
  });

  it("a truncated stream is reported as truncated, not as finished", () => {
    // Distinguishable from the finish-with-no-text case, because they have
    // different causes and different fixes.
    const v = readInferenceStream(sse('{"type":"text-start","id":"t1"}'));
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("ended before");
  });
});

describe("errors are surfaced, not flattened into silence", () => {
  it("an error frame carries the server's own sentence", () => {
    const v = readInferenceStream(
      sse('{"type":"error","errorText":"410 model has been retired"}')
    );
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("410");
    expect(v.reason).toContain("retired");
  });

  it("reports what a REAL data-error frame said, not a generic stand-in", () => {
    /*
     * Captured from the running backend: the message is nested under `data`.
     * Reading the flat `message` alone matched nothing here and produced "the
     * stream reported an error" — technically true, and useless, when the
     * backend had already said the provider was overloaded.
     */
    const result = readInferenceStream(
      sse(
        '{"type": "data-error", "data": {"code": "backend_error", "message": "Service temporarily overloaded", "origin": "provider"}}'
      )
    );
    expect(result.answered).toBe(false);
    expect(result.reason).toBe("Service temporarily overloaded");
  });

  it("a data-error frame is treated the same way", () => {
    const v = readInferenceStream(
      sse('{"type":"data-error","message":"upstream refused the key"}')
    );
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("upstream refused");
  });

  it("AN ERROR WINS OVER TEXT ALREADY EMITTED", () => {
    // A stream that produced two tokens and then died has not proved the model
    // works — it has proved it half-works, which is a failure for this check.
    const v = readInferenceStream(
      sse(
        '{"type":"text-delta","delta":"ok"}',
        '{"type":"error","errorText":"connection reset"}'
      )
    );
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("connection reset");
  });

  it("an error with no message still says something", () => {
    const v = readInferenceStream(sse('{"type":"error"}'));
    expect(v.answered).toBe(false);
    expect((v.reason ?? "").length).toBeGreaterThan(5);
  });
});

describe("the wire formats this has to survive", () => {
  it("[DONE] sentinels and blank lines are ignored", () => {
    const raw = 'data: {"type":"text-delta","delta":"ok"}\n\ndata: [DONE]\n\n';
    expect(readInferenceStream(raw).answered).toBe(true);
  });

  it("an unparseable frame is not evidence either way", () => {
    // It must not count as an answer, and must not be mistaken for an error.
    const v = readInferenceStream(
      'data: {this is not json\n\ndata: {"type":"finish"}\n\n'
    );
    expect(v.answered).toBe(false);
    expect(v.reason).toContain("without the model producing any text");
  });

  it("CRLF line endings are handled", () => {
    const raw =
      'data: {"type":"text-delta","delta":"ok"}\r\n\r\ndata: {"type":"finish"}\r\n\r\n';
    expect(readInferenceStream(raw).answered).toBe(true);
  });

  it("a long answer is clipped for the panel", () => {
    const v = readInferenceStream(
      sse(
        `{"type":"text-delta","delta":"${"x".repeat(500)}"}`,
        '{"type":"finish"}'
      )
    );
    expect(v.answered).toBe(true);
    expect((v.sample ?? "").length).toBeLessThan(70);
  });
});

describe("how long a verdict is worth believing", () => {
  const t = 1_800_000_000_000;

  it("a fresh verdict is reused, so a refresh does not spend a call", () => {
    expect(isFresh(t, t + 1000)).toBe(true);
  });

  it("an expired verdict is not", () => {
    expect(isFresh(t, t + INFERENCE_TTL_MS + 1)).toBe(false);
  });

  it("no previous verdict is never fresh", () => {
    expect(isFresh(undefined, t)).toBe(false);
  });

  it("A BACKWARDS CLOCK DOES NOT MAKE A STALE VERDICT IMMORTAL", () => {
    // NTP correction, or a laptop resuming. With a naive `now - at < ttl` the
    // difference goes negative and every stale entry reads as fresh forever —
    // which is precisely a dead model reported as healthy indefinitely.
    expect(isFresh(t, t - INFERENCE_TTL_MS - 1)).toBe(false);
  });

  it("the boundary is exclusive, so a verdict expires rather than lingering", () => {
    expect(isFresh(t, t + INFERENCE_TTL_MS)).toBe(false);
  });
});
