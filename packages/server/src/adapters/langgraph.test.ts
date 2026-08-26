/**
 * TDD tests for langGraphAdapter.
 *
 * Fixture ground truth: packages/server/src/__fixtures__/langgraph-astream-events-v2.json
 * Event types covered: on_chain_start, on_chain_end, on_chain_stream,
 *   on_chat_model_start, on_chat_model_end, on_chat_model_stream,
 *   on_tool_start, on_tool_end
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import fixture from "../__fixtures__/langgraph-astream-events-v2.json";
import { langGraphAdapter } from "./langgraph";

// Helper: build a raw SSE data frame from a fixture frame object
function toSseFrame(obj: unknown): { raw: string } {
  return { raw: `data: ${JSON.stringify(obj)}` };
}

/**
 * Each call returns a fresh transform with isolated state.
 * The langgraph adapter is now stateful (tracks open text blocks), so tests
 * must use a fresh transform to avoid cross-test state leak.
 */
function freshTransform() {
  return langGraphAdapter.transforms[0]!;
}

/**
 * Parse a possibly-compound SSE frame. The transform may now return a single
 * SseFrame whose raw contains multiple data: lines separated by \n\n (used to
 * emit text-start + text-delta atomically, or text-end + tool frame, etc.).
 * Returns the array of parsed JSON objects in emission order.
 */
function parseFrames(raw: string): unknown[] {
  return raw
    .split("\n\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice(6)));
}

describe("langGraphAdapter", () => {
  it('has name "langgraph"', () => {
    expect(langGraphAdapter.name).toBe("langgraph");
  });

  it("has at least one transform", () => {
    expect(langGraphAdapter.transforms.length).toBeGreaterThan(0);
  });
});

describe("langGraphAdapter transform — on_chat_model_stream with text content", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("first on_chat_model_stream emits text-start + text-delta as a compound frame", () => {
    // First text emission must be preceded by text-start (AI SDK v6 ordering rule).
    // The transform packs both into a single compound SseFrame separated by \n\n.
    const streamFrame = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === "Hello"
    );
    expect(streamFrame).toBeDefined();
    const result = transform(toSseFrame(streamFrame));
    expect(result).not.toBeNull();
    const frames = parseFrames(result!.raw);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: "text-start", id: "text-1" });
    expect(frames[1]).toMatchObject({
      type: "text-delta",
      id: "text-1",
      delta: "Hello",
    });
  });

  it("subsequent on_chat_model_stream emits only text-delta (no repeat text-start)", () => {
    // Within a single transform's lifetime, only the first delta opens the block.
    // Use one transform instance for two consecutive deltas.
    const t = freshTransform();
    const first = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === "Hello"
    );
    const second = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === " can I help"
    );
    t(toSseFrame(first)); // opens the block (compound result discarded)
    const result = t(toSseFrame(second));
    expect(result).not.toBeNull();
    const frames = parseFrames(result!.raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "text-delta",
      id: "text-1",
      delta: " can I help",
    });
  });

  it("text-delta output contains exactly type, id, and delta (AI SDK v6 strictObject)", () => {
    const streamFrame = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === "Hello"
    );
    const result = transform(toSseFrame(streamFrame!));
    const frames = parseFrames(result!.raw);
    const delta = frames[1] as Record<string, unknown>;
    expect(Object.keys(delta).sort()).toEqual(["delta", "id", "type"]);
    expect(delta.type).toBe("text-delta");
    expect(typeof delta.id).toBe("string");
    expect((delta.id as string).length).toBeGreaterThan(0);
  });

  it("drops on_chat_model_stream with empty content (finish signal frame)", () => {
    // From fixture: last on_chat_model_stream has empty content "" (finish_reason: stop)
    const emptyFrame = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === ""
    );
    expect(emptyFrame).toBeDefined();
    const result = transform(toSseFrame(emptyFrame!));
    expect(result).toBeNull();
  });
});

describe("langGraphAdapter transform — drop events", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("drops on_chain_start", () => {
    const frame = fixture.frames.find((f) => f.event === "on_chain_start");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame!));
    expect(result).toBeNull();
  });

  it("drops on_chain_end", () => {
    const frame = fixture.frames.find((f) => f.event === "on_chain_end");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame!));
    expect(result).toBeNull();
  });

  it("drops on_chain_stream", () => {
    const frame = fixture.frames.find((f) => f.event === "on_chain_stream");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame!));
    expect(result).toBeNull();
  });

  it("drops on_chat_model_start", () => {
    const frame = fixture.frames.find((f) => f.event === "on_chat_model_start");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame!));
    expect(result).toBeNull();
  });

  it("drops on_chat_model_end", () => {
    const frame = fixture.frames.find((f) => f.event === "on_chat_model_end");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame!));
    expect(result).toBeNull();
  });
});

