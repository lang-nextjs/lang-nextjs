import { test, expect } from "@playwright/test";

/**
 * E2E for the open-swe run page's AgentNarrative — the integration that renders
 * the full DeepAgents agent narrative (plan / files / sub-agents / HITL approval)
 * from the run's SSE stream. The SDK cards are unit-/e2e-tested in isolation
 * elsewhere (library-cards.spec.ts); this proves they're WIRED into the run page
 * and driven by the stream, plus the open-swe plan-approval POST flow.
 *
 * Like the other open-swe specs, the app's own /api/.../stream route is mocked
 * at the browser boundary with a pre-baked SSE body (the upstream LangGraph is
 * server-side and not reachable from the browser). Runs against the open-swe app
 * (PLAYWRIGHT_OPENSWE_URL, default :3001).
 */

const runId = "run-narr-1";
const threadId = "thread-narr-1";

// Build an SSE body from AI-SDK-v6 part envelopes ({type, data} for data-*).
function sseBody(parts: unknown[]): string {
  const lines: string[] = [];
  for (const p of parts) {
    lines.push(`data: ${JSON.stringify(p)}`, "");
  }
  lines.push("data: [DONE]", "", "");
  return lines.join("\n");
}

async function mockStream(page: import("@playwright/test").Page, parts: unknown[]) {
  // The run page loads thread state first and only live-streams when the run is
  // active. Mock state as "busy" (→ running) so it enters the streaming path,
  // then mock the stream itself with the data-* parts under test.
  await page.route(`**/api/open-swe/runs/${runId}/state*`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "busy", interrupts: null, messages: [], files: {} }),
    });
  });
  await page.route(`**/api/open-swe/runs/${runId}/stream*`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: sseBody(parts),
    });
  });
}

test.describe("open-swe run page — AgentNarrative", () => {
  test("renders Plan, File, and Sub-agent cards from data-* stream parts", async ({
    page,
  }) => {
    await mockStream(page, [
      {
        type: "data-plan",
        data: {
          id: "p1",
          seq: 0,
          title: "Implementation plan",
          markdown: "# Plan\n1. read\n2. edit",
          subtasks: [],
          updatedAt: "2026-06-27T00:00:00Z",
        },
      },
      {
        type: "data-file",
        data: {
          id: "f1",
          seq: 1,
          path: "/work/calc.py",
          name: "calc.py",
          language: "python",
          size: 42,
          truncated: false,
          content: "def add(a,b):\n  return a+b\n",
          updatedAt: "2026-06-27T00:00:00Z",
        },
      },
      {
        type: "data-sub-agent",
        data: {
          id: "s1",
          seq: 2,
          parentToolCallId: "s1",
          name: "researcher",
          status: "done",
          prompt: "investigate the repo",
          result: "found it",
          startedAt: "2026-06-27T00:00:00Z",
          finishedAt: "2026-06-27T00:00:01Z",
        },
      },
    ]);

    await page.goto(`/runs/${runId}?threadId=${threadId}`);

    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("plan-title")).toContainText("Implementation plan");
    await expect(page.getByTestId("file-card")).toBeVisible();
    await expect(page.getByTestId("file-path")).toContainText("/work/calc.py");
    await expect(page.getByTestId("sub-agent-card")).toBeVisible();
    await expect(page.getByTestId("sub-agent-name")).toContainText("researcher");
  });

  test("upserts a sub-agent from starting → done (last state wins, one card)", async ({
    page,
  }) => {
    await mockStream(page, [
      {
        type: "data-sub-agent",
        data: { id: "s9", seq: 0, parentToolCallId: "s9", name: "coder", status: "starting", prompt: "go", startedAt: "2026-06-27T00:00:00Z" },
      },
      {
        type: "data-sub-agent",
        data: { id: "s9", seq: 1, parentToolCallId: "s9", name: "coder", status: "done", prompt: "go", result: "ok", startedAt: "2026-06-27T00:00:00Z", finishedAt: "2026-06-27T00:00:02Z" },
      },
    ]);
    await page.goto(`/runs/${runId}?threadId=${threadId}`);
    // Upsert by id → exactly one sub-agent card, showing the latest (done) state.
    await expect(page.getByTestId("sub-agent-card")).toHaveCount(1);
    await expect(page.getByTestId("sub-agent-status")).toContainText(/done/i);
  });

  test("completed run renders conversation history — NOT an error", async ({
    page,
  }) => {
    // A finished run: thread state has the full message history. The page must
    // render it (no live stream, no EventSource error).
    await page.route(`**/api/open-swe/runs/${runId}/state*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "idle",
          interrupts: null,
          files: {},
          messages: [
            { type: "human", content: "Create circle.py with area(r)" },
            {
              type: "ai",
              content: "",
              tool_calls: [
                { id: "tc1", name: "write_file", args: { file_path: "/work/circle.py", content: "def area(r): ..." } },
              ],
            },
            { type: "tool", name: "write_file", tool_call_id: "tc1", content: "Updated file /work/circle.py" },
            { type: "ai", content: "Done — created circle.py with an area function." },
          ],
        }),
      });
    });
    // If the page wrongly tried to stream a finished run, this would fire.
    let streamHit = false;
    await page.route(`**/api/open-swe/runs/${runId}/stream*`, async (route) => {
      streamHit = true;
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
    });

    await page.goto(`/runs/${runId}?threadId=${threadId}`);

    await expect(page.getByTestId("conversation-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("conv-user")).toContainText("Create circle.py");
    await expect(page.getByTestId("conv-assistant")).toContainText("Done");
    await expect(page.getByTestId("conv-tool")).toContainText("write_file");
    // The whole point: no "error" surfaced for a completed run.
    await expect(page.getByTestId("stream-error")).toHaveCount(0);
    expect(streamHit).toBe(false);
  });

  test("plan-approval: ApprovalCard renders and Approve POSTs the decision", async ({
    page,
  }) => {
    await mockStream(page, [
      {
        type: "data-approval",
        data: {
          id: "a1",
          seq: 0,
          actionName: "enter_plan_mode",
          description: "Approve the plan before implementation?",
          arguments: {},
          status: "waiting",
          createdAt: "2026-06-27T00:00:00Z",
        },
      },
    ]);

    // Capture the plan-approval POST the ApprovalCard triggers.
    let postBody: Record<string, unknown> | null = null;
    await page.route(`**/api/open-swe/runs/${runId}/plan`, async (route) => {
      postBody = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: "run-followup", thread_id: threadId }),
      });
    });

    await page.goto(`/runs/${runId}?threadId=${threadId}`);
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("approve-button").click();

    await expect.poll(() => postBody).not.toBeNull();
    expect(postBody).toMatchObject({ threadId, decision: "approve" });
  });
});
