import { test, expect, type Page } from "@playwright/test";

/**
 * CARD RENDERING ON THE /chat SURFACE (#330).
 *
 * open-swe's chat page registers ten `data-*` schemas and renders each through
 * its own branch. Before this file, exactly one of those cards — `approval-card`
 * — was asserted by any spec that visits `/chat`. The rest had no coverage on
 * this surface at all.
 *
 * WHY THE EXISTING COVERAGE DID NOT COUNT, since a match count says otherwise:
 * `open-swe-narrative.spec.ts` asserts plan, file and sub-agent cards, and it
 * drives the RUN PAGE — `AgentNarrative`, fed from
 * /api/open-swe/runs/{id}/stream. Different surface, different component tree,
 * different data path. Grepping the open-swe suite for `plan-card` finds it and
 * tells you nothing about `/chat`. That mistake is written up on #328.
 *
 * SCOPE. Each test mocks /api/chat/stream with a hand-built AI-SDK-v6 body and
 * asserts the matching card renders. Coverage is:
 *   stream parser → schema map (page.tsx) → render dispatch → card component.
 * NOT covered: the Python backends emitting these frames, the packages/server
 * transforms that synthesise most of them, or any live upstream.
 *
 * ADDITIVE, DELIBERATELY. `e2e/shared/` covers the same cards for the example
 * app and must keep doing so: apps/example is `shared` in rungs.json while
 * apps/open-swe is owned by rung 4, so a rung-1/2/3 fork deletes this file and
 * keeps those. Coverage moved out of `shared` is coverage a fork loses (#153).
 */

const SSE = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

async function mockShell(page: Page) {
  await page.route(
    "**/api/config",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          activeLlm: "nvidia",
          backends: { django: true, fastapi: true },
        }),
      })
  );
  await page.route(
    "**/api/chat/tools**",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tools: [], mcpServers: [] }),
      })
  );
}

/** Stream `parts` as a complete assistant turn, then open /chat and send. */
async function streamParts(page: Page, parts: unknown[]) {
  await mockShell(page);
  await page.route(
    "**/api/chat/stream",
    (route) =>
      void route.fulfill({
        status: 200,
        headers: { ...SSE },
        body:
          [
            `data: {"type":"start","messageId":"m1"}`,
            `data: {"type":"text-start","id":"t1"}`,
            `data: {"type":"text-delta","id":"t1","delta":"Here you go."}`,
            `data: {"type":"text-end","id":"t1"}`,
            ...parts.map((p) => `data: ${JSON.stringify(p)}`),
            `data: {"type":"finish","finishReason":"stop"}`,
          ].join("\n\n") + "\n\n",
      })
  );
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-input").fill("show me the artifacts");
  await page.getByTestId("chat-send").click();
}

const ts = "2026-08-29T00:00:00Z";

