import { test, expect } from "@playwright/test";

/**
 * MATRIX spec — requires >= 2 rungs installed.
 *
 * Extracted from e2e/nextjs.spec.ts (#14). The rest of that file is
 * rung-agnostic transport coverage and lives in e2e/shared/; this test is the
 * one case in it that drives the rung selector, so it cannot survive
 * `pnpm eject <rung>` and belongs with the cross-rung suite.
 *
 * Contract under test: selecting an AI backend in the UI makes the proxy
 * forward the matching `aiBackend` in the POST body, which is how the server
 * resolves langGraphAdapter vs langchainAdapter.
 */

/** Build a minimal AI SDK v6 UIMessageStream body (text-only). */
function makeTextSseBody(text: string): string {
  return [
    `data: {"type":"text-start","id":"t1"}`,
    `data: {"type":"text-delta","id":"t1","delta":"${text}"}`,
    `data: {"type":"text-end","id":"t1"}`,
    `data: {"type":"finish","finishReason":"stop"}`,
    "",
    "",
  ].join("\n\n");
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
} as const;

test.describe("Matrix — adapter selection across rungs (E2E-04)", () => {
  test("E2E-04: langGraphAdapter and langchainAdapter send correct adapterName in POST body", async ({
    page,
    browserName,
  }) => {
    // Mobile-Chrome skip: this test does two iterations (langgraph +
    // langchain), each involving a click → React state update → form
    // submit → assistant bubble render. On Pixel 7's throttled CPU
    // the combined iteration time exceeds the 60s test timeout. The
    // contract under test (proxy body carries the right aiBackend) is
    // wire-format only and not viewport-sensitive — chromium coverage
    // is sufficient. Mobile-realistic flows wouldn't switch adapters
    // mid-session anyway.
    test.skip(
      browserName === "chromium" && page.viewportSize()?.width === 412,
      "Mobile-Chrome (Pixel 7) throttled CPU exceeds 60s for the two-iteration adapter swap; wire-format coverage is engine-agnostic and chromium-desktop is sufficient"
    );

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    for (const adapter of ["langgraph", "langchain"] as const) {
      let capturedAiBackend: string | undefined;

      await page.route("**/api/chat/stream", async (route) => {
        const raw = route.request().postData() ?? "{}";
        // The matrix refactor renamed body.adapterName → body.aiBackend
        // (the proxy now resolves the adapter from the AI backend choice;
        // see apps/example/app/api/chat/stream/route.ts ADAPTER_FOR_AI map).
        const body = JSON.parse(raw) as {
          aiBackend?: string;
          adapterName?: string;
        };
        capturedAiBackend = body.aiBackend ?? body.adapterName;

        await route.fulfill({
          status: 200,
          headers: { ...SSE_HEADERS },
          body: makeTextSseBody(`${adapter} works`),
        });
      });

      // Click the AI backend button to select the current adapter pair.
      await page.locator(`button:has-text("${adapter}")`).click();

      // Wait for the button to be visually selected (bg-blue-600) before sending,
      // ensuring the React state update for aiBackend has propagated so the
      // transport body closure reads the latest extraBodyRef.current value.
      await expect(page.locator(`button:has-text("${adapter}")`)).toHaveClass(
        /bg-blue-600/,
        { timeout: 2_000 }
      );

      await page.getByRole("textbox").fill(`test ${adapter}`);
      await page.keyboard.press("Enter");

      // Wait for an assistant bubble to appear (proves the mock SSE was consumed).
      await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({
        timeout: 10_000,
      });

      expect(capturedAiBackend).toBe(adapter);

      // Remove route intercept before next iteration.
      await page.unrouteAll();
    }
  });
});
