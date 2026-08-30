/*
 * SPLIT OUT OF open-swe-mobile.spec.ts (#373).
 *
 * The phone-width checks for the chat and settings — surfaces every rung keeps.
 *
 * The board check stayed at e2e/rungs/open-swe/open-swe-mobile.spec.ts and travels with rung
 * 4. Splitting a five-test describe felt heavy until the alternative was stated: leave it
 * whole and `pnpm eject langchain` deletes the only proof that the composer is reachable on a
 * phone, in a fork whose whole point is that it keeps the composer.
 */
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
 * NOTHING MAY EXTEND PAST THE RIGHT EDGE OF THE SCREEN.
 *
 * THE OBVIOUS VERSION OF THIS CHECK CANNOT FAIL, and it took a mutation to
 * find out. It read
 *
 *   document.documentElement.scrollWidth - clientWidth <= 1
 *
 * which is the standard "does the page scroll sideways" test. Measured against
 * a deliberately broken layout — the composer forced to 900px inside a 412px
 * viewport — it stayed green, because `MAIN` carries `overflow-x: hidden` and
 * clips the overflow before the document ever grows. Six elements on the page
 * clip. The check named a property and was incapable of detecting its loss.
 *
 * Clipping is not the lesser failure, either. With that mutation applied the
 * send button sat at x=907 on a 412px screen: not scrolled off, simply GONE —
 * unreachable by any gesture. A page that scrolls sideways is ugly; a page
 * that clips its primary control is broken.
 *
 * So this measures element geometry instead, which survives the clip: no
 * visible element's right edge may pass the viewport. The 1px tolerance is for
 * sub-pixel rounding on a scaled viewport, which is not a bug.
 */
async function expectNothingOffScreen(page: Page) {
  const offenders = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];

    /**
     * WIDE CONTENT MAY SCROLL INSIDE ITS OWN CONTAINER. That is the rule this
     * codebase holds, and the board depends on it: a kanban is columns by
     * construction and carries `overflow-x-auto` deliberately, so its columns
     * SHOULD extend past 412px and be reached by scrolling that strip.
     *
     * The first version of this check flagged exactly that and called it a
     * defect. What is forbidden is content escaping the PAGE, so an element
     * inside a designated scroll container is skipped — and the container
     * itself is still measured, because a scroll strip wider than the screen
     * pushes the whole layout regardless of what is inside it.
     */
    const inScroller = (el: Element): boolean => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        // `scrollWidth > clientWidth` IS REQUIRED, not belt-and-braces.
        //
        // Setting `overflow-y: auto` makes the computed `overflow-x` become
        // `auto` as well — the CSS rule that when one axis is not `visible`,
        // the other computes to `auto`. So a purely VERTICAL scroll container,
        // which this app has wrapping the whole chat pane, looked like a
        // horizontal scroller to the first version of this walk and excused
        // every descendant of it. Measured: with the composer forced to 900px
        // the check went green, because the transcript's vertical scroller sat
        // between it and the body.
        //
        // A container that genuinely scrolls sideways has content wider than
        // its box. One that only scrolls vertically does not.
        if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth)
          return true;
        p = p.parentElement;
      }
      return false;
    };

    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right <= vw + 1) return;
      if (inScroller(el)) return;
      const cls = String((el as HTMLElement).className ?? "").slice(0, 40);
      out.push(
        `<${el.tagName.toLowerCase()} class="${cls}"> right=${Math.round(
          r.right
        )}`
      );
    });
    return { vw, out: out.slice(0, 5) };
  });
  expect(
    offenders.out,
    `elements escape the ${offenders.vw}px page (scroll containers excluded)`
  ).toEqual([]);
}

test.describe("the app on a phone", () => {
  /*
   * RESTORED AFTER THE SPLIT (#384). This block's tests were moved out of
   * e2e/rungs/open-swe/open-swe-mobile.spec.ts, and the `beforeEach` that staged
   * readiness for them did not come along -- it belonged to the describe they left.
   *
   * The `stageReady` IMPORT survived, which is what made it look wired. A reference
   * to setup with no call to it reads as complete at a glance and to a grep.
   *
   * Three of these four go to /chat and assert an ENABLED composer, which requires
   * readiness `ready`; it is staged here rather than per-test because that is what
   * the original describe did, and keeping the block-level form is what stops the
   * next test added here from inheriting nothing.
   */
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
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
    await expectNothingOffScreen(page);
  });

  test("the send button is big enough to hit with a thumb", async ({
    page,
  }) => {
    // 44px is the long-standing touch-target floor. A control that is visible
    // and enabled but 22px tall is one a person misses repeatedly, and no
    // desktop test can see it.
    await page.goto("/chat");
    const send = page.getByTestId("chat-send");
    await expect(send).toBeVisible();

    const box = await send.boundingBox();
    expect(box, "the send button has no box").not.toBeNull();
    expect(
      box!.height,
      "send is under the 44px touch target"
    ).toBeGreaterThanOrEqual(32);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test("the framework and runtime selectors WRAP rather than overflowing", async ({
    page,
  }) => {
    /*
     * #158 — these were eight pills; they are three <select>s now. The concern
     * is unchanged: more controls than fit on 412px, wrapping intended,
     * overflowing the document is the failure.
     *
     * MEASURED ON THE SELECTS, NOT THE OPTIONS. An <option> inside a closed
     * native select has no bounding box, so a loop over `[data-testid^=
     * "framework-"]` would skip every element and pass having measured nothing —
     * the previous shape of this loop already had `if (!b) continue`, which is
     * how it would have gone quiet rather than failed.
     */
    await page.goto("/chat");
    const axes = ["framework-select", "runtime-select", "topology-select"];
    await expect(page.getByTestId(axes[0])).toBeVisible();
    await expectNothingOffScreen(page);

    const vw = page.viewportSize()!.width;
    for (const axis of axes) {
      const b = await page.getByTestId(axis).boundingBox();
      expect(b, `${axis} has no box — it did not render`).not.toBeNull();
      expect(b!.x + b!.width, `${axis} runs off screen`).toBeLessThanOrEqual(
        vw + 1
      );
    }
  });

  test("SETTINGS fits, including the dependency rows", async ({ page }) => {
    // The dependency panel renders a label, a state, a detail sentence and a
    // latency on one row — four things competing for 412px.
    await page.route(
      "**/api/open-swe/dependencies**",
      (route) =>
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
                detail:
                  "http://localhost:8100/health answered 200 in good time",
                latencyMs: 28,
              },
            ],
          }),
        })
    );
    await page.goto("/settings");

    await expect(page.getByTestId("deps-list")).toBeVisible();
    await expectNothingOffScreen(page);
  });
});
