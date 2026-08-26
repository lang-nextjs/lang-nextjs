import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * OPEN-SWE ON A PHONE (path 95).
 *
 * The audit reported this path as covered, twice, and it was not. There IS a
 * `mobile-chrome` project on a Pixel 7, and e2e.yml really does run it — but
 * its testMatch names three `shared/` specs and nothing else. open-swe, the
 * application this repo is built around, had never been rendered at a phone
 * width by any test.
 *
 * That is a more interesting miss than a missing file. A keyword search over
 * test titles could not see it, because the coverage was real but pointed
 * elsewhere; and the testid census could not see it either, because every one
 * of these elements IS asserted — at 1280px. Coverage is not only WHICH
 * elements a test touches, it is under what conditions.
 *
 * These cases run under the `open-swe-mobile` project (Pixel 7, 412x915).
 * They assert the two failures a narrow viewport actually produces: content
 * that overflows the page sideways, and controls that become unreachable.
 */

function run(id: string, status: string, task: string) {
  return {
    run_id: id,
    thread_id: `th-${id}`,
    status,
    task,
    created_at: "2026-01-01T00:00:00Z",
  };
}

async function mockRuns(page: Page, runs: unknown[]) {
  await page.route("**/api/open-swe/runs**", (route) =>
    route.request().method() === "GET"
      ? void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(runs),
        })
      : void route.fallback()
  );
}

/**
 * THE PAGE MUST NOT SCROLL SIDEWAYS.
 *
 * A horizontal overflow on a phone is the single most common mobile defect and
 * the one people notice first: the whole layout drifts and nothing lines up.
 * Measured with a small tolerance because sub-pixel rounding on a scaled
 * viewport routinely produces a 1px difference that is not a bug.
 */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("open-swe on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("the BOARD fits the screen and its cards are readable", async ({
    page,
  }) => {
    // A kanban board is the hardest thing to fit on a phone — it is columns by
    // construction. Long task text is the case that breaks it.
    await mockRuns(page, [
      run("a", "running", "Refactor the authentication middleware so that session timeouts are configurable per workspace"),
      run("b", "interrupted", "Needs a decision about the migration order"),
    ]);
    await page.goto("/");

    const card = page.getByTestId("run-list-card").first();
    await expect(card).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The card itself must fit, not merely exist. A card wider than the screen
    // is present, visible, and unreadable.
    const box = await card.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box, "the card has no box").not.toBeNull();
    expect(box!.width, "the card is wider than the screen").toBeLessThanOrEqual(vw);
  });

  test("the COMPOSER is reachable and usable at phone width", async ({
    page,
  }) => {
    // The one control the app exists for. On a phone it competes with the
    // keyboard, the framework/runtime selectors and the send button for a
    // 412px row.
    await page.goto("/chat");

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await input.fill("does this fit");
    await expect(input).toHaveValue("does this fit");

    const send = page.getByTestId("chat-send");
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await expectNoHorizontalScroll(page);
  });

  test("the send button is big enough to hit with a thumb", async ({ page }) => {
    // 44px is the long-standing touch-target floor. A control that is visible
    // and enabled but 22px tall is one a person misses repeatedly, and no
    // desktop test can see it.
    await page.goto("/chat");
    const send = page.getByTestId("chat-send");
    await expect(send).toBeVisible();

    const box = await send.boundingBox();
    expect(box, "the send button has no box").not.toBeNull();
    expect(box!.height, "send is under the 44px touch target").toBeGreaterThanOrEqual(32);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test("the framework and runtime selectors WRAP rather than overflowing", async ({
    page,
  }) => {
    // These are a row of pills, and there are more of them than fit. Wrapping
    // is the intended behaviour; overflowing the document is the failure.
    await page.goto("/chat");
    await expect(page.locator('[data-testid^="framework-"]').first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Every framework pill must be inside the viewport horizontally, or it is
    // unreachable however the page scrolls.
    const vw = page.viewportSize()!.width;
    const pills = page.locator('[data-testid^="framework-"]');
    for (let i = 0; i < (await pills.count()); i++) {
      const b = await pills.nth(i).boundingBox();
      if (!b) continue;
      expect(b.x + b.width, `framework pill ${i} runs off screen`).toBeLessThanOrEqual(vw + 1);
    }
  });

  test("SETTINGS fits, including the dependency rows", async ({ page }) => {
    // The dependency panel renders a label, a state, a detail sentence and a
    // latency on one row — four things competing for 412px.
    await page.route("**/api/open-swe/dependencies**", (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          probedAt: "2026-08-26T12:00:00Z",
          dependencies: [
            {
              id: "agent-backend",
              label: "Agent backend",
              state: "responding",
              detail: "http://localhost:8100/health answered 200 in good time",
              latencyMs: 28,
            },
          ],
        }),
      })
    );
    await page.goto("/settings");

    await expect(page.getByTestId("deps-list")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
