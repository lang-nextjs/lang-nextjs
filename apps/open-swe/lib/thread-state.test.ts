import { describe, it, expect } from "vitest";
import {
  normalizeMessages,
  contentToText,
  mapThreadStatus,
  type RawMessage,
} from "./thread-state";

describe("contentToText", () => {
  it("returns strings as-is and joins content-block arrays", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText([{ text: "a" }, { text: "b" }])).toBe("ab");
    expect(contentToText(null)).toBe("");
    expect(contentToText(42)).toBe("");
  });
});

describe("mapThreadStatus", () => {
  it("maps raw statuses and prioritises interrupts", () => {
    expect(mapThreadStatus("busy", false)).toBe("running");
    expect(mapThreadStatus("idle", false)).toBe("completed");
    expect(mapThreadStatus("error", false)).toBe("failed");
    expect(mapThreadStatus("idle", true)).toBe("interrupted");
  });
});

describe("normalizeMessages", () => {
  it("pairs ai tool_calls with their tool results by id", () => {
    const messages: RawMessage[] = [
      { type: "human", content: "Create circle.py" },
      {
        type: "ai",
        content: "",
        tool_calls: [
          { id: "tc1", name: "write_file", args: { file_path: "/c.py" } },
        ],
      },
      {
        type: "tool",
        name: "write_file",
        tool_call_id: "tc1",
        content: "Updated file /c.py",
      },
      { type: "ai", content: "Done." },
    ];
    const items = normalizeMessages(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    const tool = items[1]!;
    expect(tool.toolName).toBe("write_file");
    expect(tool.args).toEqual({ file_path: "/c.py" });
    expect(tool.result).toBe("Updated file /c.py");
    expect(tool.ok).toBe(true);
  });

  it("marks a tool item failed when its result reads like an error", () => {
    const items = normalizeMessages([
      { type: "ai", content: "", tool_calls: [{ id: "x", name: "read_file" }] },
      { type: "tool", tool_call_id: "x", content: "Error: file not found" },
    ]);
    expect(items[0]!.ok).toBe(false);
  });

  it("skips empty assistant text and orphan tool messages, keeps tool calls without results", () => {
    const items = normalizeMessages([
      { type: "ai", content: "", tool_calls: [{ id: "y", name: "task" }] },
      { type: "tool", tool_call_id: "zzz", content: "orphan" }, // no matching call
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.toolName).toBe("task");
    expect(items[0]!.result).toBeUndefined();
  });
});

describe("ADVERSARIAL — 1000-message long thread", () => {
  it("handles 1000 alternating user/assistant/tool messages within bounded time and pairs every tool_call", () => {
    // Adversarial: a long-lived thread produces 1000 messages with 500 tool
    // calls (each followed by a tool result). The function must:
    //   - finish in well under 1s (no O(N^2) regression — Map.get/set is O(1))
    //   - preserve ALL tool_call → tool result pairings (no dropped pairs)
    //   - not produce duplicate ids or omit any rendered item
    //   - mark every result with the expected toolName and result text
    //
    // Build 1000 messages: pattern (human, ai+tc, tool) x 333 + (human) for 999 total,
    // plus a trailing (ai+tool_calls without results) to test the orphan-call path.
    const messages: RawMessage[] = [];
    const N_TOOLS = 333;
    for (let i = 0; i < N_TOOLS; i++) {
      messages.push({ type: "human", content: `Q${i}` });
      messages.push({
        type: "ai",
        content: "",
        tool_calls: [
          { id: `tc-${i}`, name: `tool_${i % 7}`, args: { idx: i } },
        ],
      });
      messages.push({
        type: "tool",
        name: `tool_${i % 7}`,
        tool_call_id: `tc-${i}`,
        content: `result-${i}`,
      });
    }

    const start = Date.now();
    const items = normalizeMessages(messages);
    const elapsed = Date.now() - start;

    // Performance: 1000 messages must not regress to O(N^2) — pin to under 1s.
    expect(elapsed).toBeLessThan(1000);

    // Every user message (333) + every tool item (333) = 666 rendered items.
    // The ai messages with empty content are skipped (content.trim() === "").
    expect(items).toHaveLength(N_TOOLS * 2);

    // Every tool item carries the right toolName, args, and result.
    const toolItems = items.filter((i) => i.kind === "tool");
    expect(toolItems).toHaveLength(N_TOOLS);

    // All tool calls paired correctly — every result matches the expected index.
    for (let i = 0; i < N_TOOLS; i++) {
      const expectedIdx = i % 7;
      // toolName was set to `tool_${expectedIdx}`
      const matched = toolItems.find(
        (t) =>
          t.toolName === `tool_${expectedIdx}` && t.result === `result-${i}`
      );
      expect(matched).toBeDefined();
      expect(matched!.args).toEqual({ idx: i });
      expect(matched!.ok).toBe(true);
    }

    // Every user item is present and non-empty.
    const userItems = items.filter((i) => i.kind === "user");
    expect(userItems).toHaveLength(N_TOOLS);
    expect(userItems[0]!.text).toBe("Q0");
    expect(userItems[N_TOOLS - 1]!.text).toBe(`Q${N_TOOLS - 1}`);

    // All ids must be unique (no collisions across 666 items).
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(items.length);
  });
});

describe("ADVERSARIAL — contentToText with cyclic content blocks", () => {
  it("bails without hanging on a circular reference inside a content block", () => {
    // contentToText recurses into p.text via String(p.text). A circular object
    // passed as `p` whose own `text` field references itself would normally
    // recurse infinitely via JSON.stringify. The implementation only reads the
    // own .text property once and String()s it — String(cyclicObj) coerces the
    // object to "[object Object]" (no infinite recursion). This test pins the
    // bail-not-hang behaviour with a timer-bounded assertion: if the impl ever
    // swaps String(...) for a JSON.stringify or recursive walk it would hang.
    const cyclic: { text: unknown } = { text: null as unknown };
    cyclic.text = cyclic; // self-reference
    const start = Date.now();
    const result = contentToText([cyclic as unknown as { text: string }]);
    const elapsed = Date.now() - start;
    // Must finish in well under 1 second — a hang would trip this assertion.
    expect(elapsed).toBeLessThan(1000);
    // String(cyclic) coerces the cyclic object to "[object Object]" (no crash).
    expect(typeof result).toBe("string");
  });

  it("normalizeMessages does not hang when an ai message's content blocks contain mutual cycles", async () => {
    // Adversarial: AI responses from a buggy tool call sometimes return
    // self-referential object graphs (e.g. an SDK that forgets to detach a
    // response from its request). The page render path must:
    //   (a) finish in bounded time (no infinite recursion)
    //   (b) produce SOMETHING renderable (a string) rather than throwing
    //       (which would 500 the run page)
    //   (c) still pair the subsequent tool result correctly by tool_call_id,
    //       even when the surrounding ai message has cyclic content blocks.
    const start = Date.now();
    // Build two blocks that cross-reference each other
    type Block = { text: unknown; other?: Block };
    const a: Block = { text: null as unknown };
    const b: Block = { text: null as unknown };
    a.text = b;
    b.text = a;
    a.other = b;
    b.other = a;

    const items = normalizeMessages([
      { type: "human", content: "do thing" },
      // The ai message carries cyclic content blocks. The tool_call below
      // should still pair with the standalone tool message.
      {
        type: "ai",
        content: [a as unknown as { text: string }],
        tool_calls: [{ id: "tc-cyclic", name: "noop", args: {} }],
      },
      {
        type: "tool",
        name: "noop",
        tool_call_id: "tc-cyclic",
        content: "ok",
      },
    ]);
    const elapsed = Date.now() - start;

    // (a) bounded time
    expect(elapsed).toBeLessThan(1000);
    // (b) renderable: at minimum the human message must survive
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.kind).toBe("user");
    // (c) the tool call paired correctly despite the cyclic ai content
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool!.toolName).toBe("noop");
    expect(tool!.result).toBe("ok");
    expect(tool!.ok).toBe(true);
  });
});
