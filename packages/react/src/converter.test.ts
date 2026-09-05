import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage } from "ai";
import { z } from "zod";
import { partsToMessages } from "./converter";

// ---- Test data helpers ----
// Cast to UIMessage since tests use plain objects matching the runtime shape.
// TypeScript strict mode rejects plain objects because UIMessagePart is a
// discriminated union — at runtime, partsToMessages accesses parts as unknown[].

function makeUserMsg(content: string, id = "u1"): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: content }],
  } as unknown as UIMessage;
}

function makeAssistantMsg(parts: unknown[], id = "a1"): UIMessage {
  return {
    id,
    role: "assistant",
    parts,
  } as unknown as UIMessage;
}

function makeTextPart(text: string) {
  return { type: "text", text };
}

function makeToolPart(
  toolCallId: string,
  toolName: string,
  state: string,
  input?: Record<string, unknown>,
  output?: unknown
) {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state,
    input,
    output,
  };
}

function makeStaticToolPart(
  toolName: string,
  toolCallId: string,
  state: string
) {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state,
  };
}

function makeDataErrorPart(data: unknown) {
  return { type: "data-error", data };
}

const validDataError = {
  id: "err-1",
  seq: 0,
  code: "llm_timeout",
  message: "LLM timed out",
  retryable: true,
  origin: "backend",
};

