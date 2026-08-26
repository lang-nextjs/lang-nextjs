/**
 * TDD tests for langchainAdapter — LangChain native SSE → AI SDK v6 normalizer.
 *
 * Fixture source: packages/server/src/__fixtures__/langchain-native-sse.json
 * The fixture uses _event as discriminant (maps to SSE event: header).
 * Token frames use 'text' field (not 'content').
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { langchainAdapter, createLangchainTransform } from "./langchain";
import type { SseFrame } from "../accumulator";
import fixture from "../__fixtures__/langchain-native-sse.json";

// Helper: build a raw SSE frame string from a fixture frame object
function toRaw(frame: Record<string, unknown>): string {
  const { _event, ...data } = frame;
  if (_event) {
    return `event: ${_event}\ndata: ${JSON.stringify(data)}`;
  }
  return `data: ${JSON.stringify(data)}`;
}

// Helper: apply the first (and only) transform from the adapter.
// Each call gets a fresh transform — adapter is now stateful (tracks open
// text blocks for the AI SDK v6 text-start → text-delta* → text-end ordering).
function applyTransform(raw: string): SseFrame | null {
  const transform = langchainAdapter.transforms[0];
  return transform({ raw });
}

/**
 * Parse the LAST data line from a possibly-compound SSE frame.
 * The transform may now return a single SseFrame whose raw contains multiple
 * data: lines (e.g. text-start + text-delta on first emission). The "main"
 * payload is the trailing line; text-start/text-end are emitted before it.
 *
 * Tests that need to inspect the prefix lines (e.g. text-start) should use
 * `parseAllFrames` instead.
 */
function parseOutput(frame: SseFrame): unknown {
  const dataLines = frame.raw.split("\n").filter((l) => l.startsWith("data: "));
  if (dataLines.length === 0) return null;
  return JSON.parse(dataLines[dataLines.length - 1]!.slice(6));
}

