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

test.describe("open-swe board card — what a person reads at a glance", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("a card carries its status as DATA, not only as a colour", async ({
    page,
  }) => {
    // Colour is unreadable to a test, a screen reader, and anyone diffing a
    // DOM snapshot. Without this the cases below could only assert the label
    // text, which is exactly what the bug got wrong.
    await mockRuns(page, [run("a", "running")]);
    await page.goto("/");

    const pill = page.getByTestId("run-status").first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("data-status", "running");
  });

  test("NO STATUS RENDERS AS ITS RAW ENUM VALUE", async ({ page }) => {
    // The regression, end to end. Every status the platform can report, on one
    // board, each asserted against its own raw value — so a fall-through
    // returning `label: status` fails here for four of the seven.
    const statuses = [
      "pending",
      "running",
      "completed",
      "failed",
      "interrupted",
      "idle",
      "unknown",
    ];
    await mockRuns(
      page,
      statuses.map((s, i) => run(`r${i}`, s))
    );
    await page.goto("/");
    await expect(page.getByTestId("run-list-card").first()).toBeVisible();

    for (const s of statuses) {
      const pill = page.locator(`[data-testid="run-status"][data-status="${s}"]`);
      await expect(pill, `no card rendered for ${s}`).toHaveCount(1);
      const label = ((await pill.innerText()) ?? "").trim();
      expect(label, `${s} rendered as its own enum value`).not.toBe(s);
      expect(label.length, `${s} has no label`).toBeGreaterThan(0);
    }
  });

  test("INTERRUPTED READS AS NEEDING APPROVAL, and is flagged actionable", async ({
    page,
  }) => {
    // The state the whole "Needs approval" column exists for. It rendered as
    // the lowercase word "interrupted" in muted grey — the styling used for
    // states that need nothing from anybody.
    await mockRuns(page, [run("a", "interrupted")]);
    await page.goto("/");

    const pill = page.getByTestId("run-status").first();
    await expect(pill).toContainText(/needs approval/i);
    await expect(pill).toHaveAttribute("data-actionable", "true");
  });

  test("and it is the ONLY status flagged actionable", async ({ page }) => {
    // The control. "Flag what needs attention" is satisfied by flagging
    // everything, which tells a person scanning a board precisely nothing.
    await mockRuns(page, [
      run("a", "interrupted"),
      run("b", "running"),
      run("c", "completed"),
      run("d", "failed"),
      run("e", "idle"),
    ]);
    await page.goto("/");
    await expect(page.getByTestId("run-list-card").first()).toBeVisible();

    await expect(
      page.locator('[data-testid="run-status"][data-actionable="true"]')
    ).toHaveCount(1);
  });

  test("an IDLE run does not claim to have completed", async ({ page }) => {
    // #176 and #246 both turned on this: idle means the thread is not
    // executing, which is equally true before a run and after a failure.
    await mockRuns(page, [run("a", "idle")]);
    await page.goto("/");

    const pill = page.getByTestId("run-status").first();
    await expect(pill).toBeVisible();
    await expect(pill).not.toContainText(/complete|done|success/i);
  });

  test("the card shows WHEN the run was created, in words", async ({ page }) => {
    // Rendered by nothing any test touched. It is how a person spots the
    // seventeen day-old cards that started #246 in the first place.
    await mockRuns(page, [
      run("a", "running", { created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    ]);
    await page.goto("/");

    const t = page.getByTestId("run-created-at").first();
    await expect(t).toBeVisible();
    await expect(t).toContainText(/3 hrs ago/);
    // The machine-readable value too, so the rendering is not the only record.
    await expect(t).toHaveAttribute("datetime", /^\d{4}-/);
  });

  test("a card with a broken timestamp renders no time rather than NaN", async ({
    page,
  }) => {
    // A board must not shout a JavaScript artefact at whoever opens it, and
    // the card must still be there — losing the run would be worse.
    await mockRuns(page, [run("a", "running", { created_at: "not-a-date" })]);
    await page.goto("/");

    await expect(page.getByTestId("run-list-card")).toHaveCount(1);
    const t = page.getByTestId("run-created-at").first();
    expect(((await t.innerText()) ?? "").trim()).toBe("");
  });

  test("clicking a card opens that run, carrying its thread", async ({ page }) => {
    // The single most common navigation in the app, and the link must carry
    // threadId — without it the detail page has nothing to subscribe to and
    // renders "threadId is required".
    await mockRuns(page, [run("abc", "running")]);
    await page.goto("/");

    const link = page.getByTestId("run-detail-link").first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("/runs/abc");
    expect(href).toContain("threadId=th-abc");
  });
});

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
    await page.route("**/api/chat/stream**", (route) => {
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

    await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThan(0);
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
    await page.route("**/api/chat/stream**", (route) =>
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