test.describe("open-swe /chat — every registered data-* part renders its card", () => {
  test("data-plan renders PlanCard", async ({ page }) => {
    await streamParts(page, [
      {
        type: "data-plan",
        data: {
          id: "p1",
          seq: 0,
          title: "Migration plan",
          markdown: "# Plan\n1. read\n2. edit",
          subtasks: [{ id: "s1", label: "Back up data", status: "done" }],
          updatedAt: ts,
        },
      },
    ]);
    const card = page.getByTestId("plan-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Migration plan");
  });

  test("data-task renders TaskCard with name, status and group", async ({
    page,
  }) => {
    await streamParts(page, [
      {
        type: "data-task",
        data: {
          id: "t1",
          seq: 0,
          taskName: "Write tests",
          status: "in-progress",
          description: "Add unit tests for the converter module",
          groupLabel: "Testing",
        },
      },
    ]);
    const card = page.getByTestId("task-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("task-name")).toContainText("Write tests");
    // Scoped to the card: "Testing" is generic enough to match the page chrome.
    await expect(card.getByText("Testing")).toBeVisible();
  });

  test("data-file renders FileCard with its path", async ({ page }) => {
    await streamParts(page, [
      {
        type: "data-file",
        data: {
          id: "f1",
          seq: 0,
          path: "/work/src/utils.ts",
          name: "utils.ts",
          language: "typescript",
          size: 4096,
          truncated: false,
          content: "export const add = (a: number, b: number) => a + b;\n",
          updatedAt: ts,
        },
      },
    ]);
    const card = page.getByTestId("file-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("utils.ts");
  });

  test("data-todo renders TodoCard with every item", async ({ page }) => {
    await streamParts(page, [
      {
        type: "data-todo",
        data: {
          id: "td1",
          seq: 0,
          items: [
            { id: "i1", text: "Set up CI", status: "done" },
            {
              id: "i2",
              text: "Write integration tests",
              status: "in-progress",
            },
            { id: "i3", text: "Deploy to staging", status: "pending" },
          ],
        },
      },
    ]);
    const card = page.getByTestId("todo-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    // The COUNT, not just visibility: a card that renders one of three items
    // looks correct in a screenshot and is not.
    await expect(card.getByTestId("todo-item")).toHaveCount(3);
  });

  test("data-agents-md renders AgentsMdCard", async ({ page }) => {
    await streamParts(page, [
      {
        type: "data-agents-md",
        data: {
          id: "am1",
          seq: 0,
          path: "/work/AGENTS.md",
          content: "# Agents\nConventions for this repo.",
        },
      },
    ]);
    const card = page.getByTestId("agents-md-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("AGENTS.md");
  });

  test("data-sub-agent renders SubAgentCard with name and status", async ({
    page,
  }) => {
    await streamParts(page, [
      {
        type: "data-sub-agent",
        data: {
          id: "sa1",
          seq: 0,
          parentToolCallId: "tc-parent",
          name: "researcher",
          status: "running",
          prompt: "Find prior art for the migration",
          startedAt: ts,
        },
      },
    ]);
    const card = page.getByTestId("sub-agent-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("sub-agent-name")).toContainText(
      "researcher"
    );
  });

  test("data-human-response renders HumanResponseCard with the reply text", async ({
    page,
  }) => {
    /*
     * THIS TEST FAILED WHEN IT WAS WRITTEN, and that is the point of it.
     *
     * `data-human-response` was registered in the schema map and dispatched
     * nowhere, so the frame was parsed and dropped — the identical state
     * `data-agents-md` had been in, in the same file. It was reachable: the
     * Respond affordance on ApprovalCard resolves an approval as `responded`
     * and the gating transform emits this frame. A person typed a reply to the
     * agent and the screen did not change.
     *
     * The structural half of the fix is schema-dispatch-parity.test.ts, which
     * compares the two lists so a third orphan fails a test rather than
     * vanishing. This case is the user-visible half.
     */
    await streamParts(page, [
      {
        type: "data-human-response",
        data: {
          id: "hr1",
          seq: 0,
          response: "Use the staging bucket, not production.",
          createdAt: ts,
        },
      },
    ]);
    const card = page.getByTestId("human-response-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Use the staging bucket, not production.");
  });

  test("several parts in one turn all render, none swallowing another", async ({
    page,
  }) => {
    /*
     * Each case above streams ONE part, so any of them would still pass if the
     * dispatch returned early after the first card. The real stream carries
     * several.
     */
    await streamParts(page, [
      {
        type: "data-todo",
        data: {
          id: "td2",
          seq: 0,
          items: [{ id: "i1", text: "x", status: "done" }],
        },
      },
      {
        type: "data-task",
        data: {
          id: "t2",
          seq: 1,
          taskName: "Ship it",
          status: "pending",
          description: "Cut the release",
          groupLabel: "Release",
        },
      },
      {
        type: "data-human-response",
        data: {
          id: "hr2",
          seq: 2,
          response: "Approved, proceed.",
          createdAt: ts,
        },
      },
    ]);
    await expect(page.getByTestId("todo-card")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("task-card")).toBeVisible();
    await expect(page.getByTestId("human-response-card")).toBeVisible();
  });
});
