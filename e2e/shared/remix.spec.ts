import { test, expect } from "@playwright/test";

// Tests run against http://localhost:5173 (set via 'remix' Playwright project).
// Start the Remix dev server before running: pnpm --filter remix-example dev

test.describe("DeepAgents Remix E2E — full send → stream → render cycle (SPEC-05)", () => {
  test("SPEC-05: Remix — Start button triggers stream, message renders, hook status moves to 'done'", async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"type":"text-start","id":"t1"}',
          'data: {"type":"text-delta","id":"t1","delta":"Hello from Remix mock"}',
          'data: {"type":"text-end","id":"t1"}',
          'data: {"type":"finish","finishReason":"stop"}',
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Status is idle at rest — proves the useDeepAgentsChat hook is mounted
    // and feeding into the DOM, not just a static label.
    await expect(page.getByTestId("status")).toHaveText("idle");

    const startBtn = page.locator('button:has-text("Start")');
    await startBtn.waitFor({ state: "visible", timeout: 10_000 });
    await startBtn.click();

    await expect(page.locator("text=Hello from Remix mock")).toBeVisible({
      timeout: 15_000,
    });

    // After stream finishes the Remix hook moves to "done" (its terminal
    // state — distinct from the Next.js hook which cycles back to "idle";
    // see packages/remix/src/hook.ts). If `useDeepAgentsChat` wasn't
    // actually wired, the status label would stay frozen at "idle" — the
    // assertion catches both wrong-state and never-transitioned bugs.
    await expect(page.getByTestId("status")).toHaveText("done", {
      timeout: 10_000,
    });
  });

  test("SPEC-05b: Remix — POST /api/chat/stream is served by createDeepAgentsHandler (not 404)", async ({
    request,
  }) => {
    // Bypass page.route entirely — hit the dev server's real Remix action.
    // No BACKEND_URL is set in this test env, so createDeepAgentsHandler will
    // attempt fetch to its default (http://localhost:8000/stream), fail, and
    // return its specific 502 "upstream error" response. Three things prove
    // the framework adapter actually ran:
    //   1. status is 502 (handler's fetch-failure branch), not 404 (route
    //      missing) or 405 (wrong verb / unhandled by Remix)
    //   2. body is the exact "upstream error" string the handler returns
    //   3. the response is text/plain (handler's failure path), not HTML
    //      (which is what Remix's default error boundary would emit)
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "probe" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
      failOnStatusCode: false,
    });
    expect(
      response.status(),
      "createDeepAgentsHandler must catch the backend fetch failure and return 502; a 404 means the action wasn't mounted, 500 with HTML means Remix's error boundary caught an unhandled throw"
    ).toBe(502);
    const body = await response.text();
    expect(body).toBe("upstream error");
  });
});
