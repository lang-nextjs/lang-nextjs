/*
 * SPLIT OUT OF open-swe-workspace.spec.ts (#373).
 *
 * The run-detail half — it drives /runs/<id>, which rung 4 owns.
 *
 * The workspace panels went to e2e/shell/workspace.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { mockThreadState } from "./thread-state-mock";

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

test.describe("run detail — the page refuses to guess what it was not given", () => {
  test("no threadId in the URL: the page says so instead of rendering an empty run", async ({
    page,
  }) => {
    await page.goto("/runs/run-x");

    // Rendering a blank run page would look like a run with no content. Naming
    // the missing parameter is the difference between "nothing happened" and
    // "you did not tell me which thread".
    await expect(page.getByTestId("missing-thread-id")).toBeVisible();
    await expect(page.getByTestId("missing-thread-id")).toContainText(
      "threadId"
    );
  });
});

test.describe("run detail — agent-mode-banner states who produced the output", () => {
  test("a canned response is labelled canned", async ({ page }) => {
    await page.route(
      "**/api/open-swe/runs/*/state**",
      (route) =>
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "x-openswe-agent-mode": "canned",
            "x-openswe-agent-mode-reason": "no graph configured",
          },
          body: JSON.stringify({
            status: "idle",
            messages: [],
            files: {},
            interrupts: [],
          }),
        })
    );

    await page.goto("/runs/run-canned?threadId=t1");

    // data-agent-mode rather than the palette: colour is a rendering of the
    // mode, not the mode. Same rule as data-readiness on /chat.
    const banner = page.getByTestId("agent-mode-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-agent-mode", "canned");
  });

  test("a missing provenance header resolves to unknown, NOT to live", async ({
    page,
  }) => {
    await page.route(
      "**/api/open-swe/runs/*/state**",
      (route) =>
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          // No x-openswe-agent-mode header at all.
          body: JSON.stringify({
            status: "idle",
            messages: [],
            files: {},
            interrupts: [],
          }),
        })
    );

    await page.goto("/runs/run-nohdr?threadId=t1");

    // The rule the module is built on: absent must not resolve to live. A
    // forker who mistakes a scripted run for a real agent forms a false belief
    // about what they just watched work, which is the whole reason the banner
    // is not dismissible.
    const banner = page.getByTestId("agent-mode-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-agent-mode", "unknown");
  });
});

test.describe("run detail — agent-narrative and tool-payload render stream content", () => {
  test("a completed tool call renders its input and output payloads on expand", async ({
    page,
  }) => {
    await mockThreadState(page);
    await page.route(
      "**/api/open-swe/runs/*/stream**",
      (route) =>
        void route.fulfill({
          status: 200,
          headers: { ...SSE_HEADERS },
          body:
            [
              `data: {"type":"tool-input-start","toolCallId":"tc-1","toolName":"increment"}`,
              `data: {"type":"tool-input-available","toolCallId":"tc-1","toolName":"increment","input":{"amount":2}}`,
              `data: {"type":"tool-output-available","toolCallId":"tc-1","output":{"counter":7}}`,
              `data: {"type":"finish","finishReason":"stop"}`,
            ].join("\n\n") + "\n\n",
        })
    );

    await page.goto("/runs/run-tools?threadId=t1");

    await expect(page.getByTestId("agent-narrative")).toBeVisible({
      timeout: 15_000,
    });

    // The payload is collapsed until asked for, so its absence before the
    // click is part of the contract rather than a missing assertion.
    await expect(page.getByTestId("tool-payload")).toHaveCount(0);
    await page
      .getByRole("button", { name: /expand/i })
      .first()
      .click();

    const payload = page.getByTestId("tool-payload");
    await expect(payload).toBeVisible();
    // Both halves. A payload that rendered the input and silently dropped the
    // output would look populated.
    await expect(payload).toContainText("amount");
    await expect(payload).toContainText("counter");
    await expect(payload).toContainText("7");
  });
});
