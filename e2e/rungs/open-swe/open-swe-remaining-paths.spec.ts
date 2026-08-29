import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * THE PATHS A COVERAGE AUDIT LEFT UNCOVERED.
 *
 * A census over the 100 most frequent user paths left seven with no test. Four
 * turned out to be false gaps — a keyword search over test TITLES is a weak
 * measure, and it under-reported as readily as it over-reported:
 *
 *   topology unavailable   covered by open-swe-chat-axes (toHaveCount(0))
 *   approval card appears  covered by open-swe-approval, three times
 *   mobile viewport        covered by the `mobile-chrome` project (Pixel 7),
 *                          which e2e.yml really does run
 *   inference verified     covered on the branch that introduced it
 *
 * Three were real, and are covered here. Two of them were invisible to the
 * testid census as well, for a reason worth recording: that census read
 * `data-testid` string literals and template literals WITHOUT interpolation,
 * so `` `rename-${c.id}` `` never appeared in it. A dynamic testid is exactly
 * the kind a list-rendering surface uses, which is to say exactly the kind
 * worth auditing.
 */

const CONV_KEY_HINT = "conversation";

async function seedConversation(page: Page, title = "Auth refactor") {
  // The sidebar reads conversations from localStorage. Rather than guess the
  // storage key, drive the UI: New chat creates one, which is a path in its
  // own right and is already covered elsewhere.
  await page.goto("/chat");
  await page.getByTestId("new-chat").click();
  const list = page.getByTestId("conversation-list");
  await expect(list).toBeVisible();
  return title;
}

test.describe("open-swe top bar — the crumb names the open conversation (#129 part 3)", () => {
  /**
   * A TESTID THAT NAMED THE PROPERTY WITH NOTHING ASSERTING IT.
   *
   * `ShellCrumbs` resolves `?c=` through the LIVE conversation list rather than
   * caching a title, and its comment says why: "so a rename reaches the top bar
   * on the same render that updates the sidebar". That is a real design
   * decision with a real failure mode if it regresses — and `shell-crumb` was
   * untouched by any test, so the regression it guards had ALREADY HAPPENED and
   * nothing said so.
   *
   * #129's parts 1 and 2 (click-to-reload, rename) were already covered. This
   * is the third, and it was the one with a testid and no assertion.
   */
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("CONTROL: with no conversation selected the crumb is a page label, not a title", async ({
    page,
  }) => {
    // Without this, a crumb hardcoded to any string would satisfy every
    // assertion below. The fallback is deliberately NOT the product name —
    // see `pageLabel` — so asserting a title is absent here is asserting the
    // fallback path exists at all.
    await page.goto("/chat");
    const crumb = page.getByTestId("shell-crumb");
    await expect(crumb).toBeVisible();
    await expect(crumb).not.toContainText("Auth refactor");
  });

  test("selecting a conversation puts its title in the top bar", async ({
    page,
  }) => {
    await seedConversation(page);

    const row = page.getByTestId("conversation-list").locator("li").first();
    const renameBtn = row.locator('[data-testid^="rename-"]').first();
    await renameBtn.click({ force: true });
    const input = row.locator('[data-testid^="rename-input-"]').first();
    await input.fill("Auth refactor");
    await input.press("Enter");

    await expect(page.getByTestId("shell-crumb")).toContainText(
      "Auth refactor",
      { timeout: 10_000 }
    );
  });

  test("a rename reaches the top bar, not only the sidebar", async ({
    page,
  }) => {
    /*
     * THE ASSERTION THE DESIGN COMMENT IS ABOUT. Caching the title at selection
     * time would pass the test above and fail this one: the sidebar would show
     * the new name while the top bar kept the old, and the two disagreeing is
     * worse than either being stale, because the reader cannot tell which is
     * current.
     */
    await seedConversation(page);
    const row = page.getByTestId("conversation-list").locator("li").first();

    const rename = async (to: string) => {
      await row.locator('[data-testid^="rename-"]').first().click({ force: true });
      const input = row.locator('[data-testid^="rename-input-"]').first();
      await input.fill(to);
      await input.press("Enter");
    };

    await rename("First name");
    await expect(page.getByTestId("shell-crumb")).toContainText("First name", {
      timeout: 10_000,
    });

    // Rename AGAIN, with the conversation already open. A cached title survives
    // the first rename by luck of ordering; it cannot survive the second.
    await rename("Second name");
    await expect(page.getByTestId("shell-crumb")).toContainText("Second name", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("shell-crumb")).not.toContainText("First name");
  });
});

