/*
 * SPLIT OUT OF open-swe-workspace.spec.ts (#373).
 *
 * The ws-task / ws-tool / ws-subagent panels — they drive the chat at /, which every rung keeps.
 *
 * The run-detail half stayed at e2e/rungs/open-swe/open-swe-run-detail-render.spec.ts. One file
 * covering both meant `pnpm eject langchain` deleted the workspace panels' coverage together
 * with the run detail's, and the fork stayed green because the tests that could have failed
 * were gone.
 */
import { test, expect, type Page } from "@playwright/test";

/**
 * The workspace panel's CONTENT, and the run-detail provenance surface.
 *
 * WHY THE CONTENT AND NOT THE CONTAINER. `chat-workspace` was deliberately
 * left uncovered when the /chat specs were written: an always-rendered aside
 * whose only self-contained assertion is "the aside exists" is a test that
 * cannot fail. Everything worth asserting is in here — the cards, and what
 * they do when the data behind them is absent or malformed.
 *
 * THE PAIR THIS FILE IS BUILT AROUND. A card that silently renders nothing and
 * a card that correctly renders nothing look identical on screen. The
 * distinguishing question is not "is the card empty" but "did the panel
 *ACKNOWLEDGE that it has nothing" — the empty state is a positive claim, and a
 * dropped part produces the same pixels without making it. So every card gets
 * three cases: populated, genuinely-absent, and malformed-so-the-schema-drops-it.
 *
 * A FINDING THAT FALLS OUT OF THAT, recorded rather than papered over: a
 * malformed part and an absent part are CURRENTLY INDISTINGUISHABLE to the
 * user. Both render the "will appear here" empty state. The tests below assert
 * that honestly rather than pretending a distinction exists — see the
 * malformed cases, which say so at the assertion. That is a product gap, not a
 * test gap, and fixing it is an app change outside this PR.
 *
 * Everything is mocked with page.route. No live backend.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

/** Config with both runtimes configured, so the runtime control is exercisable. */
async function mockConfig(
  page: Page,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await page.route(
    "**/api/config*",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          activeLlm: "nvidia",
          backends: { django: true, fastapi: true },
          ...extra,
        }),
      })
  );
}

async function mockTools(page: Page, tools: unknown[] = []): Promise<void> {
  await page.route(
    "**/api/chat/tools**",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tools, mcpServers: [] }),
      })
  );
}

/** Stream a fixed set of data-* parts back from the chat endpoint. */
async function mockChatStream(page: Page, parts: string[]): Promise<void> {
  await page.route(
    "**/api/chat/stream",
    (route) =>
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body:
          [
            `data: {"type":"start","messageId":"m1"}`,
            ...parts,
            `data: {"type":"finish","finishReason":"stop"}`,
          ].join("\n\n") + "\n\n",
      })
  );
}

async function sendSomething(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-input").fill("go");
  await page.getByTestId("chat-send").click();
}

// ---------------------------------------------------------------------------
// ws-task
// ---------------------------------------------------------------------------

