import { test, expect } from "@playwright/test";

/**
 * E2E: topology selector behavior in the example app.
 *
 * The agent matrix has three axes — runtime × aiBackend × topology.
 * This spec isolates the topology axis: it verifies the selector forwards
 * `body.topology` to the proxy and that plan-execute responses render.
 *
 * Backend calls are mocked via page.route, so the suite runs in the chromium
 * project without Django/FastAPI containers or an LLM key. The real-backend
 * counterpart lives in the e2e-django / e2e-fastapi CI jobs.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
};

/** Join SSE frames the way a real text/event-stream body is framed. */
function sseBody(frames: string[]): string {
  return [...frames, ""].join("\n\n");
}

/** Minimal AI SDK v6 text response: start → delta → end → finish. */
function textResponse(text: string): string {
  return sseBody([
    'data: {"type":"text-start","id":"t1"}',
    `data: {"type":"text-delta","id":"t1","delta":${JSON.stringify(text)}}`,
    'data: {"type":"text-end","id":"t1"}',
    'data: {"type":"finish","finishReason":"stop"}',
  ]);
}

test.describe("Topology selector", () => {
  test.beforeEach(async ({ page }) => {
    // Advertise both Python backends as configured so the django/fastapi
    // buttons stay enabled regardless of the dev server's env.
    await page.route("**/api/config*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ backends: { django: true, fastapi: true } }),
      })
    );
  });

  test("default topology is react — first request carries topology:react", async ({
    page,
  }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/chat/stream", async (route) => {
      bodies.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: textResponse("ok"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox").fill("hello");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].topology).toBe("react");
  });

  test("switching to plan-execute sends topology:plan-execute", async ({
    page,
  }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/chat/stream", async (route) => {
      bodies.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: textResponse("planned"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("button", { name: "plan-execute", exact: true })
      .click();
    await page.getByRole("textbox").fill("do a plan");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });

    expect(bodies[0].topology).toBe("plan-execute");
  });

  test("switching back to react sends topology:react", async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/chat/stream", async (route) => {
      bodies.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: textResponse("ok"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // react → plan-execute → react: the toggle must land back on react.
    await page
      .getByRole("button", { name: "plan-execute", exact: true })
      .click();
    await page.getByRole("button", { name: "react", exact: true }).click();
    await page.getByRole("textbox").fill("hello again");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });

    expect(bodies[0].topology).toBe("react");
  });

  // [removed] "plan-execute response renders streamed text and via label"
  // was redundant with the next test: a plain-text mock can't distinguish
  // plan-execute from react topology, so the only signal was the cosmetic
  // "via" label. The PlanCard test below proves plan-execute did something
  // topology-specific (a data-plan frame surfaces a plan card), which is
  // the stronger and sufficient assertion.

  test("plan-execute renders PlanCard on a data-plan frame", async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", async (route) => {
      await route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: sseBody([
          'data: {"type":"text-start","id":"t1"}',
          'data: {"type":"text-delta","id":"t1","delta":"Here is the plan"}',
          'data: {"type":"text-end","id":"t1"}',
          'data: {"type":"data-plan","data":{"id":"p1","seq":1,"title":"Plan-Execute Plan","markdown":"## Plan","subtasks":[{"id":"s1","label":"increment counter","status":"pending"},{"id":"s2","label":"read counter","status":"pending"}],"updatedAt":"2026-05-19T00:00:00Z"}}',
          'data: {"type":"finish","finishReason":"stop"}',
        ]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("button", { name: "plan-execute", exact: true })
      .click();
    await page.getByRole("textbox").fill("increment then read");
    await page.keyboard.press("Enter");

    const planCard = page.locator('[data-testid="plan-card"]');
    await expect(planCard).toBeVisible({ timeout: 10_000 });
    await expect(planCard).toContainText("Plan-Execute Plan");
    await expect(planCard).toContainText("increment counter");
  });
});
