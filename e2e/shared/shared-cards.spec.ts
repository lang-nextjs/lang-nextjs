import { test, expect } from "@playwright/test";
import { SSE_HEADERS, makeDataPartsSseBody } from "./sse-fixtures";

/**
 * Card rendering for the data-* parts NO RUNG OWNS.
 *
 * WHY THIS FILE EXISTS (severability). These assertions used to live in
 * `deepagents-cards.spec.ts`, which rungs.json assigns to the deepagents rung
 * — so `pnpm eject` down to any rung below 3 deleted them. The cards they
 * cover survive that eject, which meant coverage disappeared for a reason
 * unrelated to the rung being dropped. Ownership per rungs.json:
 *
 *   AgentsMdCard        no rung  -> here
 *   TaskCard            no rung  -> here
 *   ApprovalCard        no rung  -> here
 *   HumanResponseCard   no rung  -> here
 *   error bubble        rendered inline by apps/example/app/page.tsx (shared)
 *
 *   TodoCard / FileCard / SubAgentCard   deepagents -> stay in the rung spec
 *   PlanCard                             open-swe   -> see the note below
 *
 * Add a case here only when rungs.json says no rung owns the component. The
 * manifest is the authority; the directory name is not.
 *
 * WHAT THIS DOES NOT PROVE (issue #50). `data-task` and `data-agents-md` have
 * ZERO emitters anywhere in the repo — no backend, adapter, or transform
 * produces them. Every test below hand-crafts the frame it then asserts on.
 * That makes this a renderer contract test: given a well-formed part, the card
 * renders it. It is NOT evidence that the part is real, reachable, or ever
 * emitted in production. Moving these assertions into a shared file does not
 * change that, and green here must not be read as #50 being resolved.
 *
 * SCOPE otherwise matches deepagents-cards.spec.ts: /api/chat/stream is mocked,
 * no proxy and no backend are in the loop, and the path under test is
 * AI SDK v6 parser -> schema map -> partsToMessages -> card component.
 */

const validAgentsMd = {
  id: "amd-e2e",
  seq: 2,
  content:
    "# Project Guidelines\n\n- Use TypeScript for all new files\n- Run linters before committing",
  path: "AGENTS.md",
};

const validTask = {
  id: "task-e2e",
  seq: 3,
  taskName: "Write tests",
  status: "in-progress",
  description: "Add unit tests for the converter module",
  groupLabel: "Testing",
};

const validHumanResponse = {
  id: "hr-e2e",
  seq: 6,
  response: "I approve of the changes. Please proceed.",
  createdAt: "2026-05-25T00:00:00Z",
};

const validApproval = {
  id: "approval-e2e",
  seq: 7,
  actionName: "delete_repository",
  description: "Delete the target repository and all its data",
  arguments: { repo: "old-monorepo", confirm: true },
  status: "waiting",
  createdAt: "2026-05-25T00:00:00Z",
  expiresAt: null,
};

const validError = {
  id: "error-e2e",
  seq: 8,
  code: "llm_timeout",
  message: "Model did not respond within 30 seconds",
  retryable: true,
  cause: { model: "claude-3-5-sonnet", region: "us-east-1" },
};

/** Mock /api/chat/stream with a single data-* part, then send a prompt. */
async function streamPart(
  page: import("@playwright/test").Page,
  part: { type: string; data: Record<string, unknown> },
  prompt: string
): Promise<void> {
  await page.route("**/api/chat/stream", (route) => {
    void route.fulfill({
      status: 200,
      headers: { ...SSE_HEADERS },
      body: makeDataPartsSseBody([part]),
    });
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.getByRole("textbox").fill(prompt);
  await page.keyboard.press("Enter");
}

test.describe("Shared card rendering — data-* parts no rung owns (mocked SSE, no real backend)", () => {
  test("data-agents-md renders AgentsMdBubble", async ({ page }) => {
    await streamPart(
      page,
      { type: "data-agents-md", data: validAgentsMd },
      "show agents md"
    );

    // AgentsMdCard renders with path
    const agentsMd = page.getByTestId("agents-md-card");
    await expect(agentsMd).toBeVisible({ timeout: 10_000 });
    await expect(agentsMd.getByTestId("agents-md-path")).toContainText(
      "AGENTS.md"
    );
    // The published AgentsMdCard keeps content behind a "Show content" toggle.
    // Expand it, then assert the body — scoped so a sidebar listing AGENTS.md
    // or a code-fence snippet can't satisfy the assertion.
    await agentsMd.getByTestId("agents-md-expand-button").click();
    await expect(agentsMd.getByText(/Use TypeScript/)).toBeVisible();
  });

  test("data-task renders TaskBubble with name, status, description, and group", async ({
    page,
  }) => {
    await streamPart(
      page,
      { type: "data-task", data: validTask },
      "show me a task"
    );

    const taskBubble = page.getByTestId("task-card");
    await expect(taskBubble).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("task-name")).toContainText("Write tests");
    await expect(page.getByTestId("task-status")).toContainText("in-progress");
    // Description + group scoped to the bubble — "Testing" especially is
    // generic and would trivially match elsewhere on the page.
    await expect(
      taskBubble.getByText("Add unit tests for the converter module")
    ).toBeVisible();
    await expect(taskBubble.getByText("Testing")).toBeVisible();
  });

  test("data-human-response renders HumanResponseBubble with reply text", async ({
    page,
  }) => {
    await streamPart(
      page,
      { type: "data-human-response", data: validHumanResponse },
      "show me a human response"
    );

    const hrBubble = page.getByTestId("human-response-card");
    await expect(hrBubble).toBeVisible({ timeout: 10_000 });
    await expect(
      hrBubble.getByText("I approve of the changes. Please proceed.")
    ).toBeVisible();
  });

  test("data-approval renders ApprovalBubble with action name and description", async ({
    page,
  }) => {
    await streamPart(
      page,
      { type: "data-approval", data: validApproval },
      "show me an approval"
    );

    const approval = page.getByTestId("approval-card");
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval.getByText("delete_repository")).toBeVisible();
    // "waiting" is short — scoping prevents collision with status pills
    // elsewhere in the example app shell.
    await expect(approval.getByText("waiting")).toBeVisible();
    await expect(
      approval.getByText("Delete the target repository and all its data")
    ).toBeVisible();
  });

  test("data-error renders ErrorBubble with code, message, and retryable badge", async ({
    page,
  }) => {
    await streamPart(
      page,
      { type: "data-error", data: validError },
      "show me an error"
    );

    const errorBubble = page.getByTestId("error-bubble");
    await expect(errorBubble).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("error-code")).toContainText("llm_timeout");
    await expect(
      errorBubble.getByText("Model did not respond within 30 seconds")
    ).toBeVisible();
    // "retryable" badge scoped to the bubble — the word is generic enough
    // to appear in dev tools, debug panes, or other error UIs.
    await expect(errorBubble.getByText("retryable")).toBeVisible();
  });
});