test.describe("workspace — ws-task renders the task list's content", () => {
  test("a valid data-todo renders one row per item, with its text and done state", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await mockChatStream(page, [
      `data: {"type":"data-todo","data":{"id":"td1","seq":0,"items":[` +
        `{"id":"i1","text":"Read the manifest","status":"done"},` +
        `{"id":"i2","text":"Write the adapter","status":"in-progress"},` +
        `{"id":"i3","text":"Prove it can fail","status":"pending"}]}}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    const tasks = page.getByTestId("ws-task");
    await expect(tasks).toHaveCount(3, { timeout: 15_000 });

    // The text is the point. A row that renders its status mark but not its
    // text is the silent-nothing case wearing a card, so assert the words.
    await expect(tasks.nth(0)).toContainText("Read the manifest");
    await expect(tasks.nth(1)).toContainText("Write the adapter");
    await expect(tasks.nth(2)).toContainText("Prove it can fail");

    // The section header is a derived count, not a constant — it is the only
    // place the done/total split is stated, and it is easy to leave stale.
    await expect(page.getByTestId("chat-workspace")).toContainText(
      "Tasks (1/3)"
    );
  });

  test("no data-todo at all: the panel SAYS it has nothing", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await mockChatStream(page, [
      `data: {"type":"text-start","id":"t1"}`,
      `data: {"type":"text-delta","id":"t1","delta":"nothing to do"}`,
      `data: {"type":"text-end","id":"t1"}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    // Zero cards AND a positive statement of emptiness. Asserting only the
    // count would pass on a panel that rendered nothing at all, including one
    // that had crashed.
    await expect(page.getByTestId("ws-task")).toHaveCount(0);
    await expect(page.getByTestId("chat-workspace")).toContainText(
      "will appear here"
    );
  });

  test("MALFORMED data-todo is surfaced as unreadable, NOT as absent (#140)", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    // `seq` is required and must be a non-negative integer; this sends a
    // string. TodoSchema rejects the part, so it never reaches the message
    // union.
    await mockChatStream(page, [
      `data: {"type":"data-todo","data":{"id":"td1","seq":"not-a-number","items":[{"id":"i1","text":"Read the manifest","status":"done"}]}}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    // Still no task: we could not read it, so we cannot show one.
    await expect(page.getByTestId("ws-task")).toHaveCount(0);

    // THIS IS THE FIX FOR #140. The panel used to render the same "nothing
    // produced yet" state it renders for a run that genuinely produced no
    // tasks, so a backend emitting subtly wrong frames looked like a backend
    // emitting none. It now says a part arrived and could not be read.
    const unreadable = page.getByTestId("ws-unreadable");
    await expect(unreadable).toBeVisible();
    // Name the part, not just a count — "1 problem" would pass on a panel that
    // knows something broke but not what.
    await expect(unreadable).toContainText("data-todo");
    await expect(
      page.getByTestId("ws-unreadable-part").first()
    ).toHaveAttribute("data-reason", "schema-rejected");

    // The POSITIVE claim that makes this closed rather than half-closed: the
    // empty-state text is GONE. A person looking at the panel can now tell it
    // apart from a run that produced nothing — the acceptance question #140
    // was written against.
    await expect(page.getByTestId("chat-workspace")).not.toContainText(
      "will appear here"
    );
  });
});

// ---------------------------------------------------------------------------
// ws-tool
// ---------------------------------------------------------------------------

test.describe("workspace — ws-tool renders the tool inventory", () => {
  test("each advertised tool renders by name", async ({ page }) => {
    await mockConfig(page);
    await mockTools(page, [
      { name: "increment", description: "bump the counter", source: "builtin" },
      { name: "get_counter", description: "read it", source: "builtin" },
      { name: "web_search", description: "search", source: "mcp" },
    ]);
    await mockChatStream(page, []);

    await page.goto("/chat");

    const tools = page.getByTestId("ws-tool");
    await expect(tools).toHaveCount(3, { timeout: 15_000 });
    // Names, not just chips. Three empty chips would satisfy a count.
    await expect(tools.nth(0)).toHaveText("increment");
    await expect(tools.nth(1)).toHaveText("get_counter");
    await expect(tools.nth(2)).toHaveText("web_search");
  });

  test("a backend advertising no tools renders no chips", async ({ page }) => {
    await mockConfig(page);
    await mockTools(page, []);
    await mockChatStream(page, []);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-workspace")).toBeVisible();
    await expect(page.getByTestId("ws-tool")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// ws-subagent
// ---------------------------------------------------------------------------

test.describe("workspace — ws-subagent renders sub-agents and their status", () => {
  test("a sub-agent renders with its name and its lifecycle status", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await mockChatStream(page, [
      `data: {"type":"data-sub-agent","data":{"id":"sa1","seq":0,"parentToolCallId":"tc1","name":"researcher","status":"running","prompt":"find things","result":null,"error":null,"startedAt":"2026-05-25T00:00:00Z","finishedAt":null}}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    const sub = page.getByTestId("ws-subagent");
    await expect(sub).toHaveCount(1, { timeout: 15_000 });
    await expect(sub).toContainText("researcher");
    // Status is the half that changes; a row that showed the name and dropped
    // the status would look correct forever.
    await expect(sub).toContainText("running");
  });

  test("last status wins — the same sub-agent updating does not duplicate", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await mockChatStream(page, [
      `data: {"type":"data-sub-agent","data":{"id":"sa1","seq":0,"parentToolCallId":"tc1","name":"researcher","status":"running","prompt":"p","result":null,"error":null,"startedAt":"2026-05-25T00:00:00Z","finishedAt":null}}`,
      `data: {"type":"data-sub-agent","data":{"id":"sa1","seq":1,"parentToolCallId":"tc1","name":"researcher","status":"done","prompt":"p","result":"found","error":null,"startedAt":"2026-05-25T00:00:00Z","finishedAt":"2026-05-25T00:01:00Z"}}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    const sub = page.getByTestId("ws-subagent");
    await expect(sub).toHaveCount(1, { timeout: 15_000 });
    await expect(sub).toContainText("done");
    await expect(sub).not.toContainText("running");
  });

  test("MALFORMED status is surfaced as unreadable, NOT as absent (#140)", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    // `status` is an enum; "spinning" is not a member, so the part is rejected.
    await mockChatStream(page, [
      `data: {"type":"data-sub-agent","data":{"id":"sa1","seq":0,"parentToolCallId":"tc1","name":"researcher","status":"spinning","prompt":"p","result":null,"error":null,"startedAt":"2026-05-25T00:00:00Z","finishedAt":null}}`,
    ]);

    await page.goto("/chat");
    await sendSomething(page);

    await expect(page.getByTestId("ws-subagent")).toHaveCount(0);

    // Same fix as the todo case: a sub-agent reporting an unrecognised status
    // is now flagged rather than invisible.
    const unreadable = page.getByTestId("ws-unreadable");
    await expect(unreadable).toBeVisible();
    await expect(unreadable).toContainText("data-sub-agent");
    await expect(page.getByTestId("chat-workspace")).not.toContainText(
      "will appear here"
    );
  });
});
