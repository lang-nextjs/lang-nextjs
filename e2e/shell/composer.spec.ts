/*
 * SPLIT OUT OF open-swe-card-and-composer.spec.ts (#373).
 *
 * The composer half — it drives the chat at /, which every rung keeps.
 *
 * The board half stayed at e2e/rungs/open-swe/open-swe-board-card.spec.ts and travels with
 * rung 4. `stageReady` moved with this file; the board spec imports it from ../../shell/.
 */
import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * THE TWO THINGS EVERY SESSION DOES: read a board card, and send a message.
 *
 * Written after a coverage census over every `data-testid` the app renders,
 * which is a harder measure to fool than reading test titles. It found the
 * board card's timestamp, its status pill and the queue readiness dot were
 * rendered by nothing that any test ever touched — on the most-visited surface
 * in the app — and that no open-swe test ever pressed Enter to send, though
 * every test clicks the button and every PERSON presses Enter.
 *
 * The card cases are not cosmetic. `statusBadge` ended in a fall-through that
 * returned the raw enum value as the label, which was harmless while
 * `Run["status"]` held four values and became the common case when #246
 * widened it to seven. `interrupted` — the one state a person must act on, and
 * the reason the board has a "Needs approval" column at all — rendered as the
 * lowercase word "interrupted" in the grey reserved for states that need
 * nobody. Widening a type does not update the code that consumes it.
 */

function run(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    run_id: id,
    thread_id: `th-${id}`,
    status,
    task: `task ${id}`,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

async function mockRuns(page: Page, runs: unknown[]) {
  await page.route("**/api/open-swe/runs**", (route) => {
    if (route.request().method() !== "GET") return void route.fallback();
    return void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runs),
    });
  });
}

test.describe("open-swe composer — sending the way people actually send", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("ENTER SENDS — every test clicked the button; every person presses Enter", async ({
    page,
  }) => {
    // The gap this file was written for. The composer is a single <input> in a
    // <form>, so Enter submits natively — which means it works by accident of
    // markup and would break silently the day someone swaps in a <div>.
    const posts: string[] = [];
    /*
     * `"**\/api/chat/stream"` WITHOUT A TRAILING `**`, and the difference is
     * not cosmetic (#361). The wildcard form also matched
     * `/api/chat/stream/resume?resumeId=…`, so once open-swe gained a resume
     * route this stub began answering the mount-time resume GET with chat SSE
     * frames — delivering the scripted body twice and putting a GET where the
     * spec expected its POST. Two symptoms, one over-broad glob.
     */
    await page.route("**/api/chat/stream", (route) => {
      posts.push(route.request().method());
      return void route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"hi"}\n\ndata: {"type":"finish"}\n\n',
      });
    });

    await page.goto("/chat");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    await input.fill("hello from the keyboard");
    await input.press("Enter");

    await expect
      .poll(() => posts.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(posts[0]).toBe("POST");
  });

  test("ENTER ON AN EMPTY COMPOSER SENDS NOTHING", async ({ page }) => {
    // The pair. "Enter sends" is satisfied by a form that submits whatever is
    // in the box including nothing, which posts an empty turn to a model and
    // bills for it.
    //
    // THIS PROPERTY IS DEFENDED TWICE, and it is worth writing down because
    // the mutation evidence looks like a weak test and is not. Measured:
    //
    //   remove `if (!text || busy) return` from submit()        -> still green
    //   remove `|| !input.trim()` from the button's disabled    -> still green
    //   remove BOTH                                             -> RED
    //
    // The button guard blocks HTML implicit submission (a disabled submit
    // button stops Enter reaching the form at all); the submit() guard catches
    // anything that gets past it. Either alone holds the line, so a
    // single-guard mutation survives — that is redundancy in the product, not
    // a hole in the test. The test fails exactly when the behaviour is
    // actually broken, which is the only thing it is required to do.
    const posts: string[] = [];
    await page.route("**/api/chat/stream", (route) => {
      posts.push(route.request().url());
      return void route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"type":"finish"}\n\n',
      });
    });

    await page.goto("/chat");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    await input.click();
    await input.press("Enter");

    // Deliberately waiting rather than asserting immediately: a POST that
    // fires late still fires, and an instant assertion would pass on a race.
    await page.waitForTimeout(1_500);
    expect(posts).toEqual([]);
  });

  test("whitespace alone is not a message", async ({ page }) => {
    // The case a `value.length` check passes and a person notices when their
    // stray space costs an inference call.
    const posts: string[] = [];
    await page.route("**/api/chat/stream", (route) => {
      posts.push(route.request().url());
      return void route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"type":"finish"}\n\n',
      });
    });

    await page.goto("/chat");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    await input.fill("   ");
    await input.press("Enter");

    await page.waitForTimeout(1_500);
    expect(posts).toEqual([]);
  });

  test("the composer clears after a send, ready for the next message", async ({
    page,
  }) => {
    // A composer that keeps the sent text makes the next message a duplicate
    // of the last one, which is the sort of thing nobody reports and everybody
    // works around.
    await page.route(
      "**/api/chat/stream",
      (route) =>
        void route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: 'data: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"ok"}\n\ndata: {"type":"finish"}\n\n',
        })
    );

    await page.goto("/chat");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    await input.fill("first message");
    await input.press("Enter");

    await expect(input).toHaveValue("", { timeout: 15_000 });
  });
});
