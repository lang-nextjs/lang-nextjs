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
 * NO PRODUCER IN PRODUCT CODE. Stated precisely, because the looser phrasing
 * ("zero emitters anywhere") is wrong and was rejected once: both tags ARE in
 * the published schema and ARE widely referenced. What is absent is anything
 * that CONSTRUCTS the frame outside a test.
 *
 * Verified per-surface, with `data-plan` as the working control (it maps
 * upstream `save_plan` at openSweEnrich.ts:218 and is handled at
 * agent-parts.ts:45):
 *
 *   packages/server/src        data-plan: yes    data-task / data-agents-md: none
 *   packages/react/src         schema registration only, no construction
 *   apps/<app>/lib, app/       type aliases and `msg.type === ...` checks only
 *   Python backends            emit NO data-* parts at all — every data-* frame
 *                              in this product is synthesised by a TS adapter
 *
 * So every test below hand-crafts the frame it then asserts on, which makes
 * this a RENDERER contract test: given a well-formed part, the card renders it.
 * It is not evidence that the part is reachable or ever emitted. Green here
 * must not be read as #50 being resolved. The parts stay declared on purpose —
 * deleting them would silently narrow a schema this repo publishes.
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
  // A NORMAL backend error, so it looks like one. django and fastapi both set
  // `origin`, and this fixture stands in for them: its subject is that
  // ErrorBubble renders code, message and the retryable badge, not attribution.
  // The deliberately UNATTRIBUTED case lives in chat-settings.spec.ts (#433).
  origin: "backend",
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

  test("a part the converter CANNOT read is visible, not silent (#520)", async ({
    page,
  }) => {
    /*
     * `partsToMessages` substitutes a `type: "unreadable"` message for a part it
     * cannot read — it does not drop silently. That signal existed and THIS
     * SHELL DISCARDED IT: open-swe rendered it, the example app had no branch,
     * so a dropped part produced nothing at all here.
     *
     * Found the hard way rather than by reading: a required-field change
     * schema-rejected a data-error fixture and this file failed looking for
     * `error-bubble` with no bubble, no indicator and no trace — an error frame
     * vanished and the surface said the run was fine.
     *
     * `data-error` with a `retryable` of the wrong type is rejected by the
     * REGISTERED schema, which is the `schema-rejected` reason rather than
     * `unknown-type`: the app knows this part and cannot read this instance.
     */
    await streamPart(
      page,
      {
        type: "data-error",
        data: {
          id: "bad-1",
          seq: 0,
          code: "llm_timeout",
          message: "Model did not respond",
          retryable: "yes-please",
        },
      },
      "show me an unreadable part"
    );

    const unreadable = page.getByTestId("unreadable-bubble");
    await expect(unreadable).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("unreadable-part-type")).toHaveText(
      "data-error"
    );
    await expect(page.getByTestId("unreadable-reason")).toHaveText(
      "schema-rejected"
    );
    // And the thing it stood in for did NOT render, so the two are not confused.
    await expect(page.getByTestId("error-bubble")).toHaveCount(0);
  });

  test("A READABLE PART RENDERS WITH NO UNREADABLE ARTEFACT (#520 companion)", async ({
    page,
  }) => {
    /*
     * THE LOAD-BEARING HALF. Without it the fix is satisfied by a shell that
     * shows an "unreadable" notice on every turn — the positive case above
     * cannot tell that apart from a working one. "Something appeared" is not the
     * property; the property is that the artefact appears ONLY when a part could
     * not be read.
     */
    await streamPart(
      page,
      { type: "data-error", data: validError },
      "show me a readable error"
    );

    await expect(page.getByTestId("error-bubble")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("unreadable-bubble")).toHaveCount(0);
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
