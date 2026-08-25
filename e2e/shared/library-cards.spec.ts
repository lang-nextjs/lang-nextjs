import { test, expect } from "@playwright/test";

/**
 * Published-component dogfooding (browser smoke).
 *
 * The example app's main page renders the EXPORTED @deepagents-nextjs/react
 * cards (PlanCard, TaskCard, FileCard, ApprovalCard, SubAgentCard,
 * HumanResponseCard, TodoCard, AgentsMdCard) — not bespoke re-implementations.
 * This spec covers the behaviours that only the published components provide
 * and that deepagents-cards.spec.ts (rendering smoke) does not:
 *
 *   - PlanProgress: the progress bar PlanCard renders internally. It was an
 *     exported component with ZERO demo/coverage before the dogfooding change.
 *   - Expand affordances: FileCard / AgentsMdCard / SubAgentCard hide their
 *     bodies behind toggles — exercise the open path.
 *   - PlanCard per-subtask status data attributes.
 *   - ApprovalCard's interactive approve/reject affordances on the main page.
 *
 * Same mechanism as deepagents-cards.spec.ts: mock /api/chat/stream with a
 * hand-crafted SSE body, drive the example app in a real browser.
 *
 * ONE CAVEAT (issue #50). The AgentsMdCard case below constructs a
 * `data-agents-md` frame, and NOTHING IN PRODUCT CODE PRODUCES THAT PART —
 * the only constructors are fixtures like the one on that test. So that case
 * proves the expand affordance works given a well-formed part; it is not
 * evidence the part is ever emitted. Same applies to any `data-task` case
 * added here later. See e2e/shared/shared-cards.spec.ts for the full
 * per-surface measurement.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
} as const;

function makeDataPartsSseBody(
  dataParts: { type: string; data: Record<string, unknown> }[],
  text = "Here are the artifacts."
): string {
  const events: string[] = [
    `data: {"type":"start","messageId":"msg-libcards"}`,
    `data: {"type":"text-start","id":"t1"}`,
    `data: {"type":"text-delta","id":"t1","delta":"${text}"}`,
    `data: {"type":"text-end","id":"t1"}`,
  ];
  for (const part of dataParts) {
    events.push(`data: ${JSON.stringify(part)}`);
  }
  events.push(`data: {"type":"finish","finishReason":"stop"}`);
  return events.join("\n\n") + "\n\n";
}

const planOneOfThree = {
  id: "plan-lib",
  seq: 0,
  title: "Migration Plan",
  markdown: "# Plan\nMigrate the database.",
  subtasks: [
    { id: "s1", label: "Backup data", status: "done" },
    { id: "s2", label: "Run migration", status: "in-progress" },
    { id: "s3", label: "Verify indexes", status: "pending" },
  ],
  updatedAt: "2026-05-25T00:00:00Z",
};

const planAllDone = {
  ...planOneOfThree,
  subtasks: planOneOfThree.subtasks.map((s) => ({ ...s, status: "done" })),
};

const fileWithContent = {
  id: "file-lib",
  seq: 1,
  path: "/work/src/utils.ts",
  name: "utils.ts",
  language: "typescript",
  size: 4096,
  truncated: false,
  content: "export function add(a: number, b: number) { return a + b; }",
  updatedAt: "2026-05-25T00:00:00Z",
};

const agentsMd = {
  id: "amd-lib",
  seq: 2,
  content:
    "# Project Guidelines\n\n- Use TypeScript for all new files\n- Run linters before committing",
  path: "AGENTS.md",
};

const subAgentWithPrompt = {
  id: "subagent-lib",
  seq: 3,
  parentToolCallId: "tc-001",
  name: "researcher",
  status: "running",
  prompt: "Research the best testing frameworks for TypeScript",
  result: null,
  error: null,
  startedAt: "2026-05-25T00:00:00Z",
  finishedAt: null,
};

const approvalWaiting = {
  id: "approval-lib",
  seq: 4,
  actionName: "delete_repository",
  description: "Delete the target repository and all its data",
  arguments: { repo: "old-monorepo", confirm: true },
  status: "waiting",
  createdAt: "2026-05-25T00:00:00Z",
  expiresAt: null,
};

async function sendArtifacts(
  page: import("@playwright/test").Page,
  parts: { type: string; data: Record<string, unknown> }[],
  prompt: string
) {
  await page.route("**/api/chat/stream", (route) => {
    void route.fulfill({
      status: 200,
      headers: { ...SSE_HEADERS },
      body: makeDataPartsSseBody(parts),
    });
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox").fill(prompt);
  await page.keyboard.press("Enter");
}