describe("langGraphAdapter transform — pass-through cases", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("translates [DONE] terminator to AI SDK v6 finish frame (no open text block)", () => {
    // The langgraph wire format ends with `data: [DONE]` (OpenAI-style sentinel).
    // AI SDK v6 needs a structured `{type:"finish",...}` frame to transition the
    // React hook status from "streaming" → "idle"; otherwise the UI hangs on
    // the streaming caret until TCP close. Translation is the adapter's job.
    const result = transform({ raw: "data: [DONE]" });
    expect(result).not.toBeNull();
    const frames = parseFrames(result!.raw);
    expect(frames).toEqual([{ type: "finish", finishReason: "stop" }]);
  });

  it("[DONE] after text emits text-end before finish (close-then-finish)", () => {
    // If a text block is open when [DONE] arrives, the adapter must close it
    // before signalling finish — AI SDK v6 ordering requires text-end.
    const t = freshTransform();
    const streamFrame = fixture.frames.find(
      (f) =>
        f.event === "on_chat_model_stream" &&
        (f.data as Record<string, unknown> & { chunk?: { content?: string } })
          .chunk?.content === "Hello"
    );
    t(toSseFrame(streamFrame));
    const result = t({ raw: "data: [DONE]" });
    const frames = parseFrames(result!.raw);
    expect(frames).toEqual([
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("passes through non-JSON data frame unchanged (never throws)", () => {
    const frame = { raw: "data: not-valid-json" };
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it('passes through frame that does not start with "data: " unchanged', () => {
    const frame = { raw: "event: ping" };
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it("passes through JSON frame with no event field unchanged", () => {
    const frame = { raw: 'data: {"someOtherField":"value"}' };
    const result = transform(frame);
    expect(result).toEqual(frame);
  });
});

describe("langGraphAdapter transform — on_tool_start", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("maps on_tool_start to tool-input-available with run_id, name, and input", () => {
    const frame = fixture.frames.find((f) => f.event === "on_tool_start");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame));
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.type).toBe("tool-input-available");
    expect(parsed.toolCallId).toBe(frame!.run_id);
    expect(parsed.toolName).toBe(frame!.name);
    expect(parsed.input).toEqual({});
  });

  it("output contains exactly type/toolCallId/toolName/input — no extra fields (AI SDK v6 strictObject)", () => {
    const frame = fixture.frames.find((f) => f.event === "on_tool_start");
    const result = transform(toSseFrame(frame));
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(Object.keys(parsed).sort()).toEqual(
      ["input", "toolCallId", "toolName", "type"].sort()
    );
  });

  it("preserves non-empty input when present", () => {
    const synthetic = toSseFrame({
      event: "on_tool_start",
      name: "search",
      run_id: "rid-1",
      data: { input: { query: "hello world", limit: 5 } },
    });
    const result = transform(synthetic);
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.input).toEqual({ query: "hello world", limit: 5 });
  });

  it("returns null when run_id is missing (degenerate frame)", () => {
    const frame = toSseFrame({
      event: "on_tool_start",
      name: "increment",
      data: { input: {} },
    });
    expect(transform(frame)).toBeNull();
  });

  it("returns null when name is missing (degenerate frame)", () => {
    const frame = toSseFrame({
      event: "on_tool_start",
      run_id: "rid-1",
      data: { input: {} },
    });
    expect(transform(frame)).toBeNull();
  });
});

describe("langGraphAdapter transform — on_tool_end", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("maps on_tool_end with structured ToolMessage output to tool-output-available — extracts content", () => {
    const frame = fixture.frames.find((f) => f.event === "on_tool_end");
    expect(frame).toBeDefined();
    const result = transform(toSseFrame(frame));
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.type).toBe("tool-output-available");
    expect(parsed.toolCallId).toBe(frame!.run_id);
    expect(parsed.output).toBe("Counter incremented to 39");
  });

  it("output contains exactly type/toolCallId/output — no extra fields", () => {
    const frame = fixture.frames.find((f) => f.event === "on_tool_end");
    const result = transform(toSseFrame(frame));
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(Object.keys(parsed).sort()).toEqual(
      ["output", "toolCallId", "type"].sort()
    );
  });

  it("passes through string-only output (sync tool returning a plain string)", () => {
    const frame = toSseFrame({
      event: "on_tool_end",
      name: "increment",
      run_id: "rid-2",
      data: { output: "raw string output" },
    });
    const result = transform(frame);
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.output).toBe("raw string output");
  });

  it("stringifies non-string content (e.g. structured payload)", () => {
    const frame = toSseFrame({
      event: "on_tool_end",
      name: "search",
      run_id: "rid-3",
      data: { output: { content: { hits: 3, top: ["a", "b", "c"] } } },
    });
    const result = transform(frame);
    const parsed = JSON.parse(result!.raw.slice(6));
    // content was an object → JSON.stringify'd into output
    expect(parsed.output).toBe('{"hits":3,"top":["a","b","c"]}');
  });

  it("returns null when run_id is missing", () => {
    const frame = toSseFrame({
      event: "on_tool_end",
      name: "increment",
      data: { output: "x" },
    });
    expect(transform(frame)).toBeNull();
  });

  it("handles missing data field gracefully (output becomes empty-string JSON)", () => {
    const frame = toSseFrame({
      event: "on_tool_end",
      name: "increment",
      run_id: "rid-4",
    });
    const result = transform(frame);
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.output).toBe('""');
  });
});

