import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * THE QUEUE AS A LIVE SURFACE — polling, recovery, and hostile data.
 *
 * The board's structural properties are covered: conservation, columns,
 * ordering, routing. What none of that touches is that the board is not a
 * snapshot. `useRuns` polls on an interval, refetches when the tab becomes
 * visible again, and — the part worth the most here — on a failed poll it
 * records the error WITHOUT clearing the runs it already has.
 *
 * THAT LAST ONE IS THE HEADLINE. A poll that fails and blanks the board tells a
 * person their work has disappeared, at the exact moment the truth is only that
 * one request did. `setRuns` is not called in the catch, and nothing held that
 * in place: every existing case renders the board from a single successful
 * fetch, which is the one situation where "keeps the previous runs" and "has no
 * previous runs to keep" are indistinguishable.
 *
 * A note on what these do NOT assert: nothing here pins the 5s interval. The
 * cadence is a tuning decision and a test that encodes it turns a config change
 * into a failure. What is pinned is that polling HAPPENS, that a failure is
 * survivable, and that recovery is automatic.
 */

const run = (id: string, status: string, task = `task ${id}`) => ({
  run_id: id,
  thread_id: `th-${id}`,
  status,
  task,
  created_at: "2026-01-01T00:00:00Z",
});

/**
 * Serve a different body on each successive GET.
 *
 * Returns a counter so a test can assert that polling actually happened rather
 * than assuming it. The last entry repeats once the list is exhausted, so a
 * test never depends on how many polls fired before its assertion ran.
 */
function serveSequence(
  page: Page,
  responses: Array<{ status: number; body: unknown }>
): { calls: () => number } {
  let n = 0;
  void page.route("**/api/open-swe/runs", (route) => {
    if (route.request().method() !== "GET") return void route.fallback();
    const r = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return void route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: JSON.stringify(r.body),
    });
  });
  return { calls: () => n };
}

const cards = (page: Page) => page.getByTestId("run-list-card");