test.describe("Published @deepagents-nextjs/react cards — dogfooded in example app", () => {
  test("PlanCard renders PlanProgress: progressbar role, value, and 'Step X of Y'", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-plan", data: planOneOfThree }],
      "show me a plan"
    );

    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toBeVisible({ timeout: 10_000 });

    // PlanProgress is rendered inside PlanCard — this is the component that had
    // no demo/coverage before dogfooding.
    const progress = planCard.getByTestId("plan-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toHaveRole("progressbar");
    // 1 of 3 subtasks done → 33%.
    await expect(progress).toHaveAttribute("aria-valuenow", "33");
    await expect(planCard.getByTestId("plan-progress-text")).toContainText(
      "Step 1 of 3"
    );
  });

  test("PlanProgress reaches 100% when every subtask is done", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-plan", data: planAllDone }],
      "completed plan"
    );

    const progress = page.getByTestId("plan-card").getByTestId("plan-progress");
    await expect(progress).toBeVisible({ timeout: 10_000 });
    await expect(progress).toHaveAttribute("aria-valuenow", "100");
    await expect(page.getByTestId("plan-progress-text")).toContainText(
      "Step 3 of 3"
    );
  });

  test("PlanCard exposes per-subtask status as data attributes", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-plan", data: planOneOfThree }],
      "show me a plan"
    );

    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toBeVisible({ timeout: 10_000 });

    const subtasks = planCard.getByTestId("plan-subtask");
    await expect(subtasks).toHaveCount(3);
    await expect(subtasks.nth(0)).toHaveAttribute(
      "data-subtask-status",
      "done"
    );
    await expect(subtasks.nth(1)).toHaveAttribute(
      "data-subtask-status",
      "in-progress"
    );
    await expect(subtasks.nth(2)).toHaveAttribute(
      "data-subtask-status",
      "pending"
    );
  });

  test("FileCard hides content until 'Show contents' is clicked", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-file", data: fileWithContent }],
      "show me a file"
    );

    const fileCard = page.getByTestId("file-card");
    await expect(fileCard).toBeVisible({ timeout: 10_000 });
    // Body is collapsed by default.
    await expect(fileCard.getByTestId("file-content")).toHaveCount(0);

    await fileCard.getByTestId("file-expand-button").click();
    await expect(fileCard.getByTestId("file-content")).toContainText(
      "export function add"
    );
  });

  test("AgentsMdCard hides content until 'Show content' is clicked", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-agents-md", data: agentsMd }],
      "show agents md"
    );

    const card = page.getByTestId("agents-md-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("agents-md-content")).toHaveCount(0);

    await card.getByTestId("agents-md-expand-button").click();
    await expect(card.getByTestId("agents-md-content")).toContainText(
      "Use TypeScript"
    );
  });

  test("SubAgentCard reveals the prompt through its expand toggles", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-sub-agent", data: subAgentWithPrompt }],
      "show me a sub agent"
    );

    const card = page.getByTestId("sub-agent-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Status visible in the collapsed header.
    await expect(card.getByTestId("sub-agent-status")).toContainText("running");

    // Drill in: details → prompt.
    await card.getByTestId("sub-agent-expand-button").click();
    await card.getByTestId("sub-agent-prompt-toggle").click();
    await expect(card.getByTestId("sub-agent-prompt")).toContainText(
      "Research the best testing frameworks"
    );
  });

  test("ApprovalCard renders interactive approve/reject affordances", async ({
    page,
  }) => {
    await sendArtifacts(
      page,
      [{ type: "data-approval", data: approvalWaiting }],
      "show me an approval"
    );

    const approval = page.getByTestId("approval-card");
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval.getByTestId("approval-action-name")).toContainText(
      "delete_repository"
    );
    // The published card is interactive — buttons are enabled while waiting.
    // (deepagents-cards.spec.ts only asserted the inline display markup.)
    await expect(approval.getByTestId("approve-button")).toBeEnabled();
    await expect(approval.getByTestId("reject-button")).toBeEnabled();
    // Arguments are surfaced verbatim by ApprovalCard.
    await expect(approval.getByTestId("approval-arguments")).toContainText(
      "old-monorepo"
    );
  });
});