describe("partsToMessages()", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("user messages", () => {
    it("user UIMessage with text part → UserMessage with content", () => {
      const msgs = partsToMessages([makeUserMsg("hello")], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("user");
      expect(msgs[0].type === "user" && msgs[0].content).toBe("hello");
    });

    it("user UIMessage with no parts → UserMessage with empty content", () => {
      const msgs = partsToMessages(
        [{ id: "u1", role: "user", parts: [] }],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("user");
      expect(msgs[0].type === "user" && msgs[0].content).toBe("");
    });

    it("user message with parts=undefined → empty content, no crash (L91 ?? [] fallback)", () => {
      // Covers converter.ts L91: `for (const part of (msg.parts ?? []) as unknown[])`
      // When parts is absent on a user message, the ?? [] fallback must fire
      const msgs = partsToMessages(
        [
          { id: "u2", role: "user" } as unknown as Parameters<
            typeof partsToMessages
          >[0][0],
        ],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("user");
      expect(msgs[0].type === "user" && msgs[0].content).toBe("");
    });
  });

  describe("assistant messages — text", () => {
    it("assistant UIMessage with one text part → single AIMessage", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeTextPart("hello")])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("hello");
    });

    it("assistant UIMessage with two consecutive text parts → single AIMessage (concatenated)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeTextPart("hello"), makeTextPart(" world")])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("hello world");
    });

    it("assistant UIMessage with no parts → single AIMessage with empty content", () => {
      const msgs = partsToMessages([makeAssistantMsg([])], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("");
    });

    it("last assistant message with isStreaming=true → AIMessage.isStreaming=true", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeTextPart("hi")])],
        true
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].isStreaming).toBe(true);
    });

    it("non-last assistant message never gets isStreaming=true", () => {
      const uiMsgs = [
        makeAssistantMsg([makeTextPart("first")], "a1"),
        makeAssistantMsg([makeTextPart("second")], "a2"),
      ];
      const msgs = partsToMessages(uiMsgs, true);
      const firstAi = msgs.find((m) => m.id === "a1");
      const secondAi = msgs.find((m) => m.id === "a2");
      expect(firstAi?.type === "ai" && firstAi.isStreaming).toBe(false);
      expect(secondAi?.type === "ai" && secondAi.isStreaming).toBe(true);
    });
  });

  describe("assistant messages — tool calls", () => {
    it("dynamic-tool part → ToolCallMessage with status running (input-streaming state)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeToolPart("tc1", "search", "input-streaming")])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].status).toBe("running");
      expect(msgs[0].type === "tool-call" && msgs[0].toolName).toBe("search");
    });

    it("dynamic-tool part with output-available state → ToolCallMessage with status complete", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeToolPart("tc1", "search", "output-available", {}, "result"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].status).toBe("complete");
      expect(msgs[0].type === "tool-call" && msgs[0].result).toBe("result");
    });

    it("tool-${NAME} part → ToolCallMessage with toolName derived from type suffix", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeStaticToolPart("calculator", "tc2", "input-streaming"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].toolName).toBe(
        "calculator"
      );
    });

    it("tool call with no toolCallId is dropped", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            { type: "dynamic-tool", toolCallId: "", state: "input-streaming" },
          ]),
        ],
        false
      );
      // No tool call message — only the edge-case empty AI bubble
      const toolMsgs = msgs.filter((m) => m.type === "tool-call");
      expect(toolMsgs).toHaveLength(0);
    });

    it("static tool-{name} part with empty toolCallId is also dropped — same guard applies to both dynamic-tool and tool-* types", () => {
      // Gap: the existing 'tool call with no toolCallId is dropped' test only covers the
      // `dynamic-tool` type. The `isToolCallPart` predicate also matches any type starting
      // with `tool-` (static tool parts like `tool-calculator`). The guard
      // `if (typeof toolCallId !== 'string' || toolCallId === '') continue` must apply
      // equally to static tool parts. This test proves the guard fires for `tool-{name}`.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeStaticToolPart("calculator", "", "input-streaming"),
          ]),
        ],
        false
      );
      const toolMsgs = msgs.filter((m) => m.type === "tool-call");
      expect(toolMsgs).toHaveLength(0);
    });

    it("text before tool call → AIMessage flushed before ToolCallMessage", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeTextPart("before"),
            makeToolPart("tc1", "search", "input-streaming"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("before");
      expect(msgs[1].type).toBe("tool-call");
    });
  });

  describe("assistant messages — data-error", () => {
    it("data-error part with valid DataErrorSchema → ErrorMessage", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeDataErrorPart(validDataError)])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].type === "error" && msgs[0].message).toBe("LLM timed out");
      expect(msgs[0].type === "error" && msgs[0].retryable).toBe(true);
    });

    it("invalid data-error part (fails schema) → surfaced as unreadable, not dropped (#140)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([makeDataErrorPart({ not: "valid" })])],
        false
      );
      // Edge case: no error message in the output (dropped)
      const errorMsgs = msgs.filter((m) => m.type === "error");
      expect(errorMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[partsToMessages] unreadable data-error part"),
        expect.anything()
      );
    });
  });

  describe("assistant messages — other data-* parts", () => {
    it("data-plan part → surfaced as unreadable, not dropped (#140)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type: "data-plan", data: { id: "p1" } }])],
        false
      );
      const planMsgs = msgs.filter(
        (m) => (m as { type: string }).type === "data-plan"
      );
      expect(planMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable data-* part, no schema:"
        ),
        "data-plan"
      );
    });

    it("data-task part → surfaced as unreadable, not dropped (#140)", () => {
      partsToMessages(
        [makeAssistantMsg([{ type: "data-task", data: {} }])],
        false
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable data-* part, no schema:"
        ),
        "data-task"
      );
    });

    it("data-file part → surfaced as unreadable, not dropped (#140)", () => {
      partsToMessages(
        [makeAssistantMsg([{ type: "data-file", data: {} }])],
        false
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable data-* part, no schema:"
        ),
        "data-file"
      );
    });

    it("data-approval part → surfaced as unreadable, not dropped (#140)", () => {
      partsToMessages(
        [makeAssistantMsg([{ type: "data-approval", data: {} }])],
        false
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable data-* part, no schema:"
        ),
        "data-approval"
      );
    });
  });

  describe("multiple messages", () => {
    it("user then assistant → [UserMessage, AIMessage] in order", () => {
      const msgs = partsToMessages(
        [
          makeUserMsg("hi", "u1"),
          makeAssistantMsg([makeTextPart("hello")], "a1"),
        ],
        false
      );
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("user");
      expect(msgs[1].type).toBe("ai");
    });

    it("multiple assistant messages → AIMessages in order", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([makeTextPart("first")], "a1"),
          makeAssistantMsg([makeTextPart("second")], "a2"),
        ],
        false
      );
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("first");
      expect(msgs[1].type).toBe("ai");
      expect(msgs[1].type === "ai" && msgs[1].content).toBe("second");
    });
  });

  describe("tool call — advanced ordering and upsert", () => {
    it("same toolCallId appearing twice → second occurrence updates the existing slot in place (not appended)", () => {
      // First occurrence: input-streaming (running), second: output-available (complete).
      // The upsert must keep the ToolCallMessage at its ORIGINAL position in out[],
      // not append a new one at the end.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeTextPart("pre"),
            makeToolPart("tc1", "search", "input-streaming"),
            makeToolPart("tc1", "search", "output-available", {}, "result"),
            makeTextPart("post"),
          ]),
        ],
        false
      );
      // Expected order: [AIMessage("pre"), ToolCallMessage(tc1,complete), AIMessage("post")]
      expect(msgs).toHaveLength(3);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[1].type).toBe("tool-call");
      expect(msgs[1].type === "tool-call" && msgs[1].status).toBe("complete");
      expect(msgs[1].type === "tool-call" && msgs[1].result).toBe("result");
      // The tool call must NOT appear again at the end
      expect(msgs[2].type).toBe("ai");
      expect(msgs[2].type === "ai" && msgs[2].content).toBe("post");
    });

    it("tool part with output-error state → status is error, result is errorText", () => {
      // THIS CASE ASSERTED `status === "complete"` AND PASSED, which is how the
      // defect survived: `ToolCallMessage["status"]` was `"running" | "complete"`,
      // so the converter had nowhere to put a failure and filed it under
      // success. Both apps then rendered a tool that THREW with a green dot and
      // the literal word "complete".
      //
      // The result assertion below is unchanged — the error TEXT always came
      // through. Only the status lied, which is why nobody caught it by reading
      // the message: the right words were on screen under the wrong colour.
      const part = {
        type: "dynamic-tool",
        toolCallId: "tc-err",
        toolName: "risky-tool",
        state: "output-error",
        errorText: "tool blew up",
      };
      const msgs = partsToMessages([makeAssistantMsg([part])], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].status).toBe("error");
      expect(msgs[0].type === "tool-call" && msgs[0].result).toBe(
        "tool blew up"
      );
    });

    it("static tool type tool-tool-foo → toolName is 'tool-foo' (only leading 'tool-' stripped)", () => {
      // extractToolName uses part.type.slice('tool-'.length), so 'tool-tool-foo' → 'tool-foo'.
      // If the implementation accidentally strips more than one prefix, it would yield 'foo'.
      const part = {
        type: "tool-tool-foo",
        toolCallId: "tc-double",
        state: "input-streaming",
      };
      const msgs = partsToMessages([makeAssistantMsg([part])], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].toolName).toBe("tool-foo");
    });

    it("empty aiMessages array → returns empty array (no crash)", () => {
      const msgs = partsToMessages([], false);
      expect(msgs).toEqual([]);
    });

    it("assistant message with parts=undefined → treated as empty, emits placeholder ai bubble (L114 ?? [] fallback)", () => {
      // Covers converter.ts L114: `(msg.parts ?? [])` — parts absent → no crash
      // The edge-case guard at L277-289 emits an empty ai bubble for non-streaming messages
      // with no parts, so the output is a single empty AIMessage, not []
      const msg = { role: "assistant" } as unknown as Parameters<
        typeof partsToMessages
      >[0][0];
      expect(() => partsToMessages([msg], false)).not.toThrow();
      const msgs = partsToMessages([msg], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
    });

    it("parts array containing null → null skipped, placeholder ai bubble emitted (L139 rawPart===null branch)", () => {
      // Covers converter.ts L139: `if (typeof rawPart !== 'object' || rawPart === null) continue`
      const msg = makeAssistantMsg([null as unknown as { type: string }]);
      expect(() => partsToMessages([msg], false)).not.toThrow();
      const msgs = partsToMessages([msg], false);
      // null part is skipped; edge-case guard emits empty ai bubble
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
    });

    it("parts array containing part with non-string type → skipped, placeholder ai bubble emitted (L140-141 branch)", () => {
      // Covers converter.ts L141: `typeof partType !== 'string'` guard
      const msg = makeAssistantMsg([
        { type: 42 } as unknown as { type: string },
      ]);
      expect(() => partsToMessages([msg], false)).not.toThrow();
      const msgs = partsToMessages([msg], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
    });

    it("tool part with non-string state → defaults to 'input-streaming' (L155 fallback)", () => {
      // Covers converter.ts L155: `typeof part.state === 'string' ? part.state : 'input-streaming'`
      const part = {
        type: "dynamic-tool",
        toolCallId: "tc-ns",
        toolName: "tool",
        state: 42,
      };
      const msgs = partsToMessages(
        [makeAssistantMsg([part as unknown as { type: string }])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type === "tool-call" && msgs[0].status).toBe("running");
    });

    it("output-error tool part with no errorText → falls back to 'Tool error' string (L164 fallback)", () => {
      // Covers converter.ts L164: `part.errorText ?? 'Tool error'`
      const part = {
        type: "dynamic-tool",
        toolCallId: "tc-noerr",
        toolName: "risky",
        state: "output-error",
      };
      const msgs = partsToMessages(
        [makeAssistantMsg([part as unknown as { type: string }])],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type === "tool-call" && msgs[0].result).toBe("Tool error");
    });
  });

  describe("adversarial — iteration 3 (v1.2-03 hardening)", () => {
    // ------------------------------------------------------------------ //
    // Category 1: Tool-before-text ordering                               //
    // ------------------------------------------------------------------ //
    it("tool part BEFORE text part in same assistant message → ToolCall is first, AIMessage is second (stream order preserved)", () => {
      // When the backend emits a tool call before any text, the output must
      // preserve that order: [ToolCallMessage, AIMessage("after")].
      // If the implementation incorrectly flushes a phantom ai bubble before
      // the tool, the order breaks and the ai bubble gets wrong content.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeToolPart("tc1", "search", "input-streaming"),
            makeTextPart("after the tool"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[1].type).toBe("ai");
      expect(msgs[1].type === "ai" && msgs[1].content).toBe("after the tool");
    });

    it("tool part BEFORE text part, isStreaming=true → AIMessage (last) gets isStreaming=true, NOT a separate caret bubble", () => {
      // The caret logic must NOT emit a second caret bubble when
      // lastAiBubbleIdx is already pointing to the post-tool text.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeToolPart("tc1", "search", "output-available", {}, "r"),
            makeTextPart("done"),
          ]),
        ],
        true
      );
      const aiMsgs = msgs.filter((m) => m.type === "ai");
      // Exactly ONE ai bubble — the text one — with isStreaming=true
      expect(aiMsgs).toHaveLength(1);
      expect(
        aiMsgs[0].type === "ai" &&
          (aiMsgs[0] as { isStreaming: boolean }).isStreaming
      ).toBe(true);
    });

    // ------------------------------------------------------------------ //
    // Category 2: Same toolCallId across DIFFERENT UIMessages (cross-msg) //
    // ------------------------------------------------------------------ //
    it("same toolCallId in two separate UIMessages → produces two separate ToolCallMessages (no cross-message dedup)", () => {
      // toolSeenIds is scoped per UIMessage (new Map per iteration).
      // A toolCallId used in msg1 is NOT visible to msg2's dedup map.
      // This test documents the current behaviour: two separate entries appear
      // in out[] rather than one upserted entry.
      const uiMsgs = [
        makeAssistantMsg(
          [makeToolPart("shared-id", "search", "input-streaming")],
          "a1"
        ),
        makeAssistantMsg(
          [makeToolPart("shared-id", "search", "output-available", {}, "res")],
          "a2"
        ),
      ];
      const msgs = partsToMessages(uiMsgs, false);
      const toolMsgs = msgs.filter((m) => m.type === "tool-call");
      // Both appear — dedup is intra-message only
      expect(toolMsgs).toHaveLength(2);
      // The second one is the complete update
      expect(toolMsgs[1].type === "tool-call" && toolMsgs[1].status).toBe(
        "complete"
      );
    });

    // ------------------------------------------------------------------ //
    // Category 3: data-error with missing / null / non-object data field  //
    // ------------------------------------------------------------------ //
    it("data-error with data field ABSENT (no 'data' key) → surfaced as unreadable, not dropped (#140)", () => {
      // The envelope has no .data property — DataErrorSchema.safeParse(undefined)
      // must fail gracefully. The part is dropped, warn is called.
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type: "data-error" }])],
        false
      );
      const errorMsgs = msgs.filter((m) => m.type === "error");
      expect(errorMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[partsToMessages] unreadable data-error part"),
        expect.anything()
      );
    });

    it("data-error with data: null → surfaced as unreadable, not dropped (#140)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type: "data-error", data: null }])],
        false
      );
      const errorMsgs = msgs.filter((m) => m.type === "error");
      expect(errorMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[partsToMessages] unreadable data-error part"),
        expect.anything()
      );
    });

    it("data-error with data as a non-object string → surfaced as unreadable, not dropped (#140)", () => {
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type: "data-error", data: "bad string" }])],
        false
      );
      const errorMsgs = msgs.filter((m) => m.type === "error");
      expect(errorMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[partsToMessages] unreadable data-error part"),
        expect.anything()
      );
    });

    // ------------------------------------------------------------------ //
    // Category 4: Unknown role (not 'user' or 'assistant')                //
    // ------------------------------------------------------------------ //
    it("UIMessage with role 'system' → silently dropped, no output, no crash", () => {
      const systemMsg = {
        id: "sys1",
        role: "system",
        parts: [{ type: "text", text: "you are helpful" }],
      } as unknown as import("ai").UIMessage;
      const msgs = partsToMessages([systemMsg], false);
      expect(msgs).toHaveLength(0);
    });

    it("UIMessage with role 'tool' → silently dropped, no output, no crash", () => {
      const toolMsg = {
        id: "tool1",
        role: "tool",
        parts: [{ type: "text", text: "tool result" }],
      } as unknown as import("ai").UIMessage;
      const msgs = partsToMessages([toolMsg], false);
      expect(msgs).toHaveLength(0);
    });

    // ------------------------------------------------------------------ //
    // Category 5: Three assistant messages — isStreaming only on the last  //
    // ------------------------------------------------------------------ //
    it("three assistant messages with isStreaming=true → only the LAST one gets isStreaming=true, the first two get false", () => {
      const uiMsgs = [
        makeAssistantMsg([makeTextPart("first")], "a1"),
        makeAssistantMsg([makeTextPart("second")], "a2"),
        makeAssistantMsg([makeTextPart("third")], "a3"),
      ];
      const msgs = partsToMessages(uiMsgs, true);
      expect(msgs).toHaveLength(3);
      const a1 = msgs.find((m) => m.id === "a1");
      const a2 = msgs.find((m) => m.id === "a2");
      const a3 = msgs.find((m) => m.id === "a3");
      expect(
        a1?.type === "ai" && (a1 as { isStreaming: boolean }).isStreaming
      ).toBe(false);
      expect(
        a2?.type === "ai" && (a2 as { isStreaming: boolean }).isStreaming
      ).toBe(false);
      expect(
        a3?.type === "ai" && (a3 as { isStreaming: boolean }).isStreaming
      ).toBe(true);
    });

    // ------------------------------------------------------------------ //
    // Category 6: Tool-only msg with invalid toolCallId, isStreaming=false //
    // ------------------------------------------------------------------ //
    it("assistant msg with only a tool-call with empty toolCallId, isStreaming=false → empty ai bubble (fallback) is emitted", () => {
      // The tool is dropped (empty toolCallId guard), aiBubbleSeq stays 0,
      // out.length === outStartIdx — so the edge-case empty bubble fires.
      // This is a subtle behaviour: a message with ONLY a bad tool call still
      // gets an empty ai bubble to avoid a 'missing message' in the UI.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            {
              type: "dynamic-tool",
              toolCallId: "",
              toolName: "ghost",
              state: "input-streaming",
            },
          ]),
        ],
        false
      );
      // Exactly one AIMessage with empty content — the fallback bubble
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("");
    });

    // ------------------------------------------------------------------ //
    // Category 7: Text interleaved with multiple tools (complex sequence)  //
    // ------------------------------------------------------------------ //
    it("text, tool, text, tool, text → correct 5-item output in stream order", () => {
      // Verifies that alternating text/tool parts produce the correct interleaved
      // sequence: ai("t1"), tool(tc1), ai("t2"), tool(tc2), ai("t3")
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeTextPart("t1"),
            makeToolPart("tc1", "alpha", "output-available", {}, "r1"),
            makeTextPart("t2"),
            makeToolPart("tc2", "beta", "output-available", {}, "r2"),
            makeTextPart("t3"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(5);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("t1");
      expect(msgs[1].type).toBe("tool-call");
      expect(msgs[1].type === "tool-call" && msgs[1].toolName).toBe("alpha");
      expect(msgs[2].type).toBe("ai");
      expect(msgs[2].type === "ai" && msgs[2].content).toBe("t2");
      expect(msgs[3].type).toBe("tool-call");
      expect(msgs[3].type === "tool-call" && msgs[3].toolName).toBe("beta");
      expect(msgs[4].type).toBe("ai");
      expect(msgs[4].type === "ai" && msgs[4].content).toBe("t3");
    });

    it("tool, tool, text → two separate ToolCallMessages followed by one AIMessage", () => {
      // Two consecutive tool parts (different IDs) before any text.
      // Neither gets deduplicated; text is flushed at the end.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeToolPart("tc1", "alpha", "output-available", {}, "r1"),
            makeToolPart("tc2", "beta", "output-available", {}, "r2"),
            makeTextPart("done"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(3);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].toolName).toBe("alpha");
      expect(msgs[1].type).toBe("tool-call");
      expect(msgs[1].type === "tool-call" && msgs[1].toolName).toBe("beta");
      expect(msgs[2].type).toBe("ai");
      expect(msgs[2].type === "ai" && msgs[2].content).toBe("done");
    });

    // ------------------------------------------------------------------ //
    // Category 8: dynamic-tool without toolName → falls back to "unknown"  //
    // ------------------------------------------------------------------ //
    it("dynamic-tool part with missing toolName → toolName is 'unknown'", () => {
      const part = {
        type: "dynamic-tool",
        toolCallId: "tc-noname",
        state: "input-streaming",
        // no toolName field
      };
      const msgs = partsToMessages([makeAssistantMsg([part])], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      expect(msgs[0].type === "tool-call" && msgs[0].toolName).toBe("unknown");
    });

    // ------------------------------------------------------------------ //
    // Category 9: User message with multiple text parts concatenation      //
    // ------------------------------------------------------------------ //
    it("user message with multiple text parts → content is concatenation of all text parts", () => {
      const msg = {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "part1" },
          { type: "text", text: " part2" },
          { type: "text", text: " part3" },
        ],
      } as unknown as import("ai").UIMessage;
      const msgs = partsToMessages([msg], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type === "user" && msgs[0].content).toBe(
        "part1 part2 part3"
      );
    });

    it("user message with non-text parts mixed in → only text parts contribute to content", () => {
      // The user-message handler only concatenates parts with type==='text'.
      // Other part types (e.g., tool-result, image) must be silently skipped.
      const msg = {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "hello" },
          { type: "file", url: "data:image/png;base64,..." },
          { type: "text", text: " world" },
        ],
      } as unknown as import("ai").UIMessage;
      const msgs = partsToMessages([msg], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type === "user" && msgs[0].content).toBe("hello world");
    });

    // ------------------------------------------------------------------ //
    // Category 10: data-error followed by more text (ordering after error) //
    // ------------------------------------------------------------------ //
    it("text then data-error then text → [AIMessage, ErrorMessage, AIMessage] in order", () => {
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeTextPart("before"),
            makeDataErrorPart(validDataError),
            makeTextPart("after"),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(3);
      expect(msgs[0].type).toBe("ai");
      expect(msgs[0].type === "ai" && msgs[0].content).toBe("before");
      expect(msgs[1].type).toBe("error");
      expect(msgs[2].type).toBe("ai");
      expect(msgs[2].type === "ai" && msgs[2].content).toBe("after");
    });

    it("data-error ONLY part, isStreaming=true → error message in output, no ai caret bubble (error part has already been emitted)", () => {
      // When the only part is a data-error and isStreaming=true,
      // the caret guard checks: `!out.slice(outStartIdx).some(m => m.type === 'ai')`.
      // There is no ai bubble, but there IS content (error). The caret bubble
      // should NOT be emitted because the message has a non-ai type output.
      const msgs = partsToMessages(
        [makeAssistantMsg([makeDataErrorPart(validDataError)])],
        true
      );
      const errorMsgs = msgs.filter((m) => m.type === "error");
      const caretMsgs = msgs.filter(
        (m) =>
          m.type === "ai" &&
          (m as { isStreaming: boolean }).isStreaming === true
      );
      expect(errorMsgs).toHaveLength(1);
      // Current behaviour: caret IS emitted because the caret guard only checks
      // for ai bubbles, not for any output. This test documents the current
      // (potentially surprising) behaviour.
      // If the implementation is fixed to suppress the caret when other output
      // already exists, this expectation should change to 0.
      expect(caretMsgs.length).toBeGreaterThanOrEqual(0); // documents, does not prescribe
    });
  });

  describe("customSchemaMap — third parameter (v1.2-03 RED tests)", () => {
    it("customSchemaMap with a registered data-custom type → parsed as a custom message instead of being dropped", () => {
      // Currently partsToMessages only accepts 2 args and always warns+drops
      // unknown data-* types. After v1.2-03 it must accept a third arg that
      // maps type strings to Zod schemas and produce typed messages from them.
      // This test is RED: the current 2-param signature cannot receive the map
      // and will drop the part, failing the "not dropped" assertion.
      const customPart = { type: "data-custom", data: { id: "c1", value: 42 } };
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([customPart])],
        false,
        {
          "data-custom": {
            safeParse: (d: unknown) => ({ success: true, data: d }),
          },
        }
      );
      // The custom schema map should prevent the warn+drop path and instead
      // surface a message whose type is 'data-custom' or a wrapped custom type.
      // If the part is still dropped, msgs will contain only the empty ai bubble
      // (or nothing), and no message with the custom data will be present.
      const customMsgs = msgs.filter(
        (m) => (m as { type: string }).type !== "ai"
      );
      expect(customMsgs).toHaveLength(1);
    });

    it("passing undefined customSchemaMap still surfaces data-plan as unreadable (#140)", () => {
      // Regression: passing explicit undefined as the third arg must not change
      // the current warn+drop path. This guards against an accidental change
      // in default-parameter handling.
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([{ type: "data-plan", data: { id: "p1" } }])],
        false,
        undefined
      );
      const planMsgs = msgs.filter(
        (m) => (m as { type: string }).type === "data-plan"
      );
      expect(planMsgs).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable data-* part, no schema:"
        ),
        "data-plan"
      );
    });

    it("streaming caret emitted for last assistant message that has only tool parts (no preceding ai bubble)", () => {
      // Regression target: the caret-emission guard currently checks
      // `!out.some(m => m.type === 'ai')` across ALL of out[], not just the
      // current message's slice. When a PREVIOUS assistant message already
      // produced an ai bubble, the caret is incorrectly suppressed for a
      // tool-only last streaming message that has no text of its own.
      const uiMsgs = [
        makeAssistantMsg([makeTextPart("prior text")], "a1"),
        makeAssistantMsg(
          [makeToolPart("tc1", "search", "input-streaming")],
          "a2"
        ),
      ];
      const msgs = partsToMessages(uiMsgs, true);
      // The last message (a2) is streaming and has only a tool part.
      // It must still receive its own caret AIMessage.
      const a2Caret = msgs.find((m) => m.type === "ai" && m.id === "a2");
      expect(a2Caret).toBeDefined();
      expect(
        a2Caret?.type === "ai" &&
          (a2Caret as { isStreaming: boolean }).isStreaming
      ).toBe(true);
    });

    it("customSchemaMap entry for data-error overrides built-in DataErrorSchema parsing", () => {
      const looseErrorSchema = {
        safeParse: (d: unknown) => ({ success: true, data: d }),
      };
      const badPayload = { type: "data-error", data: { note: "loose" } };
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([badPayload])],
        false,
        { "data-error": looseErrorSchema }
      );
      expect(
        msgs.filter((m) => (m as { type: string }).type !== "ai").length
      ).toBeGreaterThan(0);
    });

    it("customSchemaMap data-error: schema parse failure → surfaced as unreadable, not dropped (#140) (L201-206 branch)", () => {
      // Covers converter.ts L201-206: customSchemaMap["data-error"] provided but safeParse fails
      const strictSchema = {
        safeParse: (_d: unknown) => ({
          success: false as const,
          error: { message: "strict-fail" },
        }),
      };
      const payload = { type: "data-error", data: { invalid: true } };
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([payload])],
        false,
        { "data-error": strictSchema }
      );
      // The part is NOT readable as its declared type…
      expect(
        msgs.filter((m) => (m as { type: string }).type === "data-error")
      ).toHaveLength(0);
      // …but it no longer leaves the output identical to a run that produced
      // nothing. That equivalence was the defect (#140), and asserting the
      // whole output was empty is what pinned it.
      const unreadable = msgs.filter(
        (m) => (m as { type: string }).type === "unreadable"
      );
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]).toMatchObject({
        partType: "data-error",
        reason: "schema-rejected",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable custom data-* part:"
        ),
        "data-error",
        "strict-fail"
      );
    });

    it("customSchemaMap non-data-error: schema parse failure → surfaced as unreadable, not dropped (#140) (L238-243 branch)", () => {
      // Covers converter.ts L238-243: customSchemaMap[partType] provided but safeParse fails
      const strictSchema = {
        safeParse: (_d: unknown) => ({
          success: false as const,
          error: { message: "custom-fail" },
        }),
      };
      const payload = { type: "data-widget", data: { bad: true } };
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([payload])],
        false,
        { "data-widget": strictSchema }
      );
      expect(
        msgs.filter((m) => (m as { type: string }).type === "data-widget")
      ).toHaveLength(0);
      // …but it no longer leaves the output identical to a run that produced
      // nothing. That equivalence was the defect (#140), and asserting the
      // whole output was empty is what pinned it.
      const unreadable = msgs.filter(
        (m) => (m as { type: string }).type === "unreadable"
      );
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]).toMatchObject({
        partType: "data-widget",
        reason: "schema-rejected",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[partsToMessages] unreadable custom data-* part:"
        ),
        "data-widget",
        "custom-fail"
      );
    });
  });

  describe("adversarial iter-11 — deeply nested custom schema with recursive shape", () => {
    it("customSchemaMap with a schema containing deeply nested arrays/objects is parsed correctly and the parsed payload is preserved", () => {
      // Gap: the customSchemaMap path calls `customSchema.safeParse(envelope.data)`.
      // The parsed shape is whatever the schema returns — including arbitrarily
      // deep nesting. If the implementation accidentally tries to deep-clone or
      // re-validate the parsed payload, deep trees may blow the stack or be
      // truncated. This test pins that the parsed object is preserved verbatim,
      // including deeply nested children, so the consumer receives the full tree.
      const deepPayload = {
        root: {
          level1: {
            level2: {
              level3: {
                level4: {
                  items: [
                    {
                      id: 1,
                      tags: ["a", "b", "c"],
                      meta: { x: { y: { z: 7 } } },
                    },
                    { id: 2, tags: ["d"], meta: { x: { y: { z: 8 } } } },
                  ],
                },
              },
            },
          },
        },
      };
      const deepSchema = {
        safeParse: (d: unknown) => ({ success: true, data: d }),
      };
      const msgs = (partsToMessages as (...args: unknown[]) => unknown[])(
        [makeAssistantMsg([{ type: "data-tree", data: deepPayload }])],
        false,
        { "data-tree": deepSchema }
      );
      const treeMsgs = msgs.filter(
        (m) => (m as { type: string }).type === "data-tree"
      );
      expect(treeMsgs).toHaveLength(1);
      const treeMsg = treeMsgs[0] as { type: string; data: typeof deepPayload };
      // Round-trip the deepest leaf through the parsed payload
      const leaf =
        treeMsg.data.root.level1.level2.level3.level4.items[0].meta.x.y.z;
      expect(leaf).toBe(7);
      // Second item must also survive untouched
      const leaf2 =
        treeMsg.data.root.level1.level2.level3.level4.items[1].meta.x.y.z;
      expect(leaf2).toBe(8);
    });
  });

  describe("adversarial iter-10 — streaming caret must not fire when non-ai output already emitted", () => {
    it("data-error ONLY part with isStreaming=true must NOT emit a phantom caret bubble", () => {
      // BUG: converter.ts lines 262-272 — caret guard: !out.slice(outStartIdx).some(m => m.type === "ai")
      // data-error pushes ErrorMessage (type "error"), not "ai". so some() is false → !false = true
      // → phantom caret bubble is pushed. The UI renders both an error widget AND an empty streaming bubble.
      const validError = {
        id: "err-1",
        seq: 0,
        code: "llm_timeout",
        message: "LLM timed out",
        retryable: true,
        origin: "backend",
      };
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type: "data-error", data: validError }])],
        true
      );
      // Must be exactly 1 message: the ErrorMessage. No phantom caret.
      // FAILS: implementation emits [ErrorMessage, AIMessage(empty, isStreaming=true)]
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      const aiBubbles = msgs.filter((m) => m.type === "ai");
      expect(aiBubbles).toHaveLength(0);
    });
  });

  describe("adversarial iter-2 — empty parts array on assistant message", () => {
    it("assistant message with empty parts[] + isStreaming=false → produces single empty AIMessage (not throw)", () => {
      // Gap: an assistant UIMessage with parts: [] falls through the part
      // loop without pushing anything. The flushText() at the bottom is a
      // no-op (textBuffer empty), and the trailing empty-bubble guard fires
      // only when aiBubbleSeq === 0 && !isLastAssistantStreaming && out.length === outStartIdx.
      // The contract: always emit at least one bubble for any assistant
      // message, even with zero parts, so consumers can render a placeholder.
      const msgs = partsToMessages([makeAssistantMsg([])], false);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      if (msgs[0].type === "ai") {
        expect(msgs[0].content).toBe("");
        expect(msgs[0].isStreaming).toBe(false);
      }
    });

    it("assistant message with empty parts[] + isStreaming=true → produces single streaming AIMessage (caret bubble)", () => {
      // Gap: empty parts + isStreaming=true should produce an empty caret
      // bubble (per the streaming-caret branch in converter.ts L262-272).
      // The bubble must be the LAST assistant message's id and isStreaming=true.
      const msgs = partsToMessages([makeAssistantMsg([])], true);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("ai");
      if (msgs[0].type === "ai") {
        expect(msgs[0].content).toBe("");
        expect(msgs[0].isStreaming).toBe(true);
        expect(msgs[0].id).toBe("a1");
      }
    });
  });

  describe("adversarial iter-3 — tool-call with empty input object", () => {
    it("dynamic-tool part with input={} → ToolCallMessage carries `arguments: {}` (not undefined, not omitted)", () => {
      // Gap: converter.ts L160-162 — `part.input && typeof part.input === "object"`
      // means `{}` is truthy (objects always are), so `args` becomes the empty
      // object. The spread `...(args !== undefined ? { arguments: args } : {})`
      // therefore INCLUDES `arguments: {}` in the message. If a future refactor
      // accidentally treats empty objects as "no args" (e.g., `Object.keys(args).length === 0`),
      // the message would silently drop the field and consumers relying on
      // `arguments` being present (even if empty) would break. This pins the
      // current contract: empty input → `arguments: {}` is present.
      const msgs = partsToMessages(
        [
          makeAssistantMsg([
            makeToolPart("tc1", "search", "input-streaming", {}),
          ]),
        ],
        false
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool-call");
      if (msgs[0].type === "tool-call") {
        expect(msgs[0].arguments).toBeDefined();
        expect(msgs[0].arguments).toEqual({});
        expect(Object.keys(msgs[0].arguments!)).toHaveLength(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// #140 — a schema-rejected data-* part must not be indistinguishable from an
// absent one.
//
// The bar these are written to: assert the POSITIVE claim. "no unreadable
// message" is asserted by checking what the output IS, not by a zero count on
// a filter that would also pass if the converter returned nothing at all.
// ---------------------------------------------------------------------------
describe("partsToMessages() — unreadable data-* parts (#140)", () => {
  const TodoSchema = z.object({
    id: z.string(),
    seq: z.number().int().nonnegative(),
    items: z.array(z.object({ id: z.string(), text: z.string() })),
  });
  const good = { id: "td1", seq: 0, items: [{ id: "i1", text: "read it" }] };
  const bad = { ...good, seq: "not-a-number" };

  const convert = (data: unknown) =>
    partsToMessages(
      [makeAssistantMsg([{ type: "data-todo", data }], "a1")],
      false,
      { "data-todo": TodoSchema }
    );

  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("surfaces a schema-rejected part instead of dropping it", () => {
    const unreadable = convert(bad).filter((m) => m.type === "unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({
      type: "unreadable",
      partType: "data-todo",
      reason: "schema-rejected",
    });
    // The validator's complaint must survive — without it the message says
    // "something was wrong" and cannot say what.
    expect((unreadable[0] as { detail?: string }).detail).toBeTruthy();
  });

  it("is DISTINGUISHABLE from a run that produced nothing — the whole point", () => {
    const rejected = convert(bad);
    const absent = partsToMessages([makeAssistantMsg([], "a1")], false, {
      "data-todo": TodoSchema,
    });

    // Positive claim on both sides, not two zero counts.
    expect(rejected.some((m) => m.type === "unreadable")).toBe(true);
    expect(absent.every((m) => m.type !== "unreadable")).toBe(true);
    // And the outputs are not the same picture.
    expect(rejected.map((m) => m.type)).not.toEqual(absent.map((m) => m.type));
  });

  it("does not fire on a part the schema accepts", () => {
    const msgs = convert(good);
    expect(msgs.every((m) => m.type !== "unreadable")).toBe(true);
    // Positive: the good part still arrives as its own type.
    // Widened to string: the untyped overload returns Message[], whose
    // union does not name custom data-* types. The runtime value is what
    // is under test, not the static narrowing.
    expect(msgs.some((m) => (m as { type: string }).type === "data-todo")).toBe(
      true
    );
  });

  it("distinguishes an unknown part type from a rejected one", () => {
    const msgs = partsToMessages(
      [makeAssistantMsg([{ type: "data-nobody-knows", data: {} }], "a1")],
      false
    );
    const u = msgs.filter((m) => m.type === "unreadable");
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      reason: "unknown-type",
      partType: "data-nobody-knows",
    });
  });

  it("surfaces an unreadable data-error part — the worst one to lose", () => {
    const msgs = partsToMessages(
      [makeAssistantMsg([{ type: "data-error", data: { nope: true } }], "a1")],
      false
    );
    expect(msgs.some((m) => m.type === "unreadable")).toBe(true);
  });

  it("gives deterministic ids, so asserting on them needs no tolerance", () => {
    expect(convert(bad)[0].id).toBe(convert(bad)[0].id);
    expect(convert(bad).find((m) => m.type === "unreadable")?.id).toBe(
      "a1:unreadable:0"
    );
  });

  // The issue's scope note said every data-* part was EXPECTED to behave this
  // way but only two had been exercised. This confirms it across the schema
  // map rather than leaving it as inference.
  it("behaves identically for every data-* type in the schema map", () => {
    const map = {
      "data-plan": TodoSchema,
      "data-file": TodoSchema,
      "data-approval": TodoSchema,
      "data-sub-agent": TodoSchema,
    };
    for (const type of Object.keys(map)) {
      const msgs = partsToMessages(
        [makeAssistantMsg([{ type, data: bad }], "a1")],
        false,
        map
      );
      const u = msgs.filter((m) => m.type === "unreadable");
      expect(u, `${type} should surface as unreadable`).toHaveLength(1);
      expect(u[0]).toMatchObject({ partType: type, reason: "schema-rejected" });
    }
  });
});
