/**
 * Rung 3's two load-bearing properties (#10).
 *
 * 1. THE NAMESPACE PREDICATE. The one line that does not survive translation
 *    from the Python, and the only defect here that produces a WELL-FORMED
 *    stream — so no other assertion in this file would catch it.
 *
 * 2. FRAME CONFORMANCE. #16's bar for rung 1 is "no output frame may still
 *    carry an `event:` header", which proves langchainAdapter recognised the
 *    frames. It does not transfer: `deepagentsAdapter` is sixteen lines and one
 *    transform, this backend emits AI SDK v6 natively, and there are no
 *    `event:` headers on this rung for the assertion to be about. It would name
 *    the property and be unable to fail on it.
 *
 *    The witness that works instead is the CONSUMER'S OWN PARSER —
 *    `uiMessageChunkSchema`, resolved out of the installed `ai` package, not a
 *    local re-description of it. Same instrument that caught a real defect in
 *    #325 which all 738 packages/server tests missed.
 *
 * The namespace fixtures are VENDORED as literals rather than produced by
 * running a real agent: they are the shapes recorded by the #10 probe against
 * deepagents 1.13.2 and 0.7.11, and a fixture that has to boot a model is not a
 * fixture a test can rely on.
 */
import { describe, it, expect } from "vitest";
import { uiMessageChunkSchema } from "ai";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";

import {
  isSubagentNamespace,
  emitAiSdkV6,
  coerceOutput,
} from "./deepagents.js";

/** Namespaces as the two runtimes actually emit them — measured, not invented. */
const NS = {
  jsRoot: ["model_request:aebca58a-f427-5fcd-b76f-5f11fc8371ee"],
  jsSubagent: [
    "tools:fee8ded5-24fc-5dfb-83c4-15d6ce9132a7",
    "model_request:4c2acc7d-93de-54dc-80e0-b5d16fd2baef",
  ],
  jsSubagentTool: [
    "tools:fee8ded5-24fc-5dfb-83c4-15d6ce9132a7",
    "tools:e7b5ac20-6d61-5384-b35b-cd6318232cee",
  ],
  pythonRoot: [] as string[],
  pythonSubagent: ["tools:c8c57551-a4d6-7775-53ad-d1f45b3b0f93"],
};

describe("isSubagentNamespace — the line that does not survive translation", () => {
  it("the JS ROOT agent's namespace is NOT empty, and is not a subagent", () => {
    /*
     * THE WHOLE POINT. `subagent = bool(namespace)` is correct Python and
     * inverts here: this namespace is non-empty, so the faithful port would
     * classify the assistant's own prose as subagent output and drop it.
     */
    expect(NS.jsRoot.length).toBeGreaterThan(0);
    expect(isSubagentNamespace(NS.jsRoot)).toBe(false);
  });

  it("a JS subagent IS one", () => {
    expect(isSubagentNamespace(NS.jsSubagent)).toBe(true);
    expect(isSubagentNamespace(NS.jsSubagentTool)).toBe(true);
  });

  it("agrees with Python on both of Python's shapes", () => {
    // The predicate is not JS-specific — it is the correct rule in both
    // runtimes. Python's `bool(ns)` merely coincides with it.
    expect(isSubagentNamespace(NS.pythonRoot)).toBe(false);
    expect(isSubagentNamespace(NS.pythonSubagent)).toBe(true);
  });

  it("`bool(namespace)` would disagree — which is the defect, stated as a test", () => {
    const pythonRule = (ns: readonly unknown[]) => ns.length > 0;
    expect(pythonRule(NS.jsRoot)).toBe(true); // "subagent"
    expect(isSubagentNamespace(NS.jsRoot)).toBe(false); // ...it is not
  });
});

/* -------------------------------------------------------------------------- */

type Chunk = [unknown[], string, unknown];

/** A graph stub that replays recorded chunks — no model, no network. */
function fakeGraph(chunks: Chunk[]) {
  return {
    async stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  } as never;
}

const aiText = (text: string, toolCalls: unknown[] = []) =>
  new AIMessageChunk({
    content: text,
    tool_calls: toolCalls as never,
  });

async function collect(chunks: Chunk[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const raw of emitAiSdkV6(fakeGraph(chunks), [])) {
    for (const line of raw.split("\n")) {
      if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)));
    }
  }
  return out;
}

const validator = (
  uiMessageChunkSchema as unknown as () => {
    validate: (v: unknown) => Promise<{ success: boolean; error?: unknown }>;
  }
)().validate;

