import { test, expect } from "@playwright/test";

/**
 * E2E: matrix-selector UI coverage — every one of the 12 cells.
 *
 *   pythonBackend ∈ {django, fastapi}                  (2)
 *   aiBackend     ∈ {deepagents, langgraph, langchain} (3)
 *   topology      ∈ {react, plan-execute}              (2)
 *
 * SCOPE — this proves the matrix-selector UI forwards each cell's
 * coordinates correctly into the proxy POST body and that the response
 * renders with the matching `via` label. The backend is fully mocked, so
 * the 12 tests exercise identical agent behavior — only the selector
 * plumbing differs. The "full agent matrix coverage" framing would
 * overpromise: a stub returning canned bytes cannot prove plan-execute
 * behaves differently from react, or that langgraph behaves differently
 * from deepagents.
 *
 * Real per-cell agent behavior lives in the e2e-django / e2e-fastapi CI
 * jobs, which boot the actual Django/FastAPI servers and run a real
 * stream through each backend.
 */

const PYTHON = ["django", "fastapi"] as const;
const AI = ["deepagents", "langgraph", "langchain"] as const;
const TOPOLOGY = ["react", "plan-execute"] as const;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
};

function textResponse(text: string): string {
  return [
    'data: {"type":"text-start","id":"t1"}',
    `data: {"type":"text-delta","id":"t1","delta":${JSON.stringify(text)}}`,
    'data: {"type":"text-end","id":"t1"}',
    'data: {"type":"finish","finishReason":"stop"}',
    "",
  ].join("\n\n");
}

test.describe("Matrix selector UI — proxy body coords for all 12 cells (real behavior in e2e-django/fastapi)", () => {
  test.beforeEach(async ({ page }) => {
    // Both Python backends configured → django/fastapi buttons stay enabled.
    await page.route("**/api/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ backends: { django: true, fastapi: true } }),
      })
    );
  });

  for (const python of PYTHON) {
    for (const ai of AI) {
      for (const topology of TOPOLOGY) {
        test(`cell: ${python} × ${ai} × ${topology}`, async ({ page }) => {
          const cellTag = `${python}-${ai}-${topology}`;
          let body: Record<string, unknown> = {};

          await page.route("**/api/chat/stream", async (route) => {
            body = JSON.parse(route.request().postData() ?? "{}");
            await route.fulfill({
              status: 200,
              headers: SSE_HEADERS,
              body: textResponse(`cell ${cellTag} ok`),
            });
          });

          await page.goto("/");
          await page.waitForLoadState("networkidle");

          // Select the cell. Topology is clicked last: switching aiBackend can
          // reset topology to "react", so the explicit topology click wins.
          await page.getByRole("button", { name: python, exact: true }).click();
          await page.getByRole("button", { name: ai, exact: true }).click();
          await page
            .getByRole("button", { name: topology, exact: true })
            .click();

          await page.getByRole("textbox").fill(`message for ${cellTag}`);
          await page.keyboard.press("Enter");

          const bubble = page.locator('[data-role="assistant"]').first();
          await expect(bubble).toBeVisible({ timeout: 10_000 });
          await expect(bubble).toContainText(`cell ${cellTag} ok`);

          // The proxy POST body carries the exact cell coordinates.
          expect(body.pythonBackend).toBe(python);
          expect(body.aiBackend).toBe(ai);
          expect(body.topology).toBe(topology);

          // The via label echoes the cell in the UI.
          await expect(bubble).toContainText(
            `via ${python} · ${ai} · ${topology}`
          );
        });
      }
    }
  }
});
