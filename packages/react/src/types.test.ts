import { describe, it, expect } from "vitest";
import type {
  Message,
  UserMessage,
  AIMessage,
  ToolCallMessage,
  ErrorMessage,
} from "./types";
import { generateId, assertNever } from "./types";

describe("Message union types", () => {
  it('UserMessage has type "user", id, content, timestamp', () => {
    const msg: UserMessage = {
      type: "user",
      id: "1",
      content: "hello",
      timestamp: new Date(),
    };
    expect(msg.type).toBe("user");
    expect(msg.id).toBe("1");
    expect(msg.content).toBe("hello");
    expect(msg.timestamp).toBeInstanceOf(Date);
  });

  it('AIMessage has type "ai", id, content, timestamp, isStreaming', () => {
    const msg: AIMessage = {
      type: "ai",
      id: "2",
      content: "hi",
      timestamp: new Date(),
      isStreaming: false,
    };
    expect(msg.type).toBe("ai");
    expect(msg.isStreaming).toBe(false);
  });

  it('ToolCallMessage has type "tool-call", id, toolName, status, optional arguments and result', () => {
    const msg: ToolCallMessage = {
      type: "tool-call",
      id: "3",
      toolName: "search",
      status: "running",
      arguments: { query: "test" },
    };
    expect(msg.type).toBe("tool-call");
    expect(msg.status).toBe("running");
    expect(msg.arguments).toEqual({ query: "test" });
    // result is optional
    expect(msg.result).toBeUndefined();
  });

  it('ErrorMessage has type "error", id, message, retryable', () => {
    const msg: ErrorMessage = {
      type: "error",
      id: "4",
      message: "something went wrong",
      retryable: true,
    };
    expect(msg.type).toBe("error");
    expect(msg.retryable).toBe(true);
  });

  it("Message discriminated union narrows correctly by type field", () => {
    const messages: Message[] = [
      { type: "user", id: "1", content: "hi", timestamp: new Date() },
      {
        type: "ai",
        id: "2",
        content: "hello",
        timestamp: new Date(),
        isStreaming: false,
      },
      { type: "tool-call", id: "3", toolName: "search", status: "complete" },
      { type: "error", id: "4", message: "oops", retryable: false },
    ];
    for (const m of messages) {
      if (m.type === "user") {
        expect(m.content).toBeDefined();
      } else if (m.type === "ai") {
        expect(m.isStreaming).toBeDefined();
      } else if (m.type === "tool-call") {
        expect(m.toolName).toBeDefined();
      } else if (m.type === "error") {
        expect(m.retryable).toBeDefined();
      }
    }
  });

  it("generateId() returns a non-empty string (UUID format)", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("assertNever() throws on unexpected value", () => {
    expect(() => assertNever("unexpected" as never)).toThrow(
      "Unhandled discriminated union member"
    );
  });

  it("generateId() returns unique values on successive calls (no collisions)", () => {
    // generateId wraps crypto.randomUUID() — if the implementation ever accidentally
    // returns a constant or cached value, this will catch it.
    const ids = Array.from({ length: 20 }, () => generateId());
    const unique = new Set(ids);
    expect(unique.size).toBe(20);
  });

  it("assertNever() error message includes the stringified unexpected value", () => {
    // The error must embed the value so callers can diagnose which variant escaped.
    // If the message format changes (e.g. removes JSON.stringify), this catches it.
    const badValue = { type: "ghost", id: "x" };
    expect(() => assertNever(badValue as never)).toThrow(
      JSON.stringify(badValue)
    );
  });
});