test.describe("open-swe sidebar — renaming a conversation (path 88)", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("a conversation can be renamed, and the new name persists a reload", async ({
    page,
  }) => {
    // The rename control and its input were untouched by any e2e test. Both
    // carry a DYNAMIC testid, which is why the census missed them too.
    await seedConversation(page);

    const row = page.getByTestId("conversation-list").locator("li").first();
    await expect(row).toBeVisible();
    const renameBtn = row.locator('[data-testid^="rename-"]').first();
    await renameBtn.click({ force: true }); // the control is showOnHover

    const input = row.locator('[data-testid^="rename-input-"]').first();
    await expect(input).toBeVisible();
    await input.fill("Auth refactor");
    await input.press("Enter");

    await expect(row).toContainText("Auth refactor");

    // PERSISTED, not merely re-rendered. A rename that survives until the next
    // navigation and then reverts is the failure a person actually hits, and
    // an in-memory-only assertion cannot see it.
    await page.reload();
    await expect(
      page.getByTestId("conversation-list")
    ).toContainText("Auth refactor");
  });

  test("Escape abandons a rename and keeps the old name", async ({ page }) => {
    // The pair. "Enter commits" is satisfied by an editor that commits on
    // every keystroke, which would make Escape destructive.
    await seedConversation(page);

    const row = page.getByTestId("conversation-list").locator("li").first();
    const before = ((await row.innerText()) ?? "").trim();
    await row.locator('[data-testid^="rename-"]').first().click({ force: true });

    const input = row.locator('[data-testid^="rename-input-"]').first();
    await expect(input).toBeVisible();
    await input.fill("discard me");
    await input.press("Escape");

    await expect(input).toHaveCount(0);
    await expect(row).not.toContainText("discard me");
    expect(((await row.innerText()) ?? "").trim()).toBe(before);
  });

  test("A BLANK RENAME KEEPS THE EDITOR OPEN rather than silently reverting", async ({
    page,
  }) => {
    // The component says why, and it is the interesting half: "a rename that
    // vanishes looks identical to one that saved, and the user has no way to
    // tell which happened." So an empty title must not close the editor.
    await seedConversation(page);

    const row = page.getByTestId("conversation-list").locator("li").first();
    await row.locator('[data-testid^="rename-"]').first().click({ force: true });

    const input = row.locator('[data-testid^="rename-input-"]').first();
    await expect(input).toBeVisible();
    await input.fill("   ");
    await input.press("Enter");

    // Still editing — the rejection is visible rather than silent.
    await expect(input).toBeVisible();
  });
});

