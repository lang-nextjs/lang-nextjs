// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentNarrative } from "./AgentNarrative";
import type { StreamEvent, ToolCallState } from "../lib/types";

const part = (type: string, data: Record<string, unknown>): StreamEvent =>
  ({ type, data } as StreamEvent);

const plan = part("data-plan", {
  id: "sp",
  seq: 0,
  title: "My Plan",
  markdown: "# Do the thing",
  subtasks: [],
  updatedAt: "t",
});
const file = part("data-file", {
  id: "wf",
  seq: 1,
  path: "/work/app.ts",
  name: "app.ts",
  size: 10,
  truncated: false,
  content: "x",
  updatedAt: "t",
});
const approval = part("data-approval", {
  id: "ep",
  seq: 2,
  actionName: "enter_plan_mode",
  description: "Approve the plan?",
  arguments: {},
  status: "waiting",
  createdAt: "t",
});

function renderNarrative(
  events: StreamEvent[],
  toolCalls: ToolCallState[] = []
) {
  return render(
    <AgentNarrative
      events={events}
      toolCalls={toolCalls}
      threadId="th-1"
      runId="run-1"
    />
  );
}

describe("AgentNarrative", () => {
  it("renders Plan, Files, and Approvals sections from data-* parts", () => {
    renderNarrative([plan, file, approval]);
    expect(screen.getByLabelText("Plan")).toBeTruthy();
    expect(screen.getByLabelText("Files")).toBeTruthy();
    expect(screen.getByLabelText("Approvals")).toBeTruthy();
  });

  it("hides the raw ToolCard for a tool that became a rich card, keeps others", () => {
    const tools: ToolCallState[] = [
      {
        toolCallId: "wf",
        toolName: "write_file",
        input: {},
        status: "completed",
      },
      {
        toolCallId: "ex",
        toolName: "execute",
        input: { command: "ls" },
        status: "completed",
      },
    ];
    renderNarrative([file], tools);
    // write_file (wf) is shown as a FileCard, not a ToolCard; execute remains.
    const toolSection = screen.getByLabelText("Tool calls");
    expect(toolSection.textContent).toContain("execute");
    expect(toolSection.textContent).not.toContain("write_file");
  });

  it("approving posts the decision to the plan route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ run_id: "r2" }), { status: 201 })
      );
    renderNarrative([approval]);

    // ApprovalCard's approve affordance — find a button whose label implies approve.
    const approveBtn = screen
      .getAllByRole("button")
      .find((b) => /approve|accept/i.test(b.textContent ?? ""));
    expect(approveBtn).toBeTruthy();
    fireEvent.click(approveBtn!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/open-swe/runs/run-1/plan");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      threadId: "th-1",
      decision: "approve",
    });
  });

  it("renders nothing structural when there are no parts", () => {
    const { container } = renderNarrative([
      { type: "text-delta", delta: "hi" },
    ]);
    expect(screen.queryByLabelText("Plan")).toBeNull();
    expect(
      container.querySelector('[data-testid="agent-narrative"]')
    ).toBeTruthy();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
