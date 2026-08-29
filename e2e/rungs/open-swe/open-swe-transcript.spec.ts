import { test, expect, type Page } from "@playwright/test";

/**
 * The saved-transcript record on /chat (#122).
 *
 * WHAT IS BEING ASSERTED. Not "a transcript renders" — that a transcript
 * renders AS A RECORD, that eviction is stated rather than silent, and that an
 * unreadable transcript never renders as an empty one.
 *
 * The last of those is #140's distinction applied at the moment it was
 * designed in rather than discovered: a malformed store and an absent store
 * must not produce the same screen. Here they do not, which is the difference
 * between this feature and the workspace panel it was modelled on.
 *
 * All state is planted directly into localStorage via addInitScript, so these
 * tests never depend on a backend or on having sent a message.
 */

const TRANSCRIPT_KEY = "open-swe:transcripts:v1";
const CONVERSATIONS_KEY = "open-swe:conversations:v1";
const CONV_ID = "c-restore";

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

/** Plant a raw transcript-store value before any app code runs. */
async function plantStore(page: Page, rawTranscripts: string) {
  await page.addInitScript(
    ([tKey, cKey, id, raw]) => {
      window.localStorage.setItem(raw === "__ABSENT__" ? "__unused__" : tKey, raw);
      window.localStorage.setItem(
        cKey,
        JSON.stringify([
          {
            id,
            title: "Restored chat",
            framework: "deepagents",
            updatedAt: "2026-05-25T00:00:00Z",
          },
        ])
      );
    },
    [TRANSCRIPT_KEY, CONVERSATIONS_KEY, CONV_ID, rawTranscripts] as const
  );
}

const entry = (role: "user" | "agent", text: string) => ({
  role,
  text,
  at: "2026-05-25T00:00:00Z",
});

test.describe("open-swe /chat — a restored transcript is a RECORD, not resumed context", () => {
  test("a saved transcript renders as a labelled record, with the divergence stated", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(
      page,
      JSON.stringify({
        [CONV_ID]: {
          entries: [entry("user", "what did we decide"), entry("agent", "we decided X")],
          evicted: false,
        },
      })
    );

    await page.goto(`/chat?c=${CONV_ID}`);

    const record = page.getByTestId("transcript-record");
    await expect(record).toBeVisible();
    await expect(record).toHaveAttribute("data-transcript-state", "ok");
    await expect(page.getByTestId("transcript-entry")).toHaveCount(2);
    await expect(record).toContainText("what did we decide");
    await expect(record).toContainText("we decided X");

    // THE ASSERTION THIS FEATURE EXISTS FOR. The transcript comes from
    // localStorage; the agent's memory comes from sessionId on the backend and
    // may be empty, expired, or on another process. A user reading their own
    // history will assume the agent has it, so the divergence has to be stated
    // on screen rather than left in a comment.
    await expect(page.getByTestId("transcript-record-caveat")).toContainText(
      /agent may not have this context/i
    );
  });

  test("an EVICTED transcript says it starts mid-conversation", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(
      page,
      JSON.stringify({
        [CONV_ID]: { entries: [entry("user", "surviving message")], evicted: true },
      })
    );

    await page.goto(`/chat?c=${CONV_ID}`);

    // A truncated transcript that renders silently looks complete — that is
    // the defect this feature would otherwise introduce, so the notice is not
    // decoration.
    const notice = page.getByTestId("transcript-evicted");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/dropped to stay within browser storage/i);
    await expect(page.getByTestId("transcript-record")).toContainText(
      "surviving message"
    );
  });

  test("a transcript with NO eviction shows no eviction notice", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(
      page,
      JSON.stringify({
        [CONV_ID]: { entries: [entry("user", "all of it")], evicted: false },
      })
    );

    await page.goto(`/chat?c=${CONV_ID}`);

    // The control for the test above: without this, an implementation that
    // always showed the notice would pass the eviction case and be wrong.
    await expect(page.getByTestId("transcript-record")).toBeVisible();
    await expect(page.getByTestId("transcript-evicted")).toHaveCount(0);
  });

  test("MALFORMED transcript renders as unreadable — NOT as an empty conversation", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    // Valid JSON, invalid shape: `role` is outside the union. The parser
    // throws rather than dropping the entry, so this cannot degrade into a
    // shorter transcript that still looks complete.
    await plantStore(
      page,
      JSON.stringify({
        [CONV_ID]: {
          entries: [{ role: "wizard", text: "x", at: "2026-05-25T00:00:00Z" }],
        },
      })
    );

    await page.goto(`/chat?c=${CONV_ID}`);

    // #140's distinction, designed in rather than discovered. A malformed
    // store and an absent store must not produce the same screen.
    const record = page.getByTestId("transcript-record");
    await expect(record).toBeVisible();
    await expect(record).toHaveAttribute("data-transcript-state", "unreadable");
    await expect(record).toContainText(/could not be read/i);
    // And it must NOT quietly present as "no history".
    await expect(page.getByTestId("transcript-entry")).toHaveCount(0);
  });

  test("unparseable JSON is also unreadable, not empty", async ({ page }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(page, "{not json at all");

    await page.goto(`/chat?c=${CONV_ID}`);

    await expect(page.getByTestId("transcript-record")).toHaveAttribute(
      "data-transcript-state",
      "unreadable"
    );
  });

  test("a conversation with genuinely no transcript shows NO record block at all", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(page, JSON.stringify({}));

    await page.goto(`/chat?c=${CONV_ID}`);

    // The positive control that makes "unreadable" meaningful: absent must be
    // visibly different from unreadable, and the live composer must still be
    // usable rather than the page having failed to render.
    await expect(page.getByTestId("transcript-record")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
  });

  test("a blocked localStorage write is stated, not swallowed", async ({
    page,
  }) => {
    await mockConfig(page);
    await mockTools(page);
    await plantStore(page, JSON.stringify({}));
    // Private windows and blocked site-data make setItem throw. A history that
    // silently is not being saved is the same lie as a truncated one.
    await page.addInitScript(() => {
      const proto = Object.getPrototypeOf(window.localStorage);
      const real = proto.setItem;
      proto.setItem = function (k: string, v: string) {
        if (k === "open-swe:transcripts:v1") {
          throw new DOMException("QuotaExceededError");
        }
        return real.call(this, k, v);
      };
    });

    await page.goto(`/chat?c=${CONV_ID}`);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("this will not be saved");
    await page.getByTestId("chat-send").click();

    await expect(page.getByTestId("transcript-write-error")).toBeVisible();
    await expect(page.getByTestId("transcript-write-error")).toContainText(
      /not being saved/i
    );
  });
});
