import { describe, it, expect, expectTypeOf } from "vitest";
import { deepagentsAdapter } from "./deepagents";
import { stripMessageIdTransform } from "../transforms";

/**
 * Helper: apply an array of transforms to a raw SSE frame string.
 * Returns the final transformed raw string, or null if a transform drops the frame.
 */
function applyAll(
  transforms: typeof deepagentsAdapter.transforms,
  raw: string
): string | null {
  let current: { raw: string } | null = { raw };
  for (const t of transforms) {
    if (current === null) return null;
    current = t(current);
  }
  return current?.raw ?? null;
}

describe("deepagentsAdapter", () => {
  it('name is "deepagents" (name collision guard)', () => {
    expect(deepagentsAdapter.name).toBe("deepagents");
  });

  it("transforms array has exactly 1 transform (stripMessageIdTransform)", () => {
    expect(deepagentsAdapter.transforms).toHaveLength(1);
    expect(deepagentsAdapter.transforms[0]).toBe(stripMessageIdTransform);
  });

  it("strips messageId from a finish frame that has messageId", () => {
    const raw =
      'data: {"type":"finish","messageId":"abc-123","finishReason":"stop"}';
    const result = applyAll(deepagentsAdapter.transforms, raw);
    expect(result).not.toContain("messageId");
    expect(result).toContain('"type":"finish"');
    expect(result).toContain('"finishReason":"stop"');
  });

  it("passes through a finish frame without messageId unchanged", () => {
    const raw = 'data: {"type":"finish","finishReason":"stop"}';
    const result = applyAll(deepagentsAdapter.transforms, raw);
    expect(result).toBe(raw);
  });

  it("passes through a non-finish frame (text-delta) unchanged", () => {
    const raw = 'data: {"type":"text-delta","textDelta":"hello"}';
    const result = applyAll(deepagentsAdapter.transforms, raw);
    expect(result).toBe(raw);
  });

  it("passes through a data: [DONE] frame unchanged", () => {
    const raw = "data: [DONE]";
    const result = applyAll(deepagentsAdapter.transforms, raw);
    expect(result).toBe(raw);
  });

  it("passes through a frame with invalid JSON unchanged", () => {
    const raw = "data: {not-valid-json}";
    const result = applyAll(deepagentsAdapter.transforms, raw);
    expect(result).toBe(raw);
  });

  it("ADVERSARIAL: in a multi-line SSE frame, ONLY the finish data line has messageId stripped — adjacent lines pass through untouched", () => {
    // Real backends can emit a frame that contains MULTIPLE data lines (the
    // SSE spec allows this — the client joins them with "\n"). stripMessageIdTransform
    // walks every line; it must strip messageId from finish-type lines and
    // leave the others untouched. A buggy per-character implementation would
    // either over-strip (touch non-finish lines) or under-strip (miss a
    // finish line in a multi-line frame).
    const raw =
      'data: {"type":"text-delta","delta":"hi"}\n' +
      'data: {"type":"finish","messageId":"msg-123","finishReason":"stop"}\n' +
      'data: {"type":"finish","messageId":"msg-456","finishReason":"stop"}';
    const result = applyAll(deepagentsAdapter.transforms, raw)!;
    // text-delta line must be unchanged
    expect(result).toContain('data: {"type":"text-delta","delta":"hi"}');
    // Neither finish line may carry messageId anymore
    expect(result).not.toContain("messageId");
    // Both finish lines must survive (count >= 2 finish lines)
    const finishMatches = result.match(/"type":"finish"/g) ?? [];
    expect(finishMatches.length).toBe(2);
    // The strip emits canonical "data: " form
    expect(result).not.toContain('data:{"type":"finish"');
  });

  it('ADVERSARIAL: finish frame with a non-string messageId (number, object, null) still strips the key — `"messageId" in parsed` must fire regardless of value type', () => {
    // The strip checks `"messageId" in parsed` — that's a key-presence test,
    // not a value-type test. If a backend ever sends messageId as a number
    // (timestamp), null, or even an object, the key is still present and the
    // destructure-and-rebuild must drop it. AI SDK v6's strictObject() rejects
    // ANY extra key regardless of value type, so the strip must catch all of
    // these shapes — not just string messageIds.
    const cases = [
      { messageId: 1234567890, label: "number" },
      { messageId: null, label: "null" },
      { messageId: { nested: "obj" }, label: "object" },
    ];
    for (const { messageId, label } of cases) {
      const raw = `data: ${JSON.stringify({
        type: "finish",
        messageId,
        finishReason: "stop",
      })}`;
      const result = applyAll(deepagentsAdapter.transforms, raw)!;
      expect(result, label).not.toContain("messageId");
      // The finish frame must still be present
      expect(result, label).toContain('"type":"finish"');
      expect(result, label).toContain('"finishReason":"stop"');
    }
  });
});

import type { SseAdapter } from "../adapter-contract";

// --- rung contract conformance (moved from public-api.test.ts) -----------------------------
describe("deepagents rung — adapter contract", () => {
  it("deepagentsAdapter implements SseAdapter", () => {
    expectTypeOf(deepagentsAdapter).toMatchTypeOf<SseAdapter>();
  });
});