/** Parse every data line in a (possibly compound) raw frame, in emission order. */
function parseAllFrames(frame: SseFrame): unknown[] {
  return frame.raw
    .split("\n\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice(6)));
}

describe("langchainAdapter", () => {
  it('has name "langchain"', () => {
    expect(langchainAdapter.name).toBe("langchain");
  });

  it("has exactly one transform", () => {
    expect(langchainAdapter.transforms).toHaveLength(1);
  });

  describe("token frames → text-delta", () => {
    it("converts first token frame from fixture to text-delta", () => {
      // fixture frame: { _event: "token", type: "token", text: "Hello" }
      const fixtureFrame = fixture.frames[0] as Record<string, unknown>;
      const raw = toRaw(fixtureFrame);
      const result = applyTransform(raw);

      expect(result).not.toBeNull();
      const output = parseOutput(result!);
      expect(output).toEqual({
        type: "text-delta",
        id: "text-1",
        delta: "Hello",
      });
    });

    it("converts second token frame from fixture to text-delta", () => {
      // fixture frame: { _event: "token", type: "token", text: ", how" }
      const fixtureFrame = fixture.frames[1] as Record<string, unknown>;
      const raw = toRaw(fixtureFrame);
      const result = applyTransform(raw);

      expect(result).not.toBeNull();
      const output = parseOutput(result!);
      expect(output).toEqual({
        type: "text-delta",
        id: "text-1",
        delta: ", how",
      });
    });

    it("converts all four token frames from fixture correctly", () => {
      const expectedTexts = ["Hello", ", how", " can I help", " you today?"];
      for (let i = 0; i < 4; i++) {
        const fixtureFrame = fixture.frames[i] as Record<string, unknown>;
        const raw = toRaw(fixtureFrame);
        const result = applyTransform(raw);
        expect(result).not.toBeNull();
        const output = parseOutput(result!);
        expect(output).toEqual({
          type: "text-delta",
          id: "text-1",
          delta: expectedTexts[i],
        });
      }
    });
  });

  describe("tool_call frames → tool-input-available", () => {
    it("converts tool_call frame from fixture to tool-input-available", () => {
      // fixture frame: { _event: "tool_call", type: "tool_call", tool_name: "search", tool_input: { query: "current weather" } }
      const fixtureFrame = fixture.frames[4] as Record<string, unknown>;
      const raw = toRaw(fixtureFrame);
      const transform = langchainAdapter.transforms[0];
      const result = transform({ raw });

      expect(result).not.toBeNull();
      const output = parseOutput(result!);
      expect(output).toEqual({
        type: "tool-input-available",
        toolCallId: "lc-search-0",
        toolName: "search",
        input: { query: "current weather" },
      });
    });
  });

  describe("message frames → finish (content intentionally dropped)", () => {
    it("converts message frame from fixture to finish, drops content", () => {
      // fixture frame: { _event: "message", type: "message", content: [...] }
      // DESIGN INTENT: content is dropped to prevent double-counting accumulated tokens
      const fixtureFrame = fixture.frames[5] as Record<string, unknown>;
      const raw = toRaw(fixtureFrame);
      const result = applyTransform(raw);

      expect(result).not.toBeNull();
      const output = parseOutput(result!);
      expect(output).toEqual({ type: "finish", finishReason: "stop" });
      // Verify content is NOT in the output
      expect((output as Record<string, unknown>).content).toBeUndefined();
    });
  });

  describe("error frames → dropped", () => {
    it("drops error frames (returns null)", () => {
      const raw =
        'event: error\ndata: {"type":"error","message":"Something went wrong"}';
      const result = applyTransform(raw);
      expect(result).toBeNull();
    });
  });

  describe("[DONE] frames → pass through unchanged", () => {
    it("passes [DONE] frame through unchanged", () => {
      const raw = "data: [DONE]";
      const result = applyTransform(raw);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe("data: [DONE]");
    });
  });

  describe("non-JSON frames → pass through unchanged", () => {
    it("passes non-JSON data through unchanged", () => {
      const raw = "data: not-valid-json";
      const result = applyTransform(raw);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe("data: not-valid-json");
    });
  });

  describe("unrecognized event type → pass through unchanged", () => {
    it("passes unrecognized event type through unchanged", () => {
      const raw = 'event: ping\ndata: {"type":"ping"}';
      const result = applyTransform(raw);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe(raw);
    });
  });

  describe("deterministic toolCallId — two tool_call frames from same request", () => {
    it("fresh transform: first tool_call gets id lc-search-0, second gets lc-search-1", () => {
      // Use the exported createLangchainTransform to get a fresh counter per test
      const transform = createLangchainTransform();

      const raw1 =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"search","tool_input":{"query":"cats"}}';
      const raw2 =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"search","tool_input":{"query":"dogs"}}';

      const result1 = transform({ raw: raw1 });
      const result2 = transform({ raw: raw2 });

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      const out1 = parseOutput(result1!);
      const out2 = parseOutput(result2!);

      expect((out1 as Record<string, unknown>).toolCallId).toBe("lc-search-0");
      expect((out2 as Record<string, unknown>).toolCallId).toBe("lc-search-1");
    });
  });

  describe("branch coverage — empty and missing fields", () => {
    it("token frame with empty text returns null (empty text guard)", () => {
      // Covers L72: if (!text) return null
      const result = applyTransform('event: token\ndata: {"text":""}');
      expect(result).toBeNull();
    });

    it('token frame with missing text field returns null (undefined ?? "" is falsy)', () => {
      // Covers L71: (parsed.text as string) ?? '' → ''
      const result = applyTransform("event: token\ndata: {}");
      expect(result).toBeNull();
    });

    it("tool_call frame with missing tool_name falls back to empty string", () => {
      // Covers L88: (parsed.tool_name as string) ?? ''
      const result = applyTransform(
        'event: tool_call\ndata: {"tool_input":{"q":"x"}}'
      );
      expect(result).not.toBeNull();
      expect((parseOutput(result!) as Record<string, unknown>).toolName).toBe(
        ""
      );
    });

    it("tool_call frame with missing tool_input falls back to empty object", () => {
      // Covers L89: (parsed.tool_input as ...) ?? {}
      const result = applyTransform(
        'event: tool_call\ndata: {"tool_name":"search"}'
      );
      expect(result).not.toBeNull();
      expect((parseOutput(result!) as Record<string, unknown>).input).toEqual(
        {}
      );
    });

    it("frame with no event header and no data: prefix passes through unchanged (L57 branch)", () => {
      // Covers L57: if (event === null && !frame.raw.startsWith('data: ')) return frame
      // e.g. an SSE comment line or keepalive
      const raw = ": keepalive";
      const result = applyTransform(raw);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe(raw);
    });

    it('data-only JSON frame with no type field passes through unchanged (L67 ?? "" fallback)', () => {
      // Covers L67: event ?? (parsed.type as string) ?? '' — all three nullish
      // Falls through to default: case → pass through unchanged
      const raw = 'data: {"payload":"stuff"}';
      const result = applyTransform(raw);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe(raw);
    });

    it("createLangchainTransform: non-tool_call transformed frame does not increment counter", () => {
      // Covers L125 FALSE branch: result !== frame but event !== 'tool_call'
      // A data-only token frame transforms to text-delta without incrementing counter
      const transform = createLangchainTransform();
      transform({ raw: 'data: {"type":"token","text":"hi"}' });
      const toolResult = transform({
        raw: 'event: tool_call\ndata: {"tool_name":"search","tool_input":{}}',
      });
      // Counter still at 0 → first tool_call still gets id lc-search-0
      expect(
        (parseOutput(toolResult!) as Record<string, unknown>).toolCallId
      ).toBe("lc-search-0");
    });

    it('tool_call frame with explicit tool_call_id="" (empty string) uses the empty string, NOT the fallback lc-...-N (type coercion: ?? does not replace empty string)', () => {
      // Gap: the implementation uses `(parsed.tool_call_id as string) ?? 'lc-...'`.
      // The nullish coalescing operator only replaces null/undefined — NOT empty string.
      // An empty-string tool_call_id in the frame is a degenerate but valid JSON value
      // and `?? ` will keep it as "" rather than generating a deterministic id.
      // If the caller ever sends `"tool_call_id": ""` the output toolCallId will be ""
      // which breaks downstream dedup (empty string is a falsy key).
      const transform = createLangchainTransform();
      const raw =
        'event: tool_call\ndata: {"tool_name":"search","tool_input":{},"tool_call_id":""}';
      const result = transform({ raw });
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      // The toolCallId must be "" (the empty string from the frame), NOT the fallback.
      // This documents the current behaviour. If the implementation later adds a guard
      // for empty-string tool_call_id (e.g. `|| 'lc-...'`), this test will catch the change.
      expect(output.toolCallId).toBe("");
    });

    it("token frame that also contains run_id field in data is correctly converted to text-delta (run_id ignored)", () => {
      // Adversarial: some LangChain backends include a `run_id` field alongside the
      // token payload (e.g. for tracing). The adapter extracts only `parsed.text` for
      // token events — run_id must be silently ignored, not treated as a type discriminant
      // or cause a pass-through. If the switch falls through to `default` because of the
      // extra field, it returns `frame` unchanged instead of `{ type: 'text-delta', ... }`.
      // The event type is determined by the SSE `event:` header, NOT the data fields,
      // so run_id in data must be completely irrelevant.
      const result = applyTransform(
        'event: token\ndata: {"type":"token","text":"hello","run_id":"run-abc-123"}'
      );
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      expect(output.type).toBe("text-delta");
      expect(output.delta).toBe("hello");
      // run_id must NOT leak into the output frame
      expect(output.run_id).toBeUndefined();
    });

    it("tool_call frame that also contains run_id is correctly converted; run_id does NOT become toolCallId", () => {
      // Adversarial: a tool_call frame with both run_id and tool_call_id in the data.
      // The nullish coalescing `(parsed.tool_call_id as string) ?? \`lc-...\`` means
      // tool_call_id takes precedence over the fallback. run_id must never be used as
      // toolCallId — only tool_call_id (if present) or the lc-{toolName}-{N} fallback.
      const transform = createLangchainTransform();
      const raw =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"search","tool_input":{"q":"test"},"run_id":"run-xyz-999"}';
      const result = transform({ raw });
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      expect(output.type).toBe("tool-input-available");
      // No tool_call_id in data → must fall back to lc-search-0, NOT run-xyz-999
      expect(output.toolCallId).toBe("lc-search-0");
      expect(output.toolCallId).not.toBe("run-xyz-999");
    });

    it("ADVERSARIAL: two tool_call frames with DIFFERENT tool names each get counter index 0 (per-name counter semantics)", () => {
      // The implementation uses a GLOBAL counter (not a per-tool-name Map).
      // A natural API expectation: the first call to "search" gets lc-search-0 and the
      // first call to "calc" gets lc-calc-0 (counter resets per tool name).
      // Actual behaviour: global counter gives lc-search-0 then lc-calc-1 because the
      // counter increments after every tool_call regardless of tool name.
      // This test asserts the per-name-counter semantic (lc-calc-0 for first calc call).
      // It will FAIL because the implementation yields lc-calc-1.
      const transform = createLangchainTransform();

      const rawSearch =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"search","tool_input":{"query":"weather"}}';
      const rawCalc =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"calc","tool_input":{"expr":"1+1"}}';

      const result1 = transform({ raw: rawSearch });
      const result2 = transform({ raw: rawCalc });

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      const out1 = parseOutput(result1!) as Record<string, unknown>;
      const out2 = parseOutput(result2!) as Record<string, unknown>;

      // First search call: lc-search-0
      expect(out1.toolCallId).toBe("lc-search-0");
      // First calc call: per-name counter semantic expects lc-calc-0
      // FAILS: global counter gives lc-calc-1
      expect(out2.toolCallId).toBe("lc-calc-0");
    });

    it("ADVERSARIAL: singleton langchainAdapter counter bleeds across tests — second tool_call via singleton gets lc-search-1 not lc-search-0", () => {
      // The langchainAdapter singleton shares a single createLangchainTransform() closure.
      // The test at line ~85 in this file already calls langchainAdapter.transforms[0]
      // with a tool_call frame (fixture.frames[4]), incrementing the counter from 0 to 1.
      // Any subsequent tool_call sent through the SAME singleton will use counter=1
      // and produce lc-search-1. A caller who assumes each new call to langchainAdapter
      // gets a fresh counter-0 will observe this mismatch.
      // This test calls the singleton again and asserts lc-search-0 (fresh start).
      // It will FAIL because the counter is already >= 1 from the earlier test run.
      const singletonTransform = langchainAdapter.transforms[0];
      const raw =
        'event: tool_call\ndata: {"type":"tool_call","tool_name":"search","tool_input":{"q":"test"}}';
      const result = singletonTransform({ raw });
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      // Asserts counter starts at 0 — will FAIL because singleton counter has already
      // been incremented by prior tests in this file
      expect(output.toolCallId).toBe("lc-search-0");
    });

    it("token frame with whitespace-only text (e.g. single space) is DROPPED (returns null) — hardened guard uses !text.trim()", () => {
      // Gap (now fixed): the guard `if (!text) return null` used JS truthiness, which
      // let a non-empty whitespace string like ' ' slip through as a useless
      // text-delta frame. Hardened to `if (!text.trim()) return null` so space-only,
      // newline-only, and Unicode-whitespace tokens are dropped instead.
      const result = applyTransform('event: token\ndata: {"text":" "}');
      expect(result).toBeNull();
    });

    it("event: token frame with non-JSON data is dropped (returns null) — catch block fixed to apply per-event fallback", () => {
      // Previously the catch block returned `frame` unchanged (the bug). After the fix,
      // a token frame with invalid JSON is correctly dropped (return null) so consumers
      // never receive a raw broken frame they cannot interpret.
      const raw = "event: token\ndata: {broken json here}";
      const result = applyTransform(raw);
      // Fixed behaviour: catch returns null for known event types with bad JSON.
      expect(result).toBeNull();
    });

    it("ADVERSARIAL: event: token with malformed JSON must return null (drop the frame), NOT pass it through", () => {
      // BUG: the catch block at langchain.ts L62-64 returns `frame` for ANY JSON.parse
      // failure, regardless of the SSE `event:` header.  The `event: token` case is
      // handled inside the switch AFTER the try/catch — it never runs when JSON.parse
      // throws.  Correct behaviour: a token frame with unparseable JSON carries no
      // text delta and must be dropped (return null) so consumers never see a raw
      // broken frame they cannot interpret.  The existing "exposes the catch-returns-frame
      // bug" test documents the wrong behaviour by asserting `result !== null`; this test
      // asserts the CORRECT behaviour and will FAIL until the implementation is fixed.
      const raw = "event: token\ndata: {this is definitely broken JSON!!!}";
      const result = applyTransform(raw);
      // The implementation currently returns `frame` (not null) from the catch block.
      // This test EXPECTS null — it will FAIL until the catch block is fixed to check
      // the event type and return null for known event types with invalid payloads.
      expect(result).toBeNull();
    });

    it("ADVERSARIAL: event: error with malformed JSON must return null (drop), NOT pass the raw broken frame through", () => {
      // BUG: same catch-block issue. `event: error` with parseable JSON hits
      // `case 'error': return null` in the switch. But when JSON.parse throws, the
      // catch fires and returns `frame` BEFORE the switch — so the error frame leaks
      // out unchanged instead of being dropped. The existing "drops error frames"
      // test only covers the parseable-JSON path. This test covers the malformed-JSON
      // path and will FAIL because the catch returns `frame` instead of null.
      const raw = "event: error\ndata: {totally-broken not json}";
      const result = applyTransform(raw);
      // Correct: error frames must ALWAYS be dropped, even with invalid JSON bodies.
      // Will FAIL: implementation returns the raw error frame from the catch block.
      expect(result).toBeNull();
    });

    it("ADVERSARIAL: event: message with malformed JSON must emit the finish signal, NOT pass the raw frame through", () => {
      // BUG: same catch-block issue. `event: message` with parseable JSON correctly
      // produces `{ type: 'finish', finishReason: 'stop' }` via the switch.  But when
      // JSON.parse throws the catch fires and returns `frame` unchanged — a raw
      // `event: message\ndata: {bad}` frame reaches the consumer instead of a clean
      // finish signal. This means end-of-stream is never signalled when the message
      // payload is malformed; the AI SDK stream hangs or mis-counts tokens.
      // Will FAIL: the catch block returns `frame` instead of falling through to
      // `case 'message'` which would return the finish signal.
      const raw = "event: message\ndata: not-valid-json-at-all";
      const result = applyTransform(raw);
      // Correct behaviour: the finish signal must still be emitted.
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      expect(output).toEqual({ type: "finish", finishReason: "stop" });
    });

    it("ADVERSARIAL: data-only token frame with malformed JSON falls into the default-event pass-through (NOT drop), preserving the raw frame", () => {
      // The catch block at langchain.ts discriminates by event type:
      //   - event: token / tool_call / error with bad JSON → drop (null)
      //   - event: message with bad JSON → emit finish signal
      //   - unknown event (or data-only, no event: header) with bad JSON → pass through
      //
      // For a DATA-ONLY frame (no event: header), the catch's `event === null`
      // path triggers the pass-through branch. This locks in the post-iter-1
      // contract: a bare `data: {garbage}` token attempt must NOT crash and
      // must NOT be silently swallowed — it reaches the downstream consumer
      // as-is (the consumer is responsible for further filtering). The test
      // also confirms the existing pass-through at L79 (`if (event === null &&
      // !frame.raw.startsWith('data: ')) return frame`) doesn't fire here —
      // the frame DOES start with `data: `, so the catch is what handles it.
      const raw = "data: {this is broken token json}";
      const result = applyTransform(raw);
      // Pass-through: the raw frame is forwarded unchanged. The consumer
      // sees the exact bytes — it will either error on JSON.parse or treat
      // it as a degenerate non-LangChain frame.
      expect(result).not.toBeNull();
      expect(result!.raw).toBe(raw);
    });
  });

  describe("ADVERSARIAL: explicit tool_call_id must not advance implicit counter", () => {
    it("a frame with explicit tool_call_id followed by a frame without — second frame gets lc-search-0, not lc-search-1", () => {
      // BUG: langchain.ts L124 — `toolCallCounters.set(toolName, count + 1)` fires
      // unconditionally regardless of whether parsed.tool_call_id was present.
      // After frame-1 (explicit id), the per-name counter for "search" is 1.
      // Frame-2 (no id) therefore gets lc-search-1 instead of lc-search-0.
      // Fix: only increment when the lc-{name}-{N} fallback is actually emitted.
      const transform = createLangchainTransform();

      const result1 = transform({
        raw: 'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"cats"},"tool_call_id":"explicit-001"}',
      });
      expect(result1).not.toBeNull();
      expect(
        (parseOutput(result1!) as Record<string, unknown>).toolCallId
      ).toBe("explicit-001");

      const result2 = transform({
        raw: 'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"dogs"}}',
      });
      expect(result2).not.toBeNull();
      // FAILS: impl returns "lc-search-1" because frame-1 incremented the counter
      expect(
        (parseOutput(result2!) as Record<string, unknown>).toolCallId
      ).toBe("lc-search-0");
    });

    it("ADVERSARIAL: tool_call_id='' (empty string) must NOT advance implicit counter — !'' is truthy so counter fires incorrectly", () => {
      // BUG: langchain.ts — `if (!explicitId)` where explicitId="" evaluates !""=true
      // → counter advances even though an "explicit" id was provided.
      // After a frame with tool_call_id:"", the next implicit frame gets lc-search-1, not lc-search-0.
      const transform = createLangchainTransform();

      const result1 = transform({
        raw: 'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"cats"},"tool_call_id":""}',
      });
      expect(result1).not.toBeNull();
      // Empty string emitted as-is (existing documented behaviour)
      expect(
        (parseOutput(result1!) as Record<string, unknown>).toolCallId
      ).toBe("");

      const result2 = transform({
        raw: 'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"dogs"}}',
      });
      expect(result2).not.toBeNull();
      // FAILS: impl returns "lc-search-1" because !'' fired and advanced the counter
      expect(
        (parseOutput(result2!) as Record<string, unknown>).toolCallId
      ).toBe("lc-search-0");
    });
  });

  describe("ADVERSARIAL: [DONE] sentinel must only pass through on bare data-only frames", () => {
    it("event: token frame with data: [DONE] must be dropped — [DONE] guard fires before event type is checked", () => {
      // BUG: langchain.ts — `if (data === "[DONE]") return frame;` fires unconditionally
      // before any event-type logic. When backend sends `event: token\ndata: [DONE]`,
      // the guard returns the raw frame unchanged. The AI SDK receives `event: token`
      // with data "[DONE]", attempts JSON.parse("[DONE]"), throws, and the stream errors.
      // Fix: restrict [DONE] pass-through to bare data-only frames (event === null).
      const transform = createLangchainTransform();
      const result = transform({ raw: "event: token\ndata: [DONE]" });
      // FAILS: impl returns the original frame instead of null
      expect(result).toBeNull();
    });

    it("bare data: [DONE] (no event header) still passes through unchanged", () => {
      // This is the correct [DONE] case — bare data frame, no event header.
      // Must not be broken by the fix to the above bug.
      const transform = createLangchainTransform();
      const frame = { raw: "data: [DONE]" };
      const result = transform(frame);
      expect(result).toEqual(frame);
    });
  });

  describe("getter isolation tests", () => {
    it("two independent transforms from consecutive getter accesses maintain isolated counters", () => {
      // Get two transforms from consecutive getter accesses
      const t1 = langchainAdapter.transforms[0];
      const t2 = langchainAdapter.transforms[0];

      // Feed a tool_call frame to t1 -- assert lc-search-0
      const raw1 =
        'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"test"}}';
      const result1 = t1({ raw: raw1 });
      expect(result1).not.toBeNull();
      const output1 = parseOutput(result1!) as Record<string, unknown>;
      expect(output1.toolCallId).toBe("lc-search-0");

      // Feed a tool_call frame to t1 again -- assert lc-search-1
      const result2 = t1({ raw: raw1 });
      expect(result2).not.toBeNull();
      const output2 = parseOutput(result2!) as Record<string, unknown>;
      expect(output2.toolCallId).toBe("lc-search-1");

      // Feed a tool_call frame to t2 -- assert lc-search-0 (NOT lc-search-2)
      const result3 = t2({ raw: raw1 });
      expect(result3).not.toBeNull();
      const output3 = parseOutput(result3!) as Record<string, unknown>;
      expect(output3.toolCallId).toBe("lc-search-0");
    });
  });

  describe("ADVERSARIAL: whitespace-only token content must be dropped, not emitted", () => {
    // INVARIANT LOCK (mirror of openSwe fix): the token-frame guard at L109
    //   `if (!text) return null;` (after `const text = (parsed.text as string) ?? ""`)
    // uses JS truthiness, which lets whitespace-only strings (" ", "\n", "\t",
    // " " non-breaking space) through. A whitespace text-delta is functionally
    // empty — the AI SDK surfaces a visible blank delta and triggers spurious
    // chunk notifications. The hardened fix (used in openSwe.ts) is `!text.trim()`.
    // This test asserts the desired hardened behaviour; the existing
    // `token frame with whitespace-only text` test at L379-390 documents the
    // CURRENT bug by asserting the wrong behaviour is preserved — this new test
    // pins the desired behaviour and will FAIL until the guard is hardened.
    it("ADVERSARIAL: event: token with text=' ' (single ASCII space) must return null (drop), NOT emit text-delta with delta=' '", () => {
      const result = applyTransform('event: token\ndata: {"text":" "}');
      expect(result).toBeNull();
    });

    it("ADVERSARIAL: event: token with text='\\u00A0' (non-breaking space) must return null (drop), NOT emit text-delta with a Unicode-whitespace delta", () => {
      // JS regex \s considers U+00A0 whitespace, but the truthiness guard
      // accepts it. Hardened behaviour drops it.
      const result = applyTransform('event: token\ndata: {"text":"\\u00a0"}');
      expect(result).toBeNull();
    });

    // INVARIANT LOCK (oversized input): a real backend can emit a token
    // whose text payload is hundreds of KB or even MB (e.g. a model that
    // batches large chunks into a single event). The transform contract:
    // round-trip the text faithfully with NO truncation, NO chunking, and
    // NO throw (e.g. from string concat or V8 limits). The AI SDK on the
    // consumer side has its own streaming chunking — the adapter's job is
    // pass-through fidelity.
    it("ADVERSARIAL: event: token with a 1MB text payload must round-trip the entire content without truncation", () => {
      const transform = createLangchainTransform();
      // 1MB of repeated "x" characters. JSON.stringify can encode this in a
      // single line; V8 strings can hold well beyond 512MB. The transform
      // must emit a text-delta whose delta equals the full 1MB string.
      const big = "x".repeat(1_000_000);
      const raw =
        "event: token\ndata: " + JSON.stringify({ type: "token", text: big });
      const result = transform({ raw });
      expect(result).not.toBeNull();
      const output = parseOutput(result!) as Record<string, unknown>;
      expect(output.type).toBe("text-delta");
      expect(typeof output.delta).toBe("string");
      expect((output.delta as string).length).toBe(1_000_000);
      expect(output.delta as string).toBe(big);
    });
  });
});

