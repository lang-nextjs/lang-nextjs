import { test, expect, type Page } from "@playwright/test";

/**
 * THE APPROVAL CARD HAS TO BE READABLE (#256 companion).
 *
 * Reported from a running chat, verbatim:
 *
 *   incrementwaiting
 *   Approval required for increment
 *   {}
 *   ApproveRejectEditRespond
 *
 * Two labels fused into a non-word and four buttons fused into another. The
 * component was not broken: `ApprovalCard` is deliberately headless — its own
 * docblock says "no opinions about layout, colors" — and this app passed only an
 * outer className, so every inner element rendered bare.
 *
 * THAT IS THE FAILURE MODE OF HEADLESS LIBRARIES, and it is why this is worth
 * pinning rather than just fixing: the default is not "plain", it is WRONG, and
 * it looks like a rendering bug rather than a missing stylesheet. Nothing
 * failed, no console error, no test went red — the card simply became
 * unreadable, in the one place where a person is being asked to authorise
 * something.
 *
 * These cases assert LEGIBILITY, not appearance. No colours, no class names, no
 * pixel values — a design change should not fail them. What must hold is that
 * two adjacent facts do not read as one word, and that four choices are four
 * targets.
 */

/**
 * The frame the gating transform actually emits — `data-approval-required`,
 * with the full schema. Transcribed from open-swe-approval.spec.ts rather than
 * invented: my first version used `data-approval` with a partial payload, the
 * card never rendered, and every assertion failed for a reason that had nothing
 * to do with legibility.
 */
const APPROVAL_ID = "ap-legibility-1";
const APPROVAL_FRAME =
  `data: {"type":"data-approval-required","data":{"id":"${APPROVAL_ID}","seq":0,` +
  `"actionName":"increment","description":"Approval required for increment",` +
  `"arguments":{},"status":"waiting","createdAt":"2026-05-25T00:00:00Z","expiresAt":null}}`;

const SSE = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
} as const;

/** Stream a single approval part, then hold the stream open. */
async function stageApproval(page: Page): Promise<void> {
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
  await page.route("**/api/chat/stream", (r) =>
    void r.fulfill({
      status: 200,
      headers: { ...SSE },
      body:
        [
          `data: {"type":"start","messageId":"m1"}`,
          APPROVAL_FRAME,
          `data: {"type":"finish","finishReason":"stop"}`,
        ].join("\n\n") + "\n\n",
    })
  );
}

