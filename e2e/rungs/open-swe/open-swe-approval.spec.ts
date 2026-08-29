import { test, expect, type Page } from "@playwright/test";

/**
 * The approval card POSTs a DECISION, it does not send a message (#160 gap 1).
 *
 * WHAT CHANGED, and why a reviewer diffing callbacks would miss half of it:
 * the old code handled `data-approval` and called
 * sendMessage(`Approved: ${actionName}`) — a new chat message containing that
 * literal text. This handles `data-approval-required`, the frame the gating
 * transform emits when it actually stops the stream, and POSTs to
 * /api/approval/[approvalId], which resumes the paused run. The frame type
 * changed as well as the callback; the rename is the substance, not cosmetics.
 *
 * SCOPE OF THIS FILE. It covers the CLIENT half: the card renders on the gate's
 * frame, the buttons reach the approval endpoint with the right decision and
 * id, and no chat turn is sent. The server half — that the gate pauses a
 * mutating tool call and that a decision releases the buffered frames — lives
 * in packages/server's approval tests and was additionally verified live
 * against a real backend (a write_file request produced a
 * data-approval-required frame and no write_file tool frame reached the
 * client). Playwright cannot mock a server-side upstream, so asserting the
 * pause here would mean asserting it against a stub of our own proxy.
 */

const SSE = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

const APPROVAL_ID = "ap-1";

async function mockConfig(page: Page) {
  await page.route("**/api/config*", (route) =>
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
  await page.route("**/api/chat/tools**", (route) =>
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [], mcpServers: [] }),
    })
  );
}

/** The gate's frame, as createApprovalGatingTransform emits it. */
async function mockGatedStream(page: Page) {
  await page.route("**/api/chat/stream", (route) =>
    void route.fulfill({
      status: 200,
      headers: { ...SSE },
      body:
        [
          `data: {"type":"start","messageId":"m1"}`,
          `data: {"type":"data-approval-required","data":{"id":"${APPROVAL_ID}","seq":0,"actionName":"write_file","description":"Approval required for write_file","arguments":{"path":"/tmp/x"},"status":"waiting","createdAt":"2026-05-25T00:00:00Z","expiresAt":null}}`,
        ].join("\n\n") + "\n\n",
    })
  );
}

/** Capture decisions POSTed to the approval endpoint. */
async function captureDecisions(page: Page) {
  const seen: { url: string; body: string }[] = [];
  await page.route("**/api/approval/**", (route) => {
    seen.push({
      url: route.request().url(),
      body: route.request().postData() ?? "",
    });
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: APPROVAL_ID, decision: "approve", accepted: true }),
    });
  });
  return seen;
}

async function openGatedChat(page: Page) {
  await mockConfig(page);
  await mockTools(page);
  await mockGatedStream(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-input").fill("write a file");
  await page.getByTestId("chat-send").click();
}

test.describe("open-swe /chat — approval resolves the run, it does not chat about it", () => {
  test("approve POSTs the decision to the approval endpoint, keyed by approval id", async ({
    page,
  }) => {
    const decisions = await captureDecisions(page);
    await openGatedChat(page);

    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "write_file"
    );

    await page.getByTestId("approve-button").click();
    await expect.poll(() => decisions.length).toBeGreaterThan(0);

    // The id must be in the URL: a decision that reached the endpoint without
    // naming which approval it settles would resolve nothing, and a 200 would
    // still come back.
    expect(decisions[0].url).toContain(`/api/approval/${APPROVAL_ID}`);
    expect(decisions[0].body).toContain("approve");
  });

  test("reject POSTs reject, not approve", async ({ page }) => {
    const decisions = await captureDecisions(page);
    await openGatedChat(page);

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("reject-button").click();
    await expect.poll(() => decisions.length).toBeGreaterThan(0);

    // The control for the test above. Without it, a card wired to send
    // "approve" from both buttons would pass the approve case and silently
    // approve everything the user rejected — the worst possible direction for
    // this particular control.
    expect(decisions[0].body).toContain("reject");
    expect(decisions[0].body).not.toContain('"approve"');
  });

  test("resolving does NOT send a chat turn — the old behaviour must not return", async ({
    page,
  }) => {
    const decisions = await captureDecisions(page);
    let chatPosts = 0;
    await mockConfig(page);
    await mockTools(page);
    await page.route("**/api/chat/stream", (route) => {
      chatPosts++;
      void route.fulfill({
        status: 200,
        headers: { ...SSE },
        body:
          [
            `data: {"type":"start","messageId":"m1"}`,
            `data: {"type":"data-approval-required","data":{"id":"${APPROVAL_ID}","seq":0,"actionName":"write_file","description":"d","arguments":{},"status":"waiting","createdAt":"2026-05-25T00:00:00Z","expiresAt":null}}`,
          ].join("\n\n") + "\n\n",
      });
    });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("write a file");
    await page.getByTestId("chat-send").click();
    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });

    const postsBeforeDecision = chatPosts;
    await page.getByTestId("approve-button").click();
    await expect.poll(() => decisions.length).toBeGreaterThan(0);
    await page.waitForTimeout(1000);

    // THE REGRESSION GUARD. The old implementation answered an approval by
    // sending `Approved: write_file` as a new user turn — a second POST to the
    // chat endpoint. If that ever comes back, this fails.
    expect(
      chatPosts,
      "resolving an approval must not start a new chat turn"
    ).toBe(postsBeforeDecision);
  });

  test("the card is dismissed once its decision is accepted", async ({
    page,
  }) => {
    await captureDecisions(page);
    await openGatedChat(page);

    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("approve-button").click();

    // The stream carries no follow-up status for a resolved approval, so a card
    // that stayed visible would invite the user to decide the same thing twice.
    await expect(card).toBeHidden({ timeout: 10_000 });
  });
});
