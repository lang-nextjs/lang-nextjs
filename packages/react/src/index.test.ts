import { describe, it, expect, vi } from "vitest";

// Mock peer deps before importing index (which imports hook)
vi.mock("@ai-sdk/react", () => ({ useChat: vi.fn() }));
vi.mock("ai", () => ({ DefaultChatTransport: vi.fn() }));

// Rung-owned components are NOT imported here: a static named import of an export a fork has
// ejected is a hard TYPE error. rung-surface.test.ts asserts them, derived from rungs.json.
import {
  useDeepAgentsChat,
  generateId,
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  PlanSubtaskSchema,
  TodoItemSchema,
  TodoSchema,
  AgentsMdSchema,
  parseDataPart,
  partsToMessages,
  AgentsMdCard,
} from "./index";

describe("@deepagents-nextjs/react public API", () => {
  it("exports useDeepAgentsChat as a function", () => {
    expect(useDeepAgentsChat).toBeTypeOf("function");
  });

  it("exports generateId as a function", () => {
    expect(generateId).toBeTypeOf("function");
  });

  it("exports PlanSchema (Zod object)", () => {
    expect(PlanSchema).toBeDefined();
    expect(typeof PlanSchema.parse).toBe("function");
  });

  it("exports TaskSchema (Zod object)", () => {
    expect(TaskSchema).toBeDefined();
    expect(typeof TaskSchema.parse).toBe("function");
  });

  it("exports FileSchema (Zod object)", () => {
    expect(FileSchema).toBeDefined();
    expect(typeof FileSchema.parse).toBe("function");
  });

  it("exports ApprovalSchema (Zod object)", () => {
    expect(ApprovalSchema).toBeDefined();
    expect(typeof ApprovalSchema.parse).toBe("function");
  });

  it("exports parseDataPart as a function", () => {
    expect(parseDataPart).toBeTypeOf("function");
  });

  it("exports partsToMessages as a function", () => {
    expect(partsToMessages).toBeTypeOf("function");
  });

  it("exports TodoSchema (Zod object)", () => {
    expect(TodoSchema).toBeDefined();
    expect(typeof TodoSchema.parse).toBe("function");
  });

  it("exports AgentsMdSchema (Zod object)", () => {
    expect(AgentsMdSchema).toBeDefined();
    expect(typeof AgentsMdSchema.parse).toBe("function");
  });



  it("exports AgentsMdCard as a function", () => {
    expect(AgentsMdCard).toBeTypeOf("function");
  });

  it("adversarial iter-3 — barrel exports ALL named symbols with correct runtime kinds (every public export is defined and a function/Zod schema)", () => {
    // Gap: the barrel file re-exports ~30 symbols. A future refactor that
    // accidentally drops a named export (e.g. typos in the re-export name)
    // would break consumers at runtime. This test imports every public
    // export from the barrel and asserts none is undefined and each is
    // either a function (hook / converter / parser / component) or a
    // Zod-like object (with a `parse` method). If the implementation later
    // changes an export's shape (e.g. turns `parseDataPart` into a Zod
    // schema or vice versa), this assertion surfaces it.
    const barrel: Record<string, unknown> = {
      useDeepAgentsChat,
      generateId,
      PlanSchema,
      TaskSchema,
      FileSchema,
      ApprovalSchema,
      DataSubAgentSchema,
      DataHumanResponseSchema,
      DataErrorSchema,
      PlanSubtaskSchema,
      TodoItemSchema,
      TodoSchema,
      AgentsMdSchema,
      parseDataPart,
      partsToMessages,
      AgentsMdCard,
    };
    const requiredExports = Object.keys(barrel);
    const missing = requiredExports.filter(
      (name) => barrel[name] === undefined
    );
    expect(missing).toEqual([]);
    // Hooks/converter/parser/components must be functions
    const functionExports = [
      "useDeepAgentsChat",
      "generateId",
      "parseDataPart",
      "partsToMessages",
      "AgentsMdCard",
    ];
    for (const name of functionExports) {
      expect(typeof barrel[name]).toBe("function");
    }
    // Zod schemas must expose a `parse` method (ZodObject/ZodEnum/etc.)
    const schemaExports = [
      "PlanSchema",
      "TaskSchema",
      "FileSchema",
      "ApprovalSchema",
      "DataSubAgentSchema",
      "DataHumanResponseSchema",
      "DataErrorSchema",
      "PlanSubtaskSchema",
      "TodoItemSchema",
      "TodoSchema",
      "AgentsMdSchema",
    ];
    for (const name of schemaExports) {
      const s = barrel[name] as { parse?: unknown };
      expect(typeof s.parse).toBe("function");
    }
  });
});
