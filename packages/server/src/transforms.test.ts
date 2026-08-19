import { describe, it, expect } from "vitest";
import { defaultTransforms } from "./transforms";
import type { SseFrame, SseTransform } from "./accumulator";

function applyPipeline(
  transforms: SseTransform[],
  frame: SseFrame
): SseFrame | null {
  let current: SseFrame | null = frame;
  for (const t of transforms) {
    if (current === null) return null;
    current = t(current);
  }
  return current;
}

describe("defaultTransforms", () => {
  it("strips messageId from finish SSE frames", () => {
    const frame: SseFrame = {
      raw: 'data: {"type":"finish","messageId":"abc","finishReason":"stop"}',
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe('data: {"type":"finish","finishReason":"stop"}');
    expect(result!.raw).not.toContain("messageId");
  });

  it("passes through non-finish frames unmodified", () => {
    const frame: SseFrame = { raw: 'data: {"type":"text","text":"hello"}' };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).toEqual(frame);
  });

  it("passes through [DONE] lines unmodified", () => {
    const frame: SseFrame = { raw: "data: [DONE]" };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).toEqual(frame);
  });

  it("passes through non-JSON data lines unmodified", () => {
    const frame: SseFrame = { raw: "data: not valid json {" };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).toEqual(frame);
  });

  it("null return from transform drops the frame", () => {
    const dropTransform: SseTransform = () => null;
    const frame: SseFrame = { raw: "data: anything" };
    const result = applyPipeline([dropTransform], frame);
    expect(result).toBeNull();
  });

  it("strips messageId when its value is null (key present, value null)", () => {
    // Type-coercion gap: the guard is `"messageId" in parsed` (key presence check),
    // NOT `parsed.messageId != null` (value truthiness). A null-valued messageId key
    // still satisfies `in`, so it should be destructured and dropped. This matters
    // because some backend serializers emit `"messageId": null` instead of omitting
    // the key entirely — AI SDK v6 strictObject() rejects any unexpected key.
    const frame: SseFrame = {
      raw: 'data: {"type":"finish","messageId":null,"finishReason":"stop"}',
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).not.toContain("messageId");
    expect(result!.raw).toContain('"type":"finish"');
    expect(result!.raw).toContain('"finishReason":"stop"');
  });

  it("user transforms are appended after defaultTransforms", () => {
    const seen: string[] = [];
    const spy: SseTransform = (f) => {
      seen.push("user");
      return f;
    };
    const combined = [...defaultTransforms, spy];
    const frame: SseFrame = { raw: 'data: {"type":"text","text":"x"}' };
    applyPipeline(combined, frame);
    expect(seen).toEqual(["user"]);
  });

  // ===== Adversarial edge-case tests =====

  it("strips messageId from EACH finish line when a frame has multiple data: lines", () => {
    // SSE technically allows multiple data: lines in one frame (the client concatenates
    // them). Even though the protocol concatenates, the transform processes lines
    // independently. A frame containing two independent finish JSON lines must have
    // messageId stripped from BOTH — otherwise AI SDK v6 strictObject() rejects.
    const frame: SseFrame = {
      raw:
        'data: {"type":"finish","messageId":"a","finishReason":"stop"}\n' +
        'data: {"type":"finish","messageId":"b","finishReason":"length"}',
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    // Both messageIds must be stripped
    expect(result!.raw).not.toContain("messageId");
    expect(result!.raw).not.toContain('"a"');
    expect(result!.raw).not.toContain('"b"');
    expect(result!.raw).toContain('"finishReason":"stop"');
    expect(result!.raw).toContain('"finishReason":"length"');
  });

  it("preserves event: prefix line and strips messageId from following data: line", () => {
    // Realistic SSE frame: an event: line followed by a data: line carrying the
    // finish JSON. The transform must preserve event: line verbatim AND strip
    // messageId from the data line. A buggy impl that bails on the first
    // non-data line would never reach the data line.
    const frame: SseFrame = {
      raw:
        "event: finish\n" +
        'data: {"type":"finish","messageId":"x","finishReason":"stop"}',
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).toContain("event: finish");
    expect(result!.raw).not.toContain("messageId");
    expect(result!.raw).toContain('"finishReason":"stop"');
  });

  it("handles empty frame.raw without throwing or producing phantom output", () => {
    // The accumulator can produce {raw: ""} for SSE keepalive (\n\n boundary-only chunk).
    // The transform pipeline must NOT crash on it, and must return {raw: ""} unchanged —
    // a buggy impl that does `parsed.type` on an empty-string parse would throw.
    const frame: SseFrame = { raw: "" };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe("");
  });

  it("strips messageId when SSE data line uses no-space form (data:{...})", () => {
    // SSE spec (whatwg) makes the single space after `data:` OPTIONAL.
    // Some upstream sources or proxies (e.g. nginx with proxy_buffer
    // normalisation, or a non-Django backend) may emit `data:{...}` with
    // no space. As of the SSE-spec compliance fix, the transform now
    // recognises BOTH `data: {...}` and `data:{...}` forms.
    const frame: SseFrame = {
      raw: 'data:{"type":"finish","messageId":"x","finishReason":"stop"}',
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).not.toContain("messageId");
    // Output is re-emitted in the canonical space-after-colon form so
    // network panels and consumers see consistent framing.
    expect(result!.raw).toBe('data: {"type":"finish","finishReason":"stop"}');
  });

  it("preserves CRLF line endings on rewritten finish data lines (round-trip same form)", () => {
    // A backend or proxy that emits SSE with CRLF line endings (\r\n)
    // is now round-tripped: the transform detects CRLF in the input
    // and rejoins lines with CRLF. Previously the rewritten data line
    // lost its trailing \r, silently mutating the line endings — a
    // surprise for downstream consumers. The detected-end fix makes
    // the transform line-ending-preserving.
    const frame: SseFrame = {
      raw:
        'data: {"type":"finish","messageId":"x","finishReason":"stop"}\r\n' +
        "event: nextEvent",
    };
    const result = applyPipeline(defaultTransforms, frame);
    expect(result).not.toBeNull();
    expect(result!.raw).not.toContain("messageId");
    // CRLF preserved between lines.
    expect(result!.raw).toBe(
      'data: {"type":"finish","finishReason":"stop"}\r\nevent: nextEvent'
    );
  });
});