describe("langGraphAdapter transform — branch coverage for missing chunk fields", () => {
  // Fresh transform per call — adapter is now stateful (tracks open text blocks).
  const transform = (frame: { raw: string }) => freshTransform()(frame);

  it("on_chat_model_stream with no chunk field returns null (missing chunk ?? {})", () => {
    // Covers L54: (parsed.data?.chunk as ...) ?? {} — chunk is undefined
    // content is then undefined ?? '' = '' → !content → return null
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "r",
      data: {},
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });

  it('on_chat_model_stream with chunk but no content field returns null (content ?? "")', () => {
    // Covers L55: (chunk.content as string) ?? '' — content is undefined
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "r",
      data: { chunk: {} },
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });

  it("ADVERSARIAL: on_tool_end with explicit output=null must not crash and must emit empty output", () => {
    // Edge case: a tool that legitimately returns null (e.g. void function,
    // `return null` from a sync tool). The source path is:
    //   let output: string;
    //   if (typeof out === "string") { output = out; }
    //   else if (out !== null && typeof out === "object" && "content" in out) { ... }
    //   else { output = JSON.stringify(out ?? ""); }
    // `out` is null → first two branches fail, the third hits
    // `JSON.stringify(null ?? "")` → JSON.stringify("") → '""'.
    // Must NOT throw, and must produce a frame whose output is the JSON
    // string "null" or '""' (whichever the impl picks — but it must round-trip
    // through JSON.parse without error and be a string).
    const frame = toSseFrame({
      event: "on_tool_end",
      name: "void_tool",
      run_id: "rid-null",
      data: { output: null },
    });
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.raw.slice(6));
    expect(parsed.type).toBe("tool-output-available");
    expect(parsed.toolCallId).toBe("rid-null");
    // output must be a string — never undefined, never the raw null
    expect(typeof parsed.output).toBe("string");
    expect(parsed.output).not.toBeNull();
  });

  it("on_chat_model_stream with content as array (tool-call mode) must return null, not a corrupted text-delta", () => {
    // LangGraph emits content as an array of content-block objects when the model
    // invokes a tool (e.g. [{type:"tool_use", id:"…", name:"…", input:{}}]).
    // The source casts `chunk.content as string` — an array is truthy, so `!content`
    // is false and the adapter currently emits:
    //   data: {"type":"text-delta","delta":[{"type":"tool_use","name":"search","input":{}}]}
    // That corrupts the AI SDK v6 stream because delta must be a string.
    // The correct behaviour is to return null (drop the frame) when content is not
    // a non-empty string, just like the empty-string finish-signal case.
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "r",
      data: {
        chunk: {
          content: [
            { type: "tool_use", id: "toolu_01", name: "search", input: {} },
          ],
        },
      },
    });
    const result = transform(frame);
    // Must be null — a non-string content value is not a text delta
    expect(result).toBeNull();
  });

  // INVARIANT LOCK (mirror of openSwe fix): the guard
  //   `if (typeof content !== "string" || !content) return null;` (L99)
  // uses JS truthiness, which accepts whitespace-only strings (" ", "\n",
  // "\t", " " non-breaking space). A whitespace content is functionally
  // empty — it should be dropped (return null) just like the empty-string case.
  // Currently the adapter emits `data: {type:"text-delta", delta:" "}` for any
  // truthy string content, which surfaces a visible blank-space delta in the UI
  // and triggers spurious chunk notifications for content the user sees as
  // nothing. The hardened fix (used in openSwe.ts) is `!content.trim()`.
  // This test asserts the desired hardened behaviour and will FAIL on the
  // current implementation.
  it("ADVERSARIAL: on_chat_model_stream with whitespace-only content (single space) must NOT emit a text-delta", () => {
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "rws",
      data: { chunk: { content: " " } },
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });

  it("ADVERSARIAL: on_chat_model_stream with Unicode non-breaking space (\\u00A0) must NOT emit a text-delta", () => {
    // Same guard, harder payload: U+00A0 is whitespace per JS regex \s but is
    // truthy as a string. The bug is identical: the truthiness guard accepts
    // it, the AI SDK surfaces a visible blank delta. Hardened behaviour drops it.
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "rnb",
      data: { chunk: { content: " " } },
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });

  // INVARIANT LOCK (NEW, iter 6): the on_chat_model_stream branch (L99-100)
  // guards with
  //   if (typeof content !== "string" || !content.trim()) return null;
  // The typeof check MUST come BEFORE the .trim() call — a non-string content
  // (number, boolean, object, undefined) would otherwise throw
  // `TypeError: content.trim is not a function` out of the transform and
  // crash the SSE stream. Specifically, the LITERAL number 0 (zero) is a
  // plausible upstream payload (e.g. a chunk of a tool-call content array
  // containing `[0, "real text"]` arrives wrapped; or a custom backend uses 0
  // as a sentinel for "no content"). The hardened guard drops it. Verify
  // that the typeof check is consistently placed BEFORE .trim() and that
  // `content: 0` is dropped (not thrown).
  it("ADVERSARIAL: on_chat_model_stream with content=0 (the number zero) must return null — typeof guard fires before .trim() and must not throw", () => {
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "rzero",
      data: { chunk: { content: 0 } },
    });
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    expect(result).toBeNull();
  });

  // INVARIANT LOCK (oversized / unserializable output): on_tool_end routes
  // through `JSON.stringify(out ?? "")` for the output field when `out` is
  // neither a string nor an object with `content`. JSON.stringify THROWS on
  // circular references ("TypeError: Converting circular structure to
  // JSON"). If a LangGraph tool returns an output object whose body contains
  // a self-referencing field (or a proxied value that JSON.stringify can't
  // handle), the throw bubbles out of the transform and crashes the SSE
  // stream. The contract: never throw on any frame.
  it("ADVERSARIAL: on_tool_end with circular output must not throw — must produce a tool-output-available frame with a string output", () => {
    const transform = freshTransform();
    // We can't put a circular reference through JSON.stringify into `raw`
    // (the helper itself throws), so we monkey-patch JSON.parse to revive
    // a special sentinel into a circular structure. The transform calls
    // JSON.parse on the raw frame's data; whatever JSON.parse returns is
    // what the transform sees. We return an object whose .data.output is
    // a self-referencing structure that JSON.stringify on the output
    // envelope path will throw on.
    const originalParse = JSON.parse;
    const sentinel = "__CIRCULAR_SENTINEL__";
    JSON.parse = (raw: string) => {
      const obj = originalParse(raw) as Record<string, unknown>;
      if (
        obj &&
        typeof obj === "object" &&
        (obj.data as Record<string, unknown> | undefined)?.output === sentinel
      ) {
        const circ: Record<string, unknown> = {
          event: obj.event,
          name: obj.name,
          run_id: obj.run_id,
          data: { output: undefined as unknown },
        };
        (circ.data as Record<string, unknown>).output = circ.data;
        return circ;
      }
      return obj;
    };
    try {
      const frame = toSseFrame({
        event: "on_tool_end",
        name: "circ_tool",
        run_id: "r-circ",
        data: { output: sentinel },
      });
      expect(() => transform(frame)).not.toThrow();
      const result = transform(frame);
      expect(result).not.toBeNull();
      const parsed = originalParse(result!.raw.slice(6)) as Record<
        string,
        unknown
      >;
      expect(parsed.type).toBe("tool-output-available");
      expect(parsed.toolCallId).toBe("r-circ");
      // output must be a string (never undefined, never an object)
      expect(typeof parsed.output).toBe("string");
    } finally {
      JSON.parse = originalParse;
    }
  });
});

