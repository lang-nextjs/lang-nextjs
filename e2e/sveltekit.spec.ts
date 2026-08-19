import { test, expect } from "@playwright/test";

// Tests run against http://localhost:5174 (set via 'sveltekit' Playwright project).
// Start the SvelteKit dev server before running: pnpm --filter sveltekit-example dev

test.describe("DeepAgents SvelteKit E2E — full send → stream → render cycle (E2E-06)", () => {
  test("E2E-06: SvelteKit — Start button triggers stream, message renders, store moves to 'done'", async ({
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
          'data: {"type":"text-delta","id":"t1","delta":"Hello from SvelteKit mock"}',
          'data: {"type":"text-end","id":"t1"}',
          'data: {"type":"finish","finishReason":"stop"}',
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Status is idle at rest — proves the reactive store is mounted and
    // surfacing into the DOM via $chat.status, not a hardcoded literal.
    await expect(page.getByTestId("status")).toHaveText("idle");

    const startBtn = page.locator('button:has-text("Start")');
    await startBtn.waitFor({ state: "visible", timeout: 10_000 });
    await startBtn.click();

    await expect(page.locator("text=Hello from SvelteKit mock")).toBeVisible({
      timeout: 15_000,
    });

    // After the stream finishes the store moves to "done" (see store.ts:73).
    // The previous version only proved text rendered — this asserts the
    // reactive store actually transitioned, which only the real
    // createDeepAgentsStore can do.
    await expect(page.getByTestId("status")).toHaveText("done", {
      timeout: 10_000,
    });
  });

  test("E2E-06b: SvelteKit — POST /api/chat/stream is served by createDeepAgentsHandler (not 404)", async ({
    request,
  }) => {
    // Bypass page.route — hit the SvelteKit dev server's real +server.ts POST.
    // No BACKEND_URL set, so createDeepAgentsHandler attempts fetch to its
    // default, fails, and returns its own 502 "upstream error". Three proofs:
    //   1. status is 502 (handler's fetch-failure branch), not 404 (route
    //      missing) or 405 (wrong verb / unhandled)
    //   2. body is the exact "upstream error" string the handler returns
    //   3. response isn't HTML (which would indicate SvelteKit's default error
    //      page caught an unhandled throw above the handler)
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "probe" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
      failOnStatusCode: false,
    });
    expect(
      response.status(),
      "createDeepAgentsHandler must catch the backend fetch failure and return 502; a 404 means the +server.ts POST wasn't mounted, 500 with HTML means SvelteKit's error page caught an unhandled throw"
    ).toBe(502);
    const body = await response.text();
    expect(body).toBe("upstream error");
  });
});
