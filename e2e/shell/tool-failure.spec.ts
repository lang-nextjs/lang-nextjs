import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * A TOOL THAT FAILED MUST NOT LOOK LIKE ONE THAT SUCCEEDED.
 *
 * `ToolCallMessage["status"]` was `"running" | "complete"` while the AI SDK
 * reports five tool-part states, so the converter filed two of them under
 * success:
 *
 *   output-error   -> "complete"   the tool THREW
 *   output-denied  -> "complete"   a human REFUSED it
 *
 * Both apps render on that status, so a failed tool drew a GREEN dot with the
 * literal word "complete" beside it. The error TEXT came through the whole
 * time, which is why reading a transcript never revealed it: the right words
 * were on screen under the wrong colour.
 *
 * A census over every `data-testid` in the tree found no test anywhere —
 * e2e or unit — driving `output-error` through a rendered surface. The five
 * unit references to it were all in converter tests, one of which ASSERTED
 * `status === "complete"` and passed.
 *
 * These cases drive the real chat surface with real AI-SDK frames.
 */

const SSE = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};

/**
 * Serve one assistant turn made of exactly these frames.
 *
 * THE FRAME SHAPES ARE `z.strictObject` IN THE SDK, so an EXTRA key is a hard
 * rejection, not an ignored field. The first version of this file put
 * `toolName` on the output frames — where it is legal on the INPUT frames and
 * absent from the output ones — and every case died with
 *
 *   Type validation failed: Value: {"type":"tool-outp…
 *
 * rendered as a red banner over the page. Copied from ai@6's own schema rather
 * than from memory:
 *
 *   tool-input-start      toolCallId, toolName
 *   tool-input-available  toolCallId, toolName, input
 *   tool-output-available toolCallId, output          (no toolName)
 *   tool-output-error     toolCallId, errorText       (no toolName)
 */
async function streamTurn(page: Page, frames: object[]) {
  await page.route(
    "**/api/chat/stream",
    (route) =>
      void route.fulfill({
        status: 200,
        headers: SSE,
        body:
          frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n",
      })
  );
}

const CALL = [
  { type: "tool-input-start", toolCallId: "tc-1", toolName: "increment" },
  {
    type: "tool-input-available",
    toolCallId: "tc-1",
    toolName: "increment",
    input: { by: 1 },
  },
];

async function send(page: Page, text = "run the tool") {
  await page.goto("/chat");
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press("Enter");
}