async function askAndWait(page: Page): Promise<void> {
  await page.getByTestId("chat-input").fill("increment it by 1");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("approval-card")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("the approval card is legible", () => {
  test.beforeEach(async ({ page }) => {
    await stageApproval(page);
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await askAndWait(page);
  });

  test("THE REPORTED SYMPTOM: the action name and status do not fuse into one word", async ({
    page,
  }) => {
    // `incrementwaiting`. The defect exists BETWEEN two elements that are each
    // correct, which is exactly what a per-element assertion cannot see.
    //
    // MEASURED, NOT MATCHED ON TEXT. My first version asserted the rendered
    // string did not contain "incrementwaiting" — and then a `uppercase` style
    // turned it into "incrementWAITING", which passes a substring check while
    // being just as fused. Text matching answers "are these characters
    // adjacent in the DOM", which is a narrower question than "do these read as
    // two things".
    const name = await page.getByTestId("approval-action-name").boundingBox();
    const status = await page.getByTestId("approval-status").boundingBox();
    expect(name, "action name should be rendered").not.toBeNull();
    expect(status, "status should be rendered").not.toBeNull();

    const gap = status!.x - (name!.x + name!.width);
    const stacked = status!.y >= name!.y + name!.height;
    expect(
      gap > 2 || stacked,
      `the action name and its status are touching (gap ${gap.toFixed(1)}px) — ` +
        "rendered, that reads as one word"
    ).toBe(true);

    // And both facts are still present, case-insensitively so a style choice
    // about capitalisation is not a test failure.
    const text = (await page.getByTestId("approval-card").innerText()).toLowerCase();
    expect(text).toContain("increment");
    expect(text).toContain("waiting");
  });

  test("the four choices do not fuse into one word either", async ({ page }) => {
    // MEASURED, for the same reason as the case above — which this one
    // originally contradicted. It asserted `not.toContain("ApproveReject")`,
    // the exact substring technique the previous docblock condemns, and
    // defeated by the exact same styling change: an `uppercase` rule turns it
    // into "APPROVEREJECT" and the assertion passes while the buttons stay
    // fused. Adjacent boxes are the property; the characters are not.
    const boxes = await Promise.all(
      ["approve-button", "reject-button", "show-edit-button", "show-respond-button"].map(
        (id) => page.getByTestId(id).boundingBox()
      )
    );
    const laidOut = boxes.map((b) => b!).sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 1; i < laidOut.length; i++) {
      const prev = laidOut[i - 1];
      const cur = laidOut[i];
      const gap = cur.x - (prev.x + prev.width);
      const stacked = cur.y >= prev.y + prev.height;
      expect(
        gap > 2 || stacked,
        `buttons ${i - 1} and ${i} are touching (gap ${gap.toFixed(1)}px)`
      ).toBe(true);
    }
  });

  test("each choice is a separate, clickable target", async ({ page }) => {
    // The consequence of the fusion, stated as behaviour rather than layout: if
    // the four buttons occupy one run of text with no separation, a person
    // aiming for Reject can land on Approve.
    for (const id of [
      "approve-button",
      "reject-button",
      "show-edit-button",
      "show-respond-button",
    ]) {
      const b = page.getByTestId(id);
      await expect(b, id).toBeVisible();
      const box = await b.boundingBox();
      expect(box, `${id} should have a real hit area`).not.toBeNull();
      expect(box!.width, `${id} width`).toBeGreaterThan(24);
      expect(box!.height, `${id} height`).toBeGreaterThan(16);
    }
  });

  test("the buttons do not OVERLAP each other", async ({ page }) => {
    // A hit area exists per button and they are laid out side by side. Two
    // overlapping boxes would satisfy the case above while still sending a
    // click to the wrong one.
    const boxes = await Promise.all(
      ["approve-button", "reject-button"].map((id) =>
        page.getByTestId(id).boundingBox()
      )
    );
    const [a, b] = boxes.map((x) => x!);
    const overlaps =
      a.x < b.x + b.width &&
      b.x < a.x + a.width &&
      a.y < b.y + b.height &&
      b.y < a.y + a.height;
    expect(overlaps, "approve and reject must not overlap").toBe(false);
  });

  test("APPROVE IS DISTINGUISHABLE FROM REJECT without reading the label", async ({
    page,
  }) => {
    // The consequential control must not look identical to the destructive
    // one. Asserted as "their computed colours differ" rather than naming a
    // colour, so a redesign is free to choose different ones.
    // ANY of colour, background or border — not `color` specifically. Pinning
    // one property means a redesign that moves the distinction to the border,
    // while fully PRESERVING the property under test, turns this red. The claim
    // is "these look different", not "these differ in the way I chose today".
    const styleOf = (id: string) =>
      page.getByTestId(id).evaluate((el) => {
        const c = getComputedStyle(el as HTMLElement);
        return [c.color, c.backgroundColor, c.borderColor].join("|");
      });
    const [approve, reject] = await Promise.all([
      styleOf("approve-button"),
      styleOf("reject-button"),
    ]);
    expect(
      approve,
      "approve and reject are visually identical — the consequential control " +
        "must not look like the destructive one"
    ).not.toBe(reject);
  });

  test("an EMPTY argument payload does not render as debris", async ({
    page,
  }) => {
    // `{}` on its own line read as leftover output. It is still shown — hiding
    // the arguments would be worse — but it must be typographically subordinate
    // to the question being asked.
    // NO `if (count === 0) return`. That was a silent skip in the body — the
    // repo ships scripts/assert-no-silent-skips.mjs for exactly this defect
    // class, and it greps for `.skip(` / `.todo(`, so an in-body return is
    // invisible to it. If the element disappeared, the test would go green
    // forever. The element is asserted to exist instead.
    const args = page.getByTestId("approval-arguments");
    await expect(args, "the arguments payload should be rendered").toBeVisible();
    const size = await args.evaluate(
      (el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize)
    );
    const bodySize = await page
      .getByTestId("approval-description")
      .evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize));
    expect(size, "arguments should not shout louder than the question").toBeLessThanOrEqual(
      bodySize
    );
  });

  test("the card still says WHAT is being approved", async ({ page }) => {
    // The control for every styling assertion above: a card that is beautifully
    // laid out and no longer names the action is worse than the fused version.
    await expect(page.getByTestId("approval-card")).toContainText("increment");
    await expect(page.getByTestId("approval-description")).toBeVisible();
  });
});
