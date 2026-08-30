/*
 * SPLIT OUT OF open-swe-mobile.spec.ts (#373).
 *
 * The board's phone-width check — /runs, which rung 4 owns.
 *
 * The chat and settings checks went to e2e/shell/mobile.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "../../shell/readiness-mock";

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

test.describe("open-swe on a phone", () => {
  /*
   * RESTORED AFTER THE SPLIT (#384). The board test does not depend on staged
   * readiness -- it renders /runs -- so this half went green without it and the
   * drop showed up only in the half that did. That is why it is back rather than
   * the now-unused import being deleted: the split moved tests, it did not decide
   * that this describe no longer stages readiness, and the next test added here
   * would inherit that silent change.
   */
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("the BOARD fits the screen and its cards are readable", async ({
    page,
  }) => {
    // A kanban board is the hardest thing to fit on a phone — it is columns by
    // construction. Long task text is the case that breaks it.
    await mockRuns(page, [
      run(
        "a",
        "running",
        "Refactor the authentication middleware so that session timeouts are configurable per workspace"
      ),
      run("b", "interrupted", "Needs a decision about the migration order"),
    ]);
    await page.goto("/runs");

    const card = page.getByTestId("run-list-card").first();
    await expect(card).toBeVisible();
    await expectNothingOffScreen(page);

    // The card itself must fit, not merely exist. A card wider than the screen
    // is present, visible, and unreadable.
    const box = await card.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box, "the card has no box").not.toBeNull();
    expect(box!.width, "the card is wider than the screen").toBeLessThanOrEqual(
      vw
    );
  });
});