describe("emitAiSdkV6", () => {
  it("emits the ROOT agent's prose", async () => {
    const frames = await collect([
      [NS.jsRoot, "messages", [aiText("hello from the assistant")]],
    ]);
    const deltas = frames.filter((f) => f.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe("hello from the assistant");
  });

  it("DROPS a subagent's prose but KEEPS its tool call", async () => {
    /*
     * Both halves in one case because they are one decision. Hiding subagent
     * text matches the canonical CLI and the reasoning is still in the trace.
     * Hiding its TOOL CALLS was a different thing wearing the same clothes: a
     * subagent tool call mutates shared state, and suppressing it made the UI
     * report work it did not do and omit work it did — measured on the live
     * matrix as "reported 0 increment call(s) but the counter moved 5 -> 6".
     */
    const frames = await collect([
      [
        NS.jsSubagent,
        "messages",
        [
          aiText("internal reasoning", [
            { name: "increment", args: {}, id: "tc1" },
          ]),
        ],
      ],
    ]);
    expect(frames.filter((f) => f.type === "text-delta")).toHaveLength(0);
    expect(
      frames.filter((f) => f.type === "tool-input-available")
    ).toHaveLength(1);
  });

  it("announces a tool call as a strict-valid PAIR, never one frame", async () => {
    const frames = await collect([
      [
        NS.jsRoot,
        "messages",
        [aiText("", [{ name: "increment", args: { by: 1 }, id: "tc1" }])],
      ],
    ]);
    const start = frames.find((f) => f.type === "tool-input-start");
    const avail = frames.find((f) => f.type === "tool-input-available");
    expect(start).toBeDefined();
    // `input` on a tool-input-start is what AI SDK v6 rejects (#325).
    expect(start).not.toHaveProperty("input");
    expect(avail?.input).toEqual({ by: 1 });
  });

  it("a tool RESULT is keyed to its call, and is emitted for subagents too", async () => {
    const frames = await collect([
      [
        NS.jsSubagentTool,
        "messages",
        [
          new ToolMessage({
            content: "Counter incremented to 2",
            tool_call_id: "tc1",
          }),
        ],
      ],
    ]);
    const out = frames.find((f) => f.type === "tool-output-available");
    expect(out?.toolCallId).toBe("tc1");
    expect(out?.output).toBe("Counter incremented to 2");
  });

  it("always ends with a terminal finish frame", async () => {
    // Without one the proxy reports upstream_disconnect (#247) — a real error
    // reaching the user as a transport failure.
    const frames = await collect([]);
    expect(frames.at(-1)?.type).toBe("finish");
  });

  it("does not announce the same tool call twice", async () => {
    const call = { name: "increment", args: {}, id: "tc1" };
    const frames = await collect([
      [NS.jsRoot, "messages", [aiText("", [call])]],
      [NS.jsRoot, "messages", [aiText("", [call])]],
    ]);
    expect(frames.filter((f) => f.type === "tool-input-start")).toHaveLength(1);
  });
});

describe("every frame this rung emits is readable by AI SDK v6", () => {
  it("the validator REJECTS a known-bad frame — the positive control", async () => {
    /*
     * Without this, a validator that accepts everything is indistinguishable
     * from one that was never called, and the suite below would be decoration.
     * This exact frame — a tool-input-start carrying `input` — is what #325
     * found packages/server emitting.
     */
    const bad = await validator({
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "increment",
      input: {},
    });
    expect(bad.success).toBe(false);
  });

  it("a full turn validates, frame by frame", async () => {
    const frames = await collect([
      [NS.jsRoot, "messages", [aiText("Let me increment that.")]],
      [
        NS.jsRoot,
        "messages",
        [aiText("", [{ name: "increment", args: {}, id: "tc1" }])],
      ],
      [
        NS.jsRoot,
        "messages",
        [
          new ToolMessage({
            content: "Counter incremented to 2",
            tool_call_id: "tc1",
          }),
        ],
      ],
      [NS.jsRoot, "messages", [aiText("Done — it is now 2.")]],
    ]);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) {
      const r = await validator(f);
      expect(r.success, `AI SDK v6 rejects ${JSON.stringify(f)}`).toBe(true);
    }
  });
});

describe("coerceOutput", () => {
  it("passes a string through and joins content blocks", () => {
    expect(coerceOutput("plain")).toBe("plain");
    expect(coerceOutput([{ text: "a" }, { text: "b" }])).toBe("a b");
  });
});
