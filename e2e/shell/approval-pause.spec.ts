import { test, expect, type Page } from "@playwright/test";

/**
 * THE HONEST GATE IS MOUNTED (#420).
 *
 * The upstream gate was built end to end — withholding measured, the frame
 * emitted by adapters/langchain.ts, the schema defined, ApprovalPauseCard and
 * its controller written — AND MOUNTED BY NOTHING. `ApprovalPauseCard` appeared
 * in exactly four files: its own, its test, the barrel and its controller. Zero
 * app files. Meanwhile `ApprovalCard`, the one that cannot enforce, appeared in
 * ten.
 *
 * So this file asserts the COMPOSITION, which was nobody's item: a
 * `data-approval-pause` frame arriving on the wire reaches a rendered card in
 * the real shell. That is not provable from packages/react — the card's own
 * tests pass whether or not any app mounts it, which is exactly how the gap
 * survived.
 *
 * BOTH RENDERING PATHS ARE DRIVEN, and the second is the one with teeth: a
 * mount that rendered the pause card unconditionally would satisfy the first
 * case alone.
 *
 * This does NOT turn the gate on. GATED_TOPOLOGIES is still frozenset() in all
 * five backends; these specs stub the stream, so they exercise the client half
 * that must exist before the switch can be flipped at all.
 */

const SSE = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

async function mockConfig(page: Page) {
  await page.route(
    "**/api/config*",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          activeLlm: "nvidia",
          backends: { django: true, fastapi: true },
        }),
      })
  );
}

async function mockTools(page: Page) {
  await page.route(
    "**/api/chat/tools**",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tools: [], mcpServers: [] }),
      })
  );
}

/** The pause exactly as the adapter re-labels it: interrupt carried verbatim. */
const PAUSE_FRAME =
  `data: {"type":"data-approval-pause","data":{"interrupt":{` +
  `"action_requests":[{"name":"write_file","args":{"path":"/tmp/x"},` +
  `"description":"Tool execution requires approval"}],` +
  `"review_configs":[{"action_name":"write_file",` +
  `"allowed_decisions":["approve","edit","reject","respond"]}]}}}`;

async function openChatStreaming(page: Page, frames: string[]) {
  await mockConfig(page);
  await mockTools(page);
  await page.route(
    "**/api/chat/stream",
    (route) =>
      void route.fulfill({
        status: 200,
        headers: { ...SSE },
        body: frames.join("\n\n") + "\n\n",
      })
  );
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-input").fill("write a file");
  await page.getByTestId("chat-send").click();
}

test.describe("open-swe /chat — the upstream pause reaches a card", () => {
  test("a data-approval-pause frame renders the pause card, naming the tool and its arguments", async ({
    page,
  }) => {
    await openChatStreaming(page, [
      `data: {"type":"start","messageId":"m1"}`,
      PAUSE_FRAME,
    ]);

    const card = page.getByTestId("approval-pause-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute("data-action-name", "write_file");
    // The arguments the decision is being made against, not just the name.
    await expect(page.getByTestId("pause-arguments")).toContainText("/tmp/x");
    // Answerable, and offering exactly what the FRAME permits.
    await expect(card).toHaveAttribute("data-answerable", "yes");
    await expect(page.getByTestId("pause-approve-button")).toBeVisible();
    await expect(page.getByTestId("pause-reject-button")).toBeVisible();
    await expect(page.getByTestId("pause-show-edit-button")).toBeVisible();
    await expect(page.getByTestId("pause-show-respond-button")).toBeVisible();
  });

  test("AN ORDINARY TURN RENDERS NO PAUSE CARD — the mount is conditional", async ({
    page,
  }) => {
    /*
     * THE PRESENCE COMPANION. Without it, a mount that rendered the pause card
     * on every message would pass the case above and put a permanent approval
     * affordance on an ungated conversation — an approval control that gates
     * nothing, which is the exact defect #261 exists to remove, reintroduced by
     * the fix for it.
     */
    /*
     * THE TURN CARRIES A DATA PART, DELIBERATELY. A text-only turn produces
     * nothing that reaches the `data-*` render dispatch at all, so "no pause
     * card" would be true of it however over-broad the pause branch was — the
     * companion could not fail. A `data-task` frame drives the same dispatch the
     * pause branch lives in, so a branch that matched too much renders a pause
     * card here and this goes red.
     */
    await openChatStreaming(page, [
      `data: {"type":"start","messageId":"m1"}`,
      `data: {"type":"data-task","data":{"id":"t-1","seq":0,"taskName":"read a file","status":"done"}}`,
      `data: {"type":"text-start","id":"t1"}`,
      `data: {"type":"text-delta","id":"t1","delta":"done"}`,
      `data: {"type":"text-end","id":"t1"}`,
    ]);

    // The dispatch really ran — otherwise "no pause card" is true of a page that
    // rendered nothing at all.
    await expect(page.getByTestId("task-card").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("approval-pause-card")).toHaveCount(0);
  });
});