import type { SseAdapter } from "../adapter-contract";
import { createSseProxyHandler } from "../handler";
import { NextRequest } from "next/server";
import {
  countToolCalls,
  resultsAfterFinish,
  unpairedToolCalls,
} from "../__testing__/tool-pairing";
import { drainThroughAdapter } from "../__testing__/tool-pairing";

// --- rung contract conformance (moved from public-api.test.ts) -----------------------------
// A rung's "I implement SseAdapter" assertion belongs with the rung, not in a core surface test:
// a type assertion over an ejected export is a hard type error the fork cannot compile past.
describe("langchain rung — adapter contract", () => {
  it("langchainAdapter implements SseAdapter", () => {
    expectTypeOf(langchainAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(createLangchainTransform).toBeFunction();
  });
});

/* ------------------------------------------------------------------------- *
 * TOOL PAIRING — every announced tool call must be resolved before `finish`.
 *
 * The invariant lives in ../tool-pairing.ts and is tested there. This asserts
 * it for THIS rung's wire format, in this rung's file, so an eject takes the
 * check with the adapter it judges.
 *
 * WHY NOT A CAPTURED-FIXTURE TEST. You cannot capture a frame the backend does
 * not emit. A capture of a stream that never sends tool results contains
 * exactly that, and every assertion written from it passes forever while the UI
 * sits on "pending". Captured fixtures catch MISINTERPRETATION; this is MISSING
 * EMISSION, and the two need opposite instruments — which is why this names a
 * property of the whole output and can therefore fail on an absence.
 * ------------------------------------------------------------------------- */
describe("langchain — tool calls are resolved before the stream ends", () => {
  const enc__tp = new TextEncoder();
  const run__tp = async (frames: string[]): Promise<string> => {
    vi.stubGlobal("fetch", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc__tp.encode(frames.join("\n\n") + "\n\n"));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const res = await createSseProxyHandler({
      backendUrl: "http://b",
      adapter: langchainAdapter,
    })(
      new NextRequest("http://localhost/api/chat/stream", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        headers: { "content-type": "application/json" },
      })
    );
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  };

  afterEach(() => vi.unstubAllGlobals());

  const WITH_TOOL = [
    `event: token\ndata: {"text": "Let me check."}`,
    `event: tool_call\ndata: {"tool_name": "increment", "tool_input": {}, "tool_call_id": "tc-1"}`,
    `event: token\ndata: {"text": "The counter is 5."}`,
    `event: message\ndata: {"content": ""}`,
  ];

  it("the fixture actually contains a tool call — emptiness would be vacuous", async () => {
    // Asserted separately and first. "No unpaired calls" is trivially true of a
    // stream that never called a tool, so the next case is meaningless without
    // this one.
    const out = await run__tp(WITH_TOOL);
    expect(countToolCalls(out)).toBeGreaterThan(0);
  });

  it.fails("every announced tool call receives a result", async () => {
    const out = await run__tp(WITH_TOOL);
    const unpaired = unpairedToolCalls(out);
    expect(
      unpaired,
      `announced but never resolved: ${JSON.stringify(unpaired)} — every one of ` +
        "these is a tool card that sits on pending forever while the model has " +
        "already used the result"
    ).toEqual([]);
  });

  it("no result arrives after the terminal frame", async () => {
    // A different defect with a different fix: the pairing exists, but the
    // client has stopped listening.
    expect(resultsAfterFinish(await run__tp(WITH_TOOL))).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * TERMINAL DETECTION ON THIS RUNG'S WIRE FORMAT
 *
 * "Every time I try to use the chat, I have this error: upstream backend
 * disconnected mid-stream" — on streams that produced text and ended normally.
 * The client received a contradiction: a `finish` frame followed by a report
 * that the connection had dropped.
 *
 * Here rather than beside the handler because the wire format is this rung's,
 * not the transport's — severability.test.ts fails a shared test that imports
 * this adapter, and rightly: ejecting the rung would strand it.
 *
 * THE PAIR IS THE POINT, AND IT IS NOT SYMMETRIC. The truncated half PASSED
 * against the buggy build — a stream with no terminal frame really was reported
 * as truncated. Only the clean half failed. Shipping the truncation case alone
 * would have read as coverage and proved nothing.
 * ------------------------------------------------------------------------- */
describe("terminal detection — langchain's wire format", () => {
  const CLEAN__td = [
    `event: token\ndata: {"text": "Hello"}`,
    `event: token\ndata: {"text": " world"}`,
    `event: message\ndata: {"content": ""}`,
  ];
  const TRUNCATED__td = [
    `event: token\ndata: {"text": "Hello"}`,
    `event: token\ndata: {"text": " wor"}`,
  ];
  const run = (frames: string[]) =>
    drainThroughAdapter(frames, langchainAdapter, {
      createSseProxyHandler: createSseProxyHandler as never,
      makeRequest: () =>
        new NextRequest("http://localhost/api/chat/stream", {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
          headers: { "content-type": "application/json" },
        }),
      stubFetch: (fn) => vi.stubGlobal("fetch", fn),
    });

  afterEach(() => vi.unstubAllGlobals());

  it("a CLEAN stream reports no disconnect", async () => {
    expect(await run(CLEAN__td)).not.toContain("upstream_disconnect");
  });

  it("a clean stream still produces its finish frame", async () => {
    // Guards the degenerate fix: emitting nothing satisfies the case above.
    expect(await run(CLEAN__td)).toContain('"type":"finish"');
  });

  it("a TRUNCATED stream still reports the disconnect", async () => {
    expect(await run(TRUNCATED__td)).toContain("upstream_disconnect");
  });

  it("a truncated stream does NOT claim to have finished", async () => {
    // What makes the truncated half non-vacuous: it proves the error fired
    // BECAUSE no terminal was seen, not merely that the word appeared.
    expect(await run(TRUNCATED__td)).not.toContain('"type":"finish"');
  });
});