test.describe("queue — the board is polled, not snapshotted", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("the board REFETCHES on its own, with no interaction", async ({
    page,
  }) => {
    const seq = serveSequence(page, [{ status: 200, body: [] }]);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    const first = seq.calls();
    // No click, no reload. If nothing polls, this never moves.
    await expect.poll(() => seq.calls(), { timeout: 20_000 }).toBeGreaterThan(
      first
    );
  });

  test("a run that appears between polls SHOWS UP without a reload", async ({
    page,
  }) => {
    // The whole reason the board polls: work dispatched elsewhere — another
    // tab, a colleague, the agent itself — has to arrive here on its own.
    serveSequence(page, [
      { status: 200, body: [] },
      { status: 200, body: [run("late", "running", "arrived by poll")] },
    ]);
    await page.goto("/");
    await expect(
      page.getByText("arrived by poll", { exact: true })
    ).toBeVisible({ timeout: 20_000 });
  });

  test("a run that CHANGES STATUS moves columns on its own", async ({
    page,
  }) => {
    serveSequence(page, [
      { status: 200, body: [run("r1", "pending", "moving task")] },
      { status: 200, body: [run("r1", "completed", "moving task")] },
    ]);
    await page.goto("/");
    await expect(
      page.getByTestId("board-column-done").getByText("moving task")
    ).toBeVisible({ timeout: 20_000 });
  });

  test("a run REMOVED from the API leaves the board", async ({ page }) => {
    // The other direction. A board that only ever adds would accumulate runs
    // that no longer exist, which is a queue that cannot be trusted to be short.
    serveSequence(page, [
      { status: 200, body: [run("gone", "running", "temporary task")] },
      { status: 200, body: [] },
    ]);
    await page.goto("/");
    await expect(page.getByText("temporary task")).toBeVisible();
    await expect(page.getByText("temporary task")).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});

test.describe("queue — a failed poll must not erase the board", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("THE HEADLINE: a poll that fails KEEPS the runs already shown", async ({
    page,
  }) => {
    // `setRuns` is deliberately absent from the catch block. Blanking the board
    // on a transient failure says "your work is gone" when the truth is "one
    // request failed" — and the board recovers on the next tick anyway, so the
    // blank is both alarming and temporary, which is the worst combination.
    serveSequence(page, [
      { status: 200, body: [run("keep", "running", "still mine")] },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    await page.goto("/");
    await expect(page.getByText("still mine")).toBeVisible();
    // Give the failing polls time to land, then assert the card SURVIVED them.
    await expect(page.getByTestId("runs-error")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("still mine")).toBeVisible();
  });

  test("the failure is REPORTED while the stale board is shown", async ({
    page,
  }) => {
    // Keeping the runs is only honest if the page also says the list is no
    // longer being updated. Silently showing stale work is the other failure.
    serveSequence(page, [
      { status: 200, body: [run("keep", "running", "still mine")] },
      { status: 500, body: {} },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("runs-error")).toBeVisible({
      timeout: 20_000,
    });
    await expect(cards(page)).toHaveCount(1);
  });

  test("RECOVERY: the error clears by itself when a poll succeeds again", async ({
    page,
  }) => {
    // `setError(null)` on the success path. Without it the banner outlives the
    // outage and every later board is read as broken.
    serveSequence(page, [
      { status: 200, body: [run("r1", "running", "recovering task")] },
      { status: 500, body: {} },
      { status: 200, body: [run("r1", "completed", "recovering task")] },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("runs-error")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("runs-error")).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test("a board that fails on its FIRST poll shows the error, not an empty queue", async ({
    page,
  }) => {
    // No previous runs to preserve. The distinction that matters: "we could not
    // load your queue" versus "your queue is empty", which look identical
    // unless the page says which one it is.
    serveSequence(page, [{ status: 500, body: {} }]);
    await page.goto("/");
    await expect(page.getByTestId("runs-error")).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
  });
});

test.describe("queue — the board against hostile data", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("a DUPLICATE run_id renders one card per entry, not a merged one", async ({
    page,
  }) => {
    // Whatever the board does here it must not silently lose an entry. Two
    // entries in, two cards out — the count is the assertion, because a merge
    // would look like a perfectly normal single-run board.
    serveSequence(page, [
      {
        status: 200,
        body: [run("dup", "running", "first copy"), run("dup", "running", "second copy")],
      },
    ]);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(2);
  });

  test("a run with NO task text still renders, identifiably", async ({
    page,
  }) => {
    // Dropping it would remove work from the queue over a cosmetic field.
    serveSequence(page, [
      { status: 200, body: [{ ...run("nt", "running"), task: "" }] },
    ]);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId("run-task")).not.toBeEmpty();
  });

  test("a run with a MISSING status lands in the catch-all, not nowhere", async ({
    page,
  }) => {
    const { status: _drop, ...noStatus } = run("ns", "running", "statusless");
    serveSequence(page, [{ status: 200, body: [noStatus] }]);
    await page.goto("/");
    await expect(page.getByText("statusless")).toBeVisible();
  });

  test("a LONG task title does not break the board layout", async ({ page }) => {
    // Horizontal overflow on the queue is not cosmetic: it pushes columns off
    // screen, and a column you cannot see is work you do not know about.
    serveSequence(page, [
      { status: 200, body: [run("long", "running", "x".repeat(400))] },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("MANY runs all render — nothing is silently capped", async ({ page }) => {
    // A board that quietly shows the first 20 of 60 is a board that hides work
    // while looking complete. The count is the only thing that catches it.
    const many = Array.from({ length: 60 }, (_, i) =>
      run(`m${i}`, i % 2 === 0 ? "running" : "pending", `task ${i}`)
    );
    serveSequence(page, [{ status: 200, body: many }]);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(60);
  });

  test("an empty array is an EMPTY QUEUE, not an error", async ({ page }) => {
    // The control for the first-poll-failure case above: these two must not
    // render the same way.
    serveSequence(page, [{ status: 200, body: [] }]);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    await expect(page.getByTestId("runs-error")).toHaveCount(0);
  });
});

test.describe("kanban — the counts and the controls", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("each column's COUNT equals the cards rendered in it", async ({
    page,
  }) => {
    // The board reports a number per column and also draws cards. Nothing
    // asserted that the two agree, and they are computed from the same array —
    // so a divergence means one of them is lying about work that exists.
    serveSequence(page, [
      {
        status: 200,
        body: [
          run("a", "pending"),
          run("b", "pending"),
          run("c", "running"),
          run("d", "completed"),
        ],
      },
    ]);
    await page.goto("/");
    // Wait for the board to actually hold the four runs before reading any
    // count. Reading immediately measures the first paint, where every column
    // is legitimately 0 — and "0 equals 0 cards" would have passed as agreement.
    await expect(cards(page)).toHaveCount(4);
    for (const [col, expected] of [
      ["backlog", 2],
      ["in-progress", 1],
      ["done", 1],
      ["errored", 0],
    ] as const) {
      const column = page.getByTestId(`board-column-${col}`);
      const count = Number(
        (await page.getByTestId(`board-count-${col}`).innerText()).replace(
          /\D/g,
          ""
        ) || 0
      );
      expect(count, `${col} count`).toBe(expected);
      await expect(
        column.getByTestId("run-list-card"),
        `${col} cards`
      ).toHaveCount(expected);
    }
  });

  test("the REFRESH button fetches immediately, without waiting for the tick", async ({
    page,
  }) => {
    // Polling makes the board eventually correct; the button is what makes it
    // correct NOW. If it is wired to nothing, the board still updates on its
    // own and the control looks like it worked.
    const seq = serveSequence(page, [{ status: 200, body: [] }]);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    const before = seq.calls();
    await page.getByTestId("refresh-runs-button").click();
    await expect.poll(() => seq.calls(), { timeout: 5_000 }).toBeGreaterThan(
      before
    );
  });

  test("a card LINKS to its run with the thread the API reported", async ({
    page,
  }) => {
    // The board's job ends at handing you a correct address for the work.
    serveSequence(page, [{ status: 200, body: [run("r-9", "running")] }]);
    await page.goto("/");
    const href = await page
      .getByTestId("run-detail-link")
      .first()
      .getAttribute("href");
    expect(href).toContain("/runs/r-9");
    expect(href).toContain("th-r-9");
  });

  test("ALL FIVE statuses render at once, each in its own column", async ({
    page,
  }) => {
    // Every other case exercises one or two columns. This is the only one that
    // would notice two statuses routing to the same place.
    serveSequence(page, [
      {
        status: 200,
        body: [
          run("p", "pending", "is pending"),
          run("r", "running", "is running"),
          run("i", "interrupted", "is interrupted"),
          run("c", "completed", "is completed"),
          run("f", "failed", "is failed"),
        ],
      },
    ]);
    await page.goto("/");
    for (const [col, task] of [
      ["backlog", "is pending"],
      ["in-progress", "is running"],
      ["needs-approval", "is interrupted"],
      ["done", "is completed"],
      ["errored", "is failed"],
    ] as const) {
      await expect(
        page.getByTestId(`board-column-${col}`).getByText(task, { exact: true })
      ).toHaveCount(1);
    }
  });

  test("the board SURVIVES a poll that returns malformed JSON", async ({
    page,
  }) => {
    // Not a 500 — a 200 whose body does not parse. It takes the same catch, and
    // a board that threw here would take the whole page down rather than
    // reporting one bad response.
    let n = 0;
    await page.route("**/api/open-swe/runs", (route) => {
      if (route.request().method() !== "GET") return void route.fallback();
      n += 1;
      return n === 1
        ? void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([run("keep", "running", "survives garbage")]),
          })
        : void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{ this is not json",
          });
    });
    await page.goto("/");
    await expect(page.getByText("survives garbage")).toBeVisible();
    await expect(page.getByTestId("runs-error")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("survives garbage")).toBeVisible();
  });

  test("a poll returning a NON-ARRAY body does not crash the board", async ({
    page,
  }) => {
    // EXPECTED TO FAIL — filed as #243, and it is a real defect rather than a
    // flaky case. `useRuns` casts the body to Run[] without checking, so a 200
    // carrying a non-array is stored, iterated during render, and throws
    // `runs is not iterable`. React's error boundary then replaces the whole
    // page — including the runs already on screen.
    //
    // The comparison is what makes it worth an issue rather than a shrug: on a
    // 500 this hook carefully preserves the board and reports the error, and
    // recovers on the next tick. On a malformed 200 it destroys the page and
    // cannot recover, because the boundary has unmounted the thing that polls.
    // The careless path delivers exactly the failure the careful path exists
    // to prevent.
    //
    // Marked test.fail() rather than weakened: the assertion states what the
    // board should do, and rewriting it to match today's behaviour would turn
    // this case into a description of the bug.
    test.fail();
    // The shape that already caused a real failure once: the page expects a
    // bare array, and an object here made it throw and render its error
    // boundary — which looked exactly like an application defect.
    serveSequence(page, [
      { status: 200, body: [run("keep", "running", "still here")] },
      { status: 200, body: { runs: [] } },
    ]);
    await page.goto("/");
    await expect(page.getByText("still here")).toBeVisible();
    await page.waitForTimeout(7_000);
    await expect(page.getByTestId("run-board")).toBeVisible();
  });
});