test.describe("open-swe chat — selection is not conveyed by colour alone (path 96, #235)", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  /*
   * #158 CONVERTED THESE FROM aria-pressed TO SELECT SEMANTICS, and the point
   * of #235 is unchanged: SELECTION MUST BE EXPOSED, not conveyed by a
   * background colour alone. On a native <select> the platform exposes it —
   * `option.selected` and the select's value are what assistive technology
   * reads, and there is no way to render the control without them. So these
   * assert the same property against the mechanism that now carries it.
   *
   * They are kept rather than deleted BECAUSE the property is now structural.
   * "It cannot break" is the argument every deleted test was given, and it is
   * how a surface loses the check that named the defect it once had.
   */
  test("THE FRAMEWORK SELECTOR EXPOSES ITS SELECTION, not just a background", async ({
    page,
  }) => {
    await page.goto("/chat");

    const select = page.getByTestId("framework-select");
    await expect(select).toBeVisible();
    const options = select.locator("option");
    const n = await options.count();
    expect(n).toBeGreaterThan(1);

    // Exactly one option is selected, and the select reports which.
    const selected = await options.evaluateAll(
      (os) => os.filter((o) => (o as HTMLOptionElement).selected).length
    );
    expect(selected).toBe(1);
    await expect(select).not.toHaveValue("");
  });

  test("choosing a framework MOVES the selection", async ({ page }) => {
    // Static correctness is not enough: a value hardcoded to the first option
    // passes the case above and reports the wrong answer forever.
    await page.goto("/chat");
    const select = page.getByTestId("framework-select");
    await expect(select).toBeVisible();

    const before = await select.inputValue();
    const values = await select
      .locator("option:not([disabled])")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const other = values.find((v) => v !== before);

    // Unconditional: if no other framework was selectable the test has proved
    // nothing and must say so rather than pass quietly.
    expect(other, "no alternative framework was selectable").toBeTruthy();
    await select.selectOption(other!);
    await expect(select).toHaveValue(other!);
  });

  test("THE MODE SELECTOR EXPOSES ITS SELECTION TOO", async ({ page }) => {
    await page.goto("/chat");
    const select = page.getByTestId("topology-select");
    await expect(select).toBeVisible();

    const n = await select.locator("option").count();
    expect(n).toBeGreaterThan(0);
    const selected = await select
      .locator("option")
      .evaluateAll((os) => os.filter((o) => (o as HTMLOptionElement).selected).length);
    expect(selected).toBe(1);
  });

  test("the runtime selector still does — the control that was already right", async ({
    page,
  }) => {
    // #235 named runtime as the one that got this right. Asserted so a change
    // to the other two cannot quietly cost the one that was already correct.
    await page.goto("/chat");
    const select = page.getByTestId("runtime-select");
    if ((await select.count()) === 0) {
      throw new Error("no runtime selector rendered — the control vanished");
    }
    const selected = await select
      .locator("option")
      .evaluateAll((os) => os.filter((o) => (o as HTMLOptionElement).selected).length);
    expect(selected).toBe(1);
  });
});

test.describe("open-swe composer — Shift+Enter (path 14)", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("SHIFT+ENTER INSERTS A NEWLINE AND DOES NOT SEND", async ({ page }) => {
    // THIS TEST FAILED WHEN FIRST WRITTEN, and that is the point of it.
    //
    // The composer was an <input>, which cannot hold a newline. Shift+Enter
    // did not insert one — it triggered the form's implicit submission and
    // DISPATCHED THE MESSAGE. The keystroke everyone uses to add a line to a
    // prompt sent the half-written thought instead: unrecoverable, and it
    // costs an inference call.
    //
    // The fix was the element, not a keybinding: an agent prompt carries
    // pasted stack traces and numbered requirements, and a one-line box hides
    // all but the tail of them while you type.
    const posts: string[] = [];
    await page.route("**/api/chat/stream**", (route) => {
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
    await input.fill("half a thought");
    await input.press("Shift+Enter");

    // Waited rather than asserted immediately: a POST that fires late still
    // fires, and an instant check would pass on a race.
    await page.waitForTimeout(1_500);
    expect(posts, "Shift+Enter dispatched the message").toEqual([]);
    // And a newline was actually inserted — the half the old element could not
    // do at all. Asserted on the VALUE, because "did not send" alone is
    // satisfied by a keystroke that does nothing whatsoever.
    await expect(input).toHaveValue("half a thought\n");
  });

  test("plain Enter still sends — the control for the case above", async ({
    page,
  }) => {
    // Without this, "Shift+Enter does not send" is satisfied by a composer
    // that never sends at all.
    const posts: string[] = [];
    await page.route("**/api/chat/stream**", (route) => {
      posts.push(route.request().method());
      return void route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"ok"}\n\ndata: {"type":"finish"}\n\n',
      });
    });

    await page.goto("/chat");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    await input.fill("a whole thought");
    await input.press("Enter");

    await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  });
});