import type { SseAdapter } from "../adapter-contract";
import { createSseProxyHandler } from "../handler";
import { NextRequest } from "next/server";
import {
  countToolCalls,
  resultsAfterFinish,
  unpairedToolCalls,
} from "../tool-pairing";

// --- rung contract conformance (moved from public-api.test.ts) -----------------------------
describe("langgraph rung — adapter contract", () => {
  it("langGraphAdapter implements SseAdapter", () => {
    expectTypeOf(langGraphAdapter).toMatchTypeOf<SseAdapter>();
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
describe("langgraph — tool calls are resolved before the stream ends", () => {
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
      adapter: langGraphAdapter,
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
    `data: {"event":"on_tool_start","run_id":"r-1","name":"increment","data":{"input":{}}}`,
    `data: {"event":"on_tool_end","run_id":"r-1","name":"increment","data":{"output":"Counter incremented to 6"}}`,
    `data: [DONE]`,
  ];

  it("the fixture actually contains a tool call — emptiness would be vacuous", async () => {
    // Asserted separately and first. "No unpaired calls" is trivially true of a
    // stream that never called a tool, so the next case is meaningless without
    // this one.
    const out = await run__tp(WITH_TOOL);
    expect(countToolCalls(out)).toBeGreaterThan(0);
  });

  it("every announced tool call receives a result", async () => {
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
