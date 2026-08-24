import { test, expect } from "@playwright/test";

/**
 * Visual regression — pixel-diff against committed baselines.
 *
 * Runs in the `visual` project (chromium-only — screenshots are
 * engine-specific). Baselines live under e2e/visual.spec.ts-snapshots/
 * and are checked into git. To update after an intentional UI change:
 *
 *   pnpm exec playwright test --project=visual --update-snapshots
 *
 * Coverage: each rendered route's primary above-the-fold view + a
 * snapshot of every data-* card in isolation (rendered via mocked
 * SSE so the visual state is deterministic — no real network).
 *
 * Threshold: pixel-diff tolerance is Playwright default (~1% per
 * pixel, ~0.05% per image). Tighten via { maxDiffPixelRatio } if
 * baselines become too lenient.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
} as const;

function dataPartSse(type: string, data: Record<string, unknown>): string {
  return [
    `data: {"type":"start","messageId":"vmsg"}`,
    `data: {"type":"text-start","id":"vt"}`,
    `data: {"type":"text-delta","id":"vt","delta":"Here is the artifact."}`,
    `data: {"type":"text-end","id":"vt"}`,
    `data: ${JSON.stringify({ type, data })}`,
    `data: {"type":"finish","finishReason":"stop"}`,
    "",
  ].join("\n\n");
}

test.describe("Visual regression — page-level baselines", () => {
  test("/ (chat composer) above-the-fold", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("home-composer.png", {
      // Mask the timestamp/dynamic content if any appears.
      maxDiffPixelRatio: 0.01,
    });
  });

  test("/hitl-demo idle state", async ({ page }) => {
    await page.goto("/hitl-demo");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("hitl-demo-idle.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  // REMOVED (#14): "/open-swe (empty run list)".
  //
  // #29 deleted apps/example/app/open-swe/ — the embedded Open SWE rung. This
  // project's baseURL is apps/example, so the test was navigating to a route
  // that no longer exists and screenshotting a 404 page against a baseline of
  // the old dashboard. The subject is gone, so the test and its baseline go
  // with it rather than being re-pointed or re-baselined.
  //
  // The COVERAGE is a real gap: apps/open-swe's queue at `/` has no visual
  // regression test. That belongs in e2e/rungs/open-swe/ against
  // PLAYWRIGHT_OPENSWE_URL, not here — filed as follow-up, not smuggled in.
});

test.describe("Visual regression — card components (deterministic mocked SSE)", () => {
  const validPlan = {
    id: "vp1",
    seq: 1,
    title: "Migration Plan",
    markdown: "## Plan",
    subtasks: [
      { id: "s1", label: "Backup data", status: "done" },
      { id: "s2", label: "Run migration", status: "in-progress" },
      { id: "s3", label: "Verify indexes", status: "pending" },
    ],
    updatedAt: "2026-05-29T00:00:00Z",
  };

  test("PlanCard renders consistently", async ({ page }) => {
    await page.route("**/api/chat/stream", (route) =>
      route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: dataPartSse("data-plan", validPlan),
      })
    );
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox").fill("show plan");
    await page.keyboard.press("Enter");
    const card = page.getByTestId("plan-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveScreenshot("card-plan.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("TodoCard renders consistently", async ({ page }) => {
    const validTodo = {
      id: "vt1",
      seq: 1,
      items: [
        { id: "i1", text: "Set up CI pipeline", status: "done" },
        { id: "i2", text: "Write integration tests", status: "in-progress" },
        { id: "i3", text: "Deploy to staging", status: "pending" },
      ],
    };
    await page.route("**/api/chat/stream", (route) =>
      route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: dataPartSse("data-todo", validTodo),
      })
    );
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox").fill("show todos");
    await page.keyboard.press("Enter");
    const card = page.getByTestId("todo-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveScreenshot("card-todo.png", {
      maxDiffPixelRatio: 0.01,
    });
  });
});
