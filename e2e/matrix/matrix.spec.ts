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
    await page.route("**/api/config*", (route) =>
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

/**
 * THE TRANSCRIPT SHOWS WHERE IT CHANGED HANDS (#253).
 *
 * Switching framework mid-conversation is the point of a ladder — comparing how
 * rungs answer the SAME question, with the context that makes the comparison
 * mean anything. Starting a fresh chat to switch would throw that away. So the
 * switch stays allowed and the RECORD has to show it.
 *
 * THE CONTROL IS THE LOAD-BEARING HALF, and #253 says so explicitly: "a
 * separator component that always renders would satisfy the first assertion and
 * destroy the feature's meaning". A test that only ever sends under two
 * frameworks cannot tell a working boundary from a permanent one, so the
 * no-switch case is asserted first and asserts a count of ZERO.
 */
test.describe("Transcript boundary — a switch is visible, and only a switch (#253)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/config*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ backends: { django: true, fastapi: true } }),
      })
    );
    let n = 0;
    await page.route("**/api/chat/stream", async (route) => {
      n += 1;
      await route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: textResponse(`reply ${n}`),
      });
    });
  });

  async function send(page: import("@playwright/test").Page, text: string) {
    await page.getByRole("textbox").fill(text);
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: text.replace(/^say /, "reply ") })
    ).toBeVisible({ timeout: 10_000 });
  }

  test("CONTROL: a conversation that never switches renders NO boundary", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "fastapi", exact: true }).click();
    await page.getByRole("button", { name: "langchain", exact: true }).click();

    await page.getByRole("textbox").fill("first");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').first()).toContainText(
      "reply 1",
      { timeout: 10_000 }
    );
    await page.getByRole("textbox").fill("second");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').nth(1)).toContainText(
      "reply 2",
      { timeout: 10_000 }
    );

    // Two assistant turns from one cell. If this is ever non-zero the separator
    // has become a header, and every other assertion below is worthless.
    await expect(page.getByTestId("transcript-boundary")).toHaveCount(0);
  });

  test("a mid-conversation framework switch renders exactly one boundary, naming the new cell", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "fastapi", exact: true }).click();
    await page.getByRole("button", { name: "langchain", exact: true }).click();

    await page.getByRole("textbox").fill("under langchain");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').first()).toContainText(
      "reply 1",
      { timeout: 10_000 }
    );

    // Nothing has changed yet — asserted BEFORE the switch, so a separator that
    // renders on mount cannot hide behind the post-switch assertion.
    await expect(page.getByTestId("transcript-boundary")).toHaveCount(0);

    await page.getByRole("button", { name: "deepagents", exact: true }).click();
    await page.getByRole("textbox").fill("under deepagents");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').nth(1)).toContainText(
      "reply 2",
      { timeout: 10_000 }
    );

    const boundary = page.getByTestId("transcript-boundary");
    await expect(boundary).toHaveCount(1);
    await expect(boundary).toContainText("switched to fastapi · deepagents");
    // The cell as DATA, not only as prose: a label reworded in a redesign should
    // not silently stop identifying which agent took over.
    await expect(boundary).toHaveAttribute(
      "data-to",
      "fastapi·deepagents·react"
    );
  });

  test("switching back renders a SECOND boundary, not a cancellation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "fastapi", exact: true }).click();
    await page.getByRole("button", { name: "langchain", exact: true }).click();
    await page.getByRole("textbox").fill("a");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').first()).toContainText(
      "reply 1",
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: "deepagents", exact: true }).click();
    await page.getByRole("textbox").fill("b");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').nth(1)).toContainText(
      "reply 2",
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: "langchain", exact: true }).click();
    await page.getByRole("textbox").fill("c");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-role="assistant"]').nth(2)).toContainText(
      "reply 3",
      { timeout: 10_000 }
    );

    // Returning to a cell is a real event: the reader needs to know WHERE the
    // run resumed, and "same cell as earlier" does not tell them that.
    await expect(page.getByTestId("transcript-boundary")).toHaveCount(2);
  });
});
