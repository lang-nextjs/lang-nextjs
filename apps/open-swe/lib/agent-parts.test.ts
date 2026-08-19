import { describe, it, expect } from "vitest";
import { collectAgentParts } from "./agent-parts";
import type { StreamEvent } from "./types";

const part = (type: string, data: Record<string, unknown>): StreamEvent =>
  ({ type, data } as StreamEvent);

describe("collectAgentParts", () => {
  it("ignores non-data and malformed parts", () => {
    const out = collectAgentParts([
      { type: "text-delta", delta: "hi" },
      { type: "tool-input-start", toolCallId: "t", toolName: "x", input: {} },
      part("data-plan", { id: "p", seq: 0 }), // missing required fields → dropped
    ]);
    expect(out.plan).toBeNull();
    expect(out.files).toEqual([]);
    expect(out.enrichedToolCallIds.size).toBe(0);
  });

  it("keeps the latest plan by seq and marks its id enriched", () => {
    const base = { id: "sp", title: "Plan", subtasks: [], updatedAt: "t" };
    const out = collectAgentParts([
      part("data-plan", { ...base, seq: 0, markdown: "v1" }),
      part("data-plan", { ...base, seq: 1, markdown: "v2" }),
    ]);
    expect(out.plan?.markdown).toBe("v2");
    expect(out.enrichedToolCallIds.has("sp")).toBe(true);
  });

  it("upserts a sub-agent starting → done by id", () => {
    const base = {
      id: "ta",
      parentToolCallId: "ta",
      name: "researcher",
      prompt: "go",
      startedAt: "t",
    };
    const out = collectAgentParts([
      part("data-sub-agent", { ...base, seq: 0, status: "starting" }),
      part("data-sub-agent", { ...base, seq: 1, status: "done", result: "r" }),
    ]);
    expect(out.subAgents).toHaveLength(1);
    expect(out.subAgents[0]!.status).toBe("done");
    expect(out.subAgents[0]!.result).toBe("r");
  });

  it("ADV: data-plan with empty markdown ('') is accepted and stored (schema permits zero-length body)", () => {
    // The PlanSchema declares markdown as z.string() — the empty string is a
    // valid string per Zod. If the agent emits a save_plan with an empty
    // body (e.g. user-cancelled before save_plan completed, or a tool that
    // produces a degenerate plan), collectAgentParts must NOT drop the part
    // and must NOT crash on the empty string. The id is still enriched so
    // the run page can hide the raw ToolCard. The renderer downstream is
    // responsible for handling empty markdown gracefully (e.g. showing a
    // placeholder).
    const out = collectAgentParts([
      part("data-plan", {
        id: "empty-plan",
        seq: 0,
        title: "Untitled",
        markdown: "",
        subtasks: [],
        updatedAt: "t",
      }),
    ]);
    expect(out.plan).not.toBeNull();
    expect(out.plan!.id).toBe("empty-plan");
    expect(out.plan!.markdown).toBe("");
    expect(out.plan!.title).toBe("Untitled");
    expect(out.enrichedToolCallIds.has("empty-plan")).toBe(true);
  });

  it("collects files and approvals, all ids enriched", () => {
    const out = collectAgentParts([
      part("data-file", {
        id: "f1",
        seq: 0,
        path: "/a.ts",
        name: "a.ts",
        size: 1,
        truncated: false,
        updatedAt: "t",
      }),
      part("data-approval", {
        id: "ap",
        seq: 1,
        actionName: "enter_plan_mode",
        description: "review",
        arguments: {},
        status: "waiting",
        createdAt: "t",
      }),
    ]);
    expect(out.files).toHaveLength(1);
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0]!.status).toBe("waiting");
    expect(out.enrichedToolCallIds.has("f1")).toBe(true);
    expect(out.enrichedToolCallIds.has("ap")).toBe(true);
  });
});
