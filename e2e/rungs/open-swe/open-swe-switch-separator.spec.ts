import { test, expect, type Page } from "@playwright/test";

/**
 * THE TRANSCRIPT SHOWS WHERE IT CHANGED HANDS (#253).
 *
 * Switching framework, runtime or mode mid-conversation is allowed and useful —
 * comparing how two rungs answer the same question is the point of a ladder.
 * What was missing is that the record did not show it: a transcript answered by
 * two different agents read as one continuous conversation.
 *
 * THE CONTROL IS THE LOAD-BEARING CASE HERE. A separator component that always
 * renders satisfies "a separator appears after switching" perfectly, and
 * destroys the feature's entire meaning — a marker that appears between every
 * message carries no information about anything. So the case that matters most
 * is the one asserting a conversation which never switched renders NONE.
 *
 * The placement rule itself lives in lib/transcript-boundaries.ts and is unit
 * tested there, where the awkward cases (before the first message, two in a row,
 * untagged history) are cheap to provoke. What these cases own is that the rule
 * is actually wired to the DOM.
 */

const SSE = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
} as const;

/** A minimal successful reply, so a send completes and a message lands. */
function reply(text: string): string {
  return (
    [
      `data: {"type":"text-start","id":"t"}`,
      `data: {"type":"text-delta","id":"t","delta":${JSON.stringify(text)}}`,
      `data: {"type":"text-end","id":"t"}`,
      `data: {"type":"finish","finishReason":"stop"}`,
    ].join("\n\n") + "\n\n"
  );
}

async function stageChat(page: Page): Promise<void> {
  await page.route("**/api/config", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        activeLlm: "nvidia",
        backends: { django: true, fastapi: true },
      }),
    })
  );
  await page.route("**/api/open-swe/sandbox/health", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true }),
    })
  );
  let n = 0;
  await page.route("**/api/chat/stream", (r) => {
    n += 1;
    return void r.fulfill({ status: 200, headers: { ...SSE }, body: reply(`reply ${n}`) });
  });
}

/** Send one message and wait for its reply to land. */
async function send(page: Page, text: string): Promise<void> {
  const before = await page.locator('[data-role="assistant"]').count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(before + 1, {
    timeout: 15_000,
  });
}

const separators = (page: Page) =>
  page.getByTestId("framework-switch-separator");

test.describe("chat — a switch is visible in the transcript", () => {
  test.beforeEach(async ({ page }) => {
    await stageChat(page);
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("THE CONTROL: a conversation that never switches renders NO separator", async ({
    page,
  }) => {
    // Every other case here is satisfied by a component that always renders.
    // This is the one that is not.
    await send(page, "first");
    await send(page, "second");
    await send(page, "third");
    await expect(separators(page)).toHaveCount(0);
  });

  test("switching framework mid-conversation renders exactly ONE separator", async ({
    page,
  }) => {
    await send(page, "under the first framework");
    await page.getByTestId("framework-langgraph").click();
    await send(page, "under the second");
    await expect(separators(page)).toHaveCount(1);
  });

  test("the separator NAMES the framework being switched to", async ({
    page,
  }) => {
    // "something changed" is not useful six messages later. The whole value is
    // knowing WHICH agent answered below the line.
    await send(page, "one");
    await page.getByTestId("framework-langgraph").click();
    await send(page, "two");
    await expect(separators(page).first()).toContainText("langgraph");
  });

  test("the separator carries the switch as DATA, not only as text", async ({
    page,
  }) => {
    // Colour and prose are unreadable to a test, a screen reader, and a DOM
    // diff alike. The from/to pair has to be in the markup.
    await send(page, "one");
    await page.getByTestId("framework-langgraph").click();
    await send(page, "two");
    const sep = separators(page).first();
    await expect(sep).toHaveAttribute("data-to", "langgraph");
    await expect(sep).not.toHaveAttribute("data-from", "langgraph");
  });

  test("switching TWICE renders two separators, not one", async ({ page }) => {
    // Returning to a framework is itself a change of hands. Deduplicating by
    // cell identity would hide the second transition entirely.
    await send(page, "one");
    await page.getByTestId("framework-langgraph").click();
    await send(page, "two");
    await page.getByTestId("framework-langchain").click();
    await send(page, "three");
    await expect(separators(page)).toHaveCount(2);
  });

  test("switching WITHOUT sending anything renders no separator yet", async ({
    page,
  }) => {
    // A separator marks where the answers changed, not where a button was
    // pressed. Rendering on click would put a line above a message the previous
    // framework actually answered.
    await send(page, "one");
    await page.getByTestId("framework-langgraph").click();
    await expect(separators(page)).toHaveCount(0);
  });

  test("switching RUNTIME is a switch too", async ({ page }) => {
    // The axis most easily forgotten, because the framework buttons are the
    // visible ones. Being answered by django rather than fastapi is exactly as
    // much a change of hands.
    await send(page, "one");
    await page.getByTestId("runtime-django").click();
    await send(page, "two");
    await expect(separators(page)).toHaveCount(1);
    await expect(separators(page).first()).toContainText("django");
  });

  test("the separator sits ABOVE the message it introduces", async ({
    page,
  }) => {
    // Placement is the whole claim. A separator rendered after the new message
    // says the opposite of what it means.
    await send(page, "one");
    await page.getByTestId("framework-langgraph").click();
    await send(page, "two");
    const order = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '[data-testid="framework-switch-separator"], [data-role="assistant"]'
        ),
      ];
      return nodes.map((n) =>
        n.getAttribute("data-testid") === "framework-switch-separator"
          ? "SEP"
          : "msg"
      );
    });
    // The separator must precede the LAST assistant message, not follow it.
    expect(order[order.length - 1]).toBe("msg");
    expect(order[order.length - 2]).toBe("SEP");
  });
});