test.describe("open-swe chat — a tool that fails is shown as failed", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("A TOOL THAT THREW IS NOT MARKED complete", async ({ page }) => {
    // The headline. Against the previous build this rendered `complete`, in
    // the success colour, with the error text sitting in the result slot.
    await streamTurn(page, [
      ...CALL,
      {
        type: "tool-output-error",
        toolCallId: "tc-1",
        errorText: "counter service unavailable",
      },
      { type: "finish" },
    ]);
    await send(page);

    const card = page.getByTestId("tool-card").first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Asserted on DATA, not colour: a class name is unreadable to a test, a
    // screen reader, or anyone diffing a snapshot.
    await expect(card.locator("[data-tool-status]").first()).toHaveAttribute(
      "data-tool-status",
      "error"
    );
    await expect(card).not.toContainText(/\bcomplete\b/);
  });

  test("the error message is shown, not just a red dot", async ({ page }) => {
    // A colour tells a person something is wrong. Only the text tells them
    // what, and this half always worked — asserted so fixing the status
    // cannot quietly cost the message.
    await streamTurn(page, [
      ...CALL,
      {
        type: "tool-output-error",
        toolCallId: "tc-1",
        errorText: "counter service unavailable",
      },
      { type: "finish" },
    ]);
    await send(page);

    const card = page.getByTestId("tool-card").first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    /*
     * WHAT THIS TEST USED TO DO, AND WHY IT PROVED LESS THAN IT CLAIMED (#346).
     *
     *     await card.click(); // the card is a <details>; the message lives inside
     *     await expect(card).toContainText("counter service unavailable");
     *
     * THE INTERACTION CONTRIBUTED NOTHING: deleting the click entirely left the test passing.
     * Measured, not inferred. `toContainText` reads textContent, which includes text inside a
     * CLOSED disclosure, so the assertion was satisfied by a message present in the DOM and
     * invisible on screen — in a test named "the error message is SHOWN". It would have gone
     * on passing if the message became permanently unreachable.
     *
     * THE COMMENT WAS ALSO WRONG ABOUT THE DOM, and the way it was wrong is worth keeping.
     * `tool-card` is a <div> WRAPPING a <details>; it is not one. The click nevertheless
     * opened the disclosure — Playwright dispatches a real mouse event at the element's
     * CENTRE, and on a collapsed card the centre lands on the <summary>. So it worked by
     * GEOMETRY rather than by targeting, which is worse than a no-op: add padding, or a second
     * row to the summary, and the same line starts clicking somewhere else with nothing to say
     * that it has. (Verified: replacing `summary.click()` with `card.click()` still passes
     * today. This test does not police that, and cannot — which is why the convention in
     * playwright.config.ts asks the author to target the control and assert it responded.)
     *
     * Both halves are now asserted, and the first is the one the name promises: the message is
     * READABLE WITHOUT INTERACTING, because the summary carries a preview of the result. That
     * was always true; the click was never needed for it.
     */
    const summary = card.locator("summary");
    await expect(
      summary.getByText("counter service unavailable"),
      "the message must be readable on the collapsed card — that is what 'shown' means"
    ).toBeVisible();

    // The disclosure opens from its own control, and the interaction is asserted to have
    // LANDED before anything is asserted about what it revealed. When this decays — as it did
    // when the control moved — the failure names the interaction instead of surfacing three
    // lines later as a missing message.
    await summary.click();
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await expect(
      card.locator("details > div").getByText("counter service unavailable"),
      "expanding must reveal the full result, not just the truncated preview"
    ).toBeVisible();
  });

  test("A SUCCESSFUL TOOL IS STILL MARKED complete", async ({ page }) => {
    // The control, and it is not optional: without it, a build that marked
    // EVERY tool as failed passes the case above. That is the same defect
    // pointing the other way, and it would send people to investigate tools
    // that worked.
    await streamTurn(page, [
      ...CALL,
      {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: "Counter incremented to 38",
      },
      { type: "finish" },
    ]);
    await send(page);

    const card = page.getByTestId("tool-card").first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator("[data-tool-status]").first()).toHaveAttribute(
      "data-tool-status",
      "complete"
    );
  });

  test("a failed and a successful tool in ONE turn are told apart", async ({
    page,
  }) => {
    // The shape that made this worth an e2e rather than another unit test: an
    // agent turn routinely calls several tools, and a person needs to see
    // WHICH one failed. A per-card status is the only thing that can say.
    await streamTurn(page, [
      { type: "tool-input-start", toolCallId: "ok-1", toolName: "get_counter" },
      {
        type: "tool-input-available",
        toolCallId: "ok-1",
        toolName: "get_counter",
        input: {},
      },
      { type: "tool-output-available", toolCallId: "ok-1", output: "37" },
      { type: "tool-input-start", toolCallId: "bad-1", toolName: "increment" },
      {
        type: "tool-input-available",
        toolCallId: "bad-1",
        toolName: "increment",
        input: { by: 1 },
      },
      {
        type: "tool-output-error",
        toolCallId: "bad-1",
        errorText: "write refused",
      },
      { type: "finish" },
    ]);
    await send(page);

    await expect(page.getByTestId("tool-card")).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page.locator('[data-tool-status="complete"]')).toHaveCount(1);
    await expect(page.locator('[data-tool-status="error"]')).toHaveCount(1);
  });

  test("a tool still running is neither complete nor errored", async ({
    page,
  }) => {
    // The third leg. A card that reached a terminal state early is how a
    // person concludes an agent is finished while it is still working.
    await streamTurn(page, CALL);
    await send(page);

    const card = page.getByTestId("tool-card").first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const status = await card
      .locator("[data-tool-status]")
      .first()
      .getAttribute("data-tool-status");
    expect(status).toBe("running");
  });
  /*
   * `"**\/api/chat/stream"` WITHOUT A TRAILING `**` (#361). The wildcard
   * form also matched `/api/chat/stream/resume?resumeId=…`, so once open-swe
   * gained a resume route this stub answered the mount-time resume GET with
   * chat SSE frames — delivering the scripted body twice, which showed up
   * here as four tool cards where the spec asserts two.
   */
});
