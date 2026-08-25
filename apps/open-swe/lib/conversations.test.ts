import { describe, it, expect } from "vitest";
import {
  defaultNewChatFramework,
  newConversationId,
  parseConversations,
  removeConversation,
  sortConversations,
  titleFromMessage,
  upsertConversation,
  type Conversation,
} from "./conversations";
import { FRAMEWORKS } from "./frameworks";

const conv = (
  id: string,
  updatedAt = "2026-01-01T00:00:00Z",
  extra: Partial<Conversation> = {}
): Conversation => ({
  id,
  title: `t-${id}`,
  framework: "deepagents",
  updatedAt,
  ...extra,
});

describe("defaultNewChatFramework", () => {
  it("is deepagents — the most capable rung, not the simplest", () => {
    // Deliberately different from FRAMEWORKS[0]: ladder order answers "which is
    // a step up", the new-chat default answers "which will they want".
    expect(defaultNewChatFramework()).toBe("deepagents");
  });

  it("is always a framework that actually exists", () => {
    expect(FRAMEWORKS.some((f) => f.id === defaultNewChatFramework())).toBe(true);
  });
});

describe("titleFromMessage", () => {
  it("uses the first message", () => {
    expect(titleFromMessage("Fix the login bug")).toBe("Fix the login bug");
  });

  it("collapses whitespace and newlines", () => {
    expect(titleFromMessage("  Fix   the\n\nbug  ")).toBe("Fix the bug");
  });

  it("truncates with an ellipsis rather than wrapping the sidebar", () => {
    const out = titleFromMessage("x".repeat(200), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never returns an empty title — a blank row looks like a bug", () => {
    expect(titleFromMessage("")).toBe("New chat");
    expect(titleFromMessage("   \n ")).toBe("New chat");
    expect(titleFromMessage(undefined as unknown as string)).toBe("New chat");
  });
});

describe("parseConversations — a corrupt store must not empty the sidebar wrongly", () => {
  it("returns [] for null and for unparseable JSON", () => {
    expect(parseConversations(null)).toEqual([]);
    expect(parseConversations("{oops")).toEqual([]);
  });

  it("returns [] for JSON that is not an array", () => {
    expect(parseConversations('{"id":"a"}')).toEqual([]);
  });

  it("drops entries with no usable id, keeps the rest", () => {
    const out = parseConversations(
      JSON.stringify([conv("keep"), { title: "no id" }, { id: "" }, null])
    );
    expect(out.map((c) => c.id)).toEqual(["keep"]);
  });

  it("repairs an unknown framework instead of discarding the conversation", () => {
    const out = parseConversations(
      JSON.stringify([{ id: "a", framework: "not-a-rung" }])
    );
    expect(out).toHaveLength(1);
    expect(out[0].framework).toBe(defaultNewChatFramework());
  });

  it("repairs a missing title rather than rendering a blank row", () => {
    const out = parseConversations(JSON.stringify([{ id: "a" }]));
    expect(out[0].title).toBe("New chat");
  });

  it("keeps a per-conversation systemPrompt when present, omits it when not", () => {
    const withP = parseConversations(
      JSON.stringify([{ id: "a", systemPrompt: "be terse" }])
    );
    expect(withP[0].systemPrompt).toBe("be terse");
    const without = parseConversations(JSON.stringify([{ id: "b" }]));
    expect("systemPrompt" in without[0]).toBe(false);
  });
});

describe("sortConversations", () => {
  it("puts the most recently touched first", () => {
    const out = sortConversations([
      conv("old", "2026-01-01T00:00:00Z"),
      conv("new", "2026-06-01T00:00:00Z"),
      conv("mid", "2026-03-01T00:00:00Z"),
    ]);
    expect(out.map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  it("sinks an unparseable date instead of dropping the conversation", () => {
    const out = sortConversations([conv("bad", "nope"), conv("good")]);
    expect(out.map((c) => c.id)).toEqual(["good", "bad"]);
    expect(out).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const input = [conv("a", "2026-01-01T00:00:00Z"), conv("b", "2026-06-01T00:00:00Z")];
    const before = input.map((c) => c.id);
    sortConversations(input);
    expect(input.map((c) => c.id)).toEqual(before);
  });
});

describe("upsertConversation", () => {
  it("adds a new conversation at the front", () => {
    const out = upsertConversation([conv("a")], conv("b"));
    expect(out.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("updates in place rather than duplicating — reopening must not fork a row", () => {
    const list = [conv("a"), conv("b")];
    const out = upsertConversation(list, { ...conv("a"), title: "renamed" });
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.id === "a")!.title).toBe("renamed");
  });

  it("does not mutate its input", () => {
    const list = [conv("a")];
    upsertConversation(list, { ...conv("a"), title: "x" });
    expect(list[0].title).toBe("t-a");
  });
});

describe("removeConversation", () => {
  it("removes only the named id", () => {
    const out = removeConversation([conv("a"), conv("b")], "a");
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("is a no-op for an unknown id", () => {
    expect(removeConversation([conv("a")], "zzz")).toHaveLength(1);
  });
});

describe("newConversationId", () => {
  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newConversationId()));
    expect(ids.size).toBe(200);
  });

  it("produces a non-empty string", () => {
    expect(newConversationId().length).toBeGreaterThan(0);
  });
});
