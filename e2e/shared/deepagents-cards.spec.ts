import { test, expect } from "@playwright/test";

/**
 * Client-side data-* card rendering for cards the DEEPAGENTS RUNG OWNS.
 *
 * OWNERSHIP — rungs.json assigns this file to the deepagents rung, so `pnpm
 * eject` down to any rung below 3 deletes it. Only put a case here if
 * rungs.json says a rung owns the component; cards no rung owns live in
 * `shared-cards.spec.ts` so they survive that eject. Five cases
 * (data-agents-md, data-task, data-human-response, data-approval, data-error)
 * moved there for exactly that reason.
 *
 * KNOWN MISALIGNMENT, left alone deliberately: the two data-plan cases below
 * exercise PlanCard, which rungs.json assigns to OPEN-SWE (rung 4), not
 * deepagents. It is harmless today because rung 4 requires rung 3, so any
 * eject that removes this file has already removed PlanCard — but the file
 * and the component still answer to different owners. Fixing it means moving
 * those cases to a rung-4 spec and amending rungs.json, which is a manifest
 * change and out of scope here.
 *
 * SCOPE — these are NOT end-to-end tests in the "real backend pipeline" sense:
 * every test mocks /api/chat/stream with a hand-crafted SSE body containing
 * the data-* parts under test, then asserts the matching card renders in the
 * example app's React tree. Coverage is:
 *   AI SDK v6 stream parser → custom schema map (packages/react/src/schemas.ts)
 *   → partsToMessages converter → card components in apps/example/app/page.tsx.
 *
 * NOT covered here:
 *   - The DeepAgents Python/TS backends actually emitting these frames
 *   - The proxy transforms in packages/server (no proxy is in the loop)
 *   - Auth, HITL drain, tool calls, or any error paths
 *
 * Why this lives in /e2e rather than packages/react/src/*.test.tsx: it
 * exercises the full streaming flow in a real Chromium browser (EventSource,
 * fetch response streaming, React 19 hydration), catching regressions the
 * jsdom unit tests miss. The "E2E" project label is a historical artefact;
 * real-backend coverage is in the e2e-django and e2e-fastapi CI jobs.
 *
 * AI SDK v6 wire format for data-* parts (from ui-message-chunks.ts):
 *   {"type":"data-plan","data":{...}}
 *   {"type":"data-todo","data":{...}}
 *   {"type":"data-agents-md","data":{...}}
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { SSE_HEADERS, makeDataPartsSseBody } from "./sse-fixtures";

const validPlan = {
  id: "plan-e2e",
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

const validTodo = {
  id: "todo-e2e",
  seq: 1,
  items: [
    { id: "i1", text: "Set up CI pipeline", status: "done" },
    { id: "i2", text: "Write integration tests", status: "in-progress" },
    { id: "i3", text: "Deploy to staging", status: "pending" },
  ],
};

const validFile = {
  id: "file-e2e",
  seq: 4,
  path: "/work/src/utils.ts",
  name: "utils.ts",
  language: "typescript",
  size: 4096,
  truncated: false,
  content: "export function add(a: number, b: number) { return a + b; }",
  updatedAt: "2026-05-25T00:00:00Z",
};

const validSubAgent = {
  id: "subagent-e2e",
  seq: 5,
  parentToolCallId: "tc-001",
  name: "researcher",
  status: "running",
  prompt: "Research the best testing frameworks for TypeScript",
  result: null,
  error: null,
  startedAt: "2026-05-25T00:00:00Z",
  finishedAt: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("DeepAgents client smoke — data-* card rendering (mocked SSE, no real backend)", () => {
  test("data-plan renders PlanCard with subtasks", async ({ page }) => {
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([{ type: "data-plan", data: validPlan }]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("show me a plan");
    await page.keyboard.press("Enter");

    // Bubble renders
    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toBeVisible({ timeout: 10_000 });
    // Title via data-testid (not just text substring)
    await expect(page.getByTestId("plan-title")).toContainText(
      "Migration Plan",
      { timeout: 10_000 }
    );
    // Subtask labels visible WITHIN the plan card — scoping here matters
    // because the input field, debug overlay, or a sibling bubble in the
    // example app could trivially echo "Backup data" and falsely satisfy a
    // page-wide text= match.
    await expect(planCard.getByText("Backup data")).toBeVisible();
    await expect(planCard.getByText("Run migration")).toBeVisible();
    await expect(planCard.getByText("Verify indexes")).toBeVisible();
  });

  test("data-todo renders TodoBubble with items", async ({ page }) => {
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([{ type: "data-todo", data: validTodo }]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("show me todos");
    await page.keyboard.press("Enter");

    // TodoCard renders with item count
    const todoBubble = page.getByTestId("todo-card");
    await expect(todoBubble).toBeVisible({ timeout: 10_000 });
    // Item text visible — scoped to the bubble so a debug echo or sibling
    // can't trivially satisfy the assertion.
    await expect(todoBubble.getByText("Set up CI pipeline")).toBeVisible();
    await expect(todoBubble.getByText("Write integration tests")).toBeVisible();
  });

  test("multiple data-* parts render in same stream", async ({ page }) => {
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([
          { type: "data-plan", data: validPlan },
          { type: "data-todo", data: validTodo },
        ]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("show me everything");
    await page.keyboard.press("Enter");

    // Both cards render — scope title check inside the plan card so it can't
    // be satisfied by a sibling or debug overlay echoing the same string.
    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toBeVisible({ timeout: 10_000 });
    await expect(planCard.getByText("Migration Plan")).toBeVisible();
    await expect(page.getByTestId("todo-card")).toBeVisible();
  });

  test("data-plan with all-done subtasks shows completed progress", async ({
    page,
  }) => {
    const completedPlan = {
      ...validPlan,
      subtasks: validPlan.subtasks.map((s) => ({ ...s, status: "done" })),
    };

    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([
          { type: "data-plan", data: completedPlan },
        ]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("completed plan");
    await page.keyboard.press("Enter");

    // PlanCard shows all done — scope every assertion to the card so a
    // debug echo or sibling can't satisfy them.
    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toBeVisible({ timeout: 10_000 });
    await expect(planCard.getByText("Migration Plan")).toBeVisible();
    // All 3 subtask labels are visible (the example app renders them as list items)
    await expect(planCard.getByText("Backup data")).toBeVisible();
    await expect(planCard.getByText("Run migration")).toBeVisible();
    await expect(planCard.getByText("Verify indexes")).toBeVisible();
  });

  test("data-file renders FileBubble with path, name, language, and size", async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([{ type: "data-file", data: validFile }]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("show me a file");
    await page.keyboard.press("Enter");

    const fileBubble = page.getByTestId("file-card");
    await expect(fileBubble).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("file-name")).toContainText("utils.ts");
    await expect(page.getByTestId("file-path")).toContainText(
      "/work/src/utils.ts"
    );
    // Language label scoped — "typescript" is generic enough to trivially
    // appear elsewhere (e.g. a syntax-mode picker or filename in the input).
    await expect(fileBubble.getByText("typescript")).toBeVisible();
    await expect(page.getByTestId("file-size")).toContainText("4.0 KB");
  });

  test("data-sub-agent renders SubAgentBubble with name and status", async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDataPartsSseBody([
          { type: "data-sub-agent", data: validSubAgent },
        ]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("show me a sub agent");
    await page.keyboard.press("Enter");

    const subAgent = page.getByTestId("sub-agent-card");
    await expect(subAgent).toBeVisible({ timeout: 10_000 });
    // Scoped so a debug overlay or sibling status badge can't satisfy these
    // (both "researcher" and "running" are short and would collide easily).
    await expect(subAgent.getByText("researcher")).toBeVisible();
    await expect(subAgent.getByText("running")).toBeVisible();
  });
});
