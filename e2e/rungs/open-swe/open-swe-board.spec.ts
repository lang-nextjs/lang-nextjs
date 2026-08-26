import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * The KANBAN BOARD's structural properties — the ones lib/run-board.ts exists
 * for, and which nothing asserted end to end.
 *
 * The module's own header states the risk it was written to remove:
 *
 *   "A board that renders four columns and quietly omits a fifth status shows
 *    you a queue with work missing from it, which is worse than showing no
 *    board."
 *
 * The existing dashboard spec covers "a run lands in the right column" and "an
 * unrecognised status lands in `other`". What it does NOT cover is the property
 * that makes those two safe: CONSERVATION — every run appears exactly once
 * across the whole board. A grouping bug that dropped a run, or rendered it
 * twice, satisfies both existing cases.
 */

const ALWAYS_ON = [
  "backlog",
  "in-progress",
  "needs-approval",
  "done",
  "errored",
] as const;

const COLUMNS = [
  "backlog",
  "in-progress",
  "needs-approval",
  "done",
  "errored",
  "other",
] as const;

function run(id: string, status: string, task = `task ${id}`) {
  return { run_id: id, thread_id: `th-${id}`, status, task, created_at: "2026-01-01T00:00:00Z" };
}

async function mockRuns(page: Page, runs: unknown[]) {
  await page.route("**/api/open-swe/runs", (route) => {
    if (route.request().method() !== "GET") return void route.fallback();
    return void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runs),
    });
  });
}

/**
 * Sum of the per-column counts the board renders.
 *
 * `locator.count()` does NOT wait. The first version of this helper skipped any
 * column whose count was 0 — which reads as "that column is absent" but is also
 * what an un-rendered column looks like. On CI it summed three of six columns
 * and reported a conservation violation that did not exist.
 *
 * The five always-on columns are now REQUIRED: if one is missing this throws
 * rather than quietly contributing nothing. Only `other` may legitimately be
 * absent, because it is `hideWhenEmpty`.
 */
async function renderedTotal(page: Page): Promise<number> {
  let total = 0;
  for (const c of ALWAYS_ON) {
    const el = page.getByTestId(`board-count-${c}`);
    await expect(el).toBeAttached(); // waits, and fails loudly if truly absent
    total += Number((await el.innerText()).replace(/\D/g, "") || 0);
  }
  const other = page.getByTestId("board-count-other");
  if ((await other.count()) > 0) {
    total += Number((await other.innerText()).replace(/\D/g, "") || 0);
  }
  return total;
}

test.describe("open-swe board — structural properties of the queue", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("CONSERVATION: every run appears exactly once across all columns", async ({
    page,
  }) => {
    // THE PROPERTY THE MODULE EXISTS FOR. A run that is dropped and a run that
    // is double-counted both leave the individual column assertions passing —
    // this is the only case that sees either.
    const runs = [
      run("a", "pending"),
      run("b", "running"),
      run("c", "completed"),
      run("d", "failed"),
      run("e", "interrupted"),
      run("f", "something-nobody-declared"),
    ];
    await mockRuns(page, runs);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();

    await expect.poll(() => renderedTotal(page)).toBe(runs.length);

    // And each task string is rendered once — a count can be right while the
    // same run is shown twice and another is missing.
    for (const r of runs) {
      await expect(page.getByText(r.task, { exact: true })).toHaveCount(1);
    }
  });

  test("the five ALWAYS-ON columns render on an EMPTY queue; `other` does not", async ({
    page,
  }) => {
    // `other` alone is hideWhenEmpty: true — a catch-all with nothing in it is
    // noise, and the module says so. The other five stay visible when empty
    // BECAUSE an empty column is a true statement: `needs-approval` maps to
    // `interrupted`, which the list endpoint does not currently report, and
    // dropping the column would silently reroute those runs into "in progress"
    // the day it does.
    await mockRuns(page, []);
    await page.goto("/");
    for (const c of ALWAYS_ON) {
      await expect(page.getByTestId(`board-column-${c}`)).toBeVisible();
    }
    await expect(page.getByTestId("board-column-other")).toHaveCount(0);
  });

  test("`other` APPEARS as soon as a run lands in it", async ({ page }) => {
    // The other half of hideWhenEmpty. Hidden-when-empty is only safe if it
    // becomes visible when non-empty; a column that is always hidden would
    // satisfy the case above and lose every unrecognised run silently.
    await mockRuns(page, [run("x", "a-status-nobody-declared", "orphan task")]);
    await page.goto("/");
    // ATTACHED, not visible. The board scrolls horizontally and `other` sits
    // last, so a viewport assertion would be testing the scroll position rather
    // than the grouping. The property is that the run is NOT DROPPED — it must
    // be in the column, reachable by scrolling. Asserting visibility here would
    // fail on a narrow viewport for a board that is behaving correctly.
    await expect(page.getByTestId("board-column-other")).toBeAttached();
    await expect(
      page.getByTestId("board-column-other").getByText("orphan task")
    ).toBeAttached();
  });

  test("column ORDER follows the flow of work, left to right", async ({ page }) => {
    // Order is the board's reading direction. A reordering is invisible to every
    // per-column assertion, and `other` sits last by construction.
    await mockRuns(page, [run("x", "unknown-status")]);
    await page.goto("/");
    // Same non-waiting read as the deps panel. This one happens to fail loudly
    // when it races (an empty list is not equal to the expected six), but
    // "fails in the safe direction" is not the same as "does not race".
    const columns = page.locator('[data-testid^="board-column-"]');
    await expect(columns).toHaveCount(ALWAYS_ON.length + 1);
    const ids = await columns.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid")!.replace("board-column-", ""))
    );
    expect(ids).toEqual([...ALWAYS_ON, "other"]);
  });

  test("an EMPTY queue still renders the board, not a blank page", async ({
    page,
  }) => {
    await mockRuns(page, []);
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    expect(await renderedTotal(page)).toBe(0);
  });

  test("a run MOVES columns when its status changes on refresh", async ({
    page,
  }) => {
    // Grouping is recomputed per render. A memo keyed on the wrong thing would
    // pin a run to its first column forever — and every static-fixture test
    // would still pass, because they never change a status.
    let phase = 0;
    await page.route("**/api/open-swe/runs", (route) => {
      if (route.request().method() !== "GET") return void route.fallback();
      const status = phase++ === 0 ? "running" : "completed";
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([run("m", status, "movable task")]),
      });
    });
    await page.goto("/");
    await expect(
      page.getByTestId("board-column-in-progress").getByText("movable task")
    ).toBeVisible();

    await page.getByTestId("refresh-runs-button").click();
    await expect(
      page.getByTestId("board-column-done").getByText("movable task")
    ).toBeVisible();
    await expect(
      page.getByTestId("board-column-in-progress").getByText("movable task")
    ).toHaveCount(0);
  });

  test("a failing list endpoint shows an error INSTEAD of an empty board", async ({
    page,
  }) => {
    // An empty board and a board that could not load look identical unless one
    // of them says so. "No runs" is a claim about the queue; "could not load"
    // is a claim about the request, and they call for different actions.
    await page.route("**/api/open-swe/runs", (route) =>
      route.request().method() === "GET"
        ? void route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        : void route.fallback()
    );
    await page.goto("/");
    await expect(page.getByTestId("runs-error")).toBeVisible();
  });

  test("refresh REFETCHES rather than re-rendering the same data", async ({
    page,
  }) => {
    let calls = 0;
    await page.route("**/api/open-swe/runs", (route) => {
      if (route.request().method() !== "GET") return void route.fallback();
      calls++;
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([run("r", "running")]),
      });
    });
    await page.goto("/");
    await expect(page.getByTestId("run-board")).toBeVisible();
    const before = calls;
    await page.getByTestId("refresh-runs-button").click();
    await expect.poll(() => calls).toBeGreaterThan(before);
  });

  /**
   * ORDER WITHIN A COLUMN. `byNewest` is the only part of run-board.ts with a
   * documented tie-break and a documented failure mode, and neither was
   * reachable from a test. A column that renders its runs in arrival order
   * looks correct on every fixture where arrival order happens to be newest
   * first — which is most of them.
   */
  test("runs inside a column are NEWEST FIRST, not arrival order", async ({
    page,
  }) => {
    // Deliberately supplied oldest-first, so arrival order is the WRONG answer
    // and a board that ignores the sort fails rather than coincidentally passes.
    await mockRuns(page, [
      { run_id: "o", thread_id: "th-o", status: "pending", task: "oldest", created_at: "2026-01-01T00:00:00Z" },
      { run_id: "m", thread_id: "th-m", status: "pending", task: "middle", created_at: "2026-02-01T00:00:00Z" },
      { run_id: "n", thread_id: "th-n", status: "pending", task: "newest", created_at: "2026-03-01T00:00:00Z" },
    ]);
    await page.goto("/");
    const tasks = page
      .getByTestId("board-column-backlog")
      .getByTestId("run-task");
    await expect(tasks).toHaveCount(3);
    expect(await tasks.allInnerTexts()).toEqual(["newest", "middle", "oldest"]);
  });

  /**
   * THE COMMENT SAYS "SINK, NEVER VANISH" — so a test has to distinguish the
   * two. A sort comparator that returns NaN for an unparseable date leaves the
   * order unspecified rather than throwing, and the run is still present; a
   * pre-filter that drops bad timestamps also produces a clean-looking board.
   * Only asserting BOTH placement and presence tells those apart.
   */
  test("a run with an UNPARSEABLE created_at sinks to the bottom and is STILL THERE", async ({
    page,
  }) => {
    await mockRuns(page, [
      { run_id: "bad", thread_id: "th-bad", status: "pending", task: "undated work", created_at: "not-a-date" },
      { run_id: "a", thread_id: "th-a", status: "pending", task: "older", created_at: "2026-01-01T00:00:00Z" },
      { run_id: "b", thread_id: "th-b", status: "pending", task: "newer", created_at: "2026-02-01T00:00:00Z" },
    ]);
    await page.goto("/");
    const tasks = page
      .getByTestId("board-column-backlog")
      .getByTestId("run-task");
    await expect(tasks).toHaveCount(3); // present — this is the half that matters
    expect(await tasks.allInnerTexts()).toEqual(["newer", "older", "undated work"]);
    // and nothing leaked into the catch-all on the way
    expect(await renderedTotal(page)).toBe(3);
  });

  /**
   * `interrupted` IS THE WHOLE REASON THE COLUMN SET IS NOT DERIVED FROM THE
   * LIST ENDPOINT. run-board.ts spells this out: the endpoint types out four
   * statuses, the thread state types five, and the fifth is the one a human is
   * meant to act on. The column is declared ahead of the endpoint reporting it.
   *
   * The `other` count is the discriminator. Routing `interrupted` to the
   * catch-all ALSO renders it — visibly, in a column, with the right task text.
   * Only "needs-approval has it AND other has none" separates the design from
   * the accident.
   */
  test("an `interrupted` run lands in NEEDS APPROVAL, not the catch-all", async ({
    page,
  }) => {
    await mockRuns(page, [run("i1", "interrupted", "waiting on a human")]);
    await page.goto("/");
    await expect(
      page.getByTestId("board-column-needs-approval").getByTestId("run-task"),
    ).toHaveText(["waiting on a human"]);
    // `other` hides when empty — so if the run were miscategorised the column
    // would APPEAR. Its absence is the assertion.
    await expect(page.getByTestId("board-column-other")).toHaveCount(0);
  });

  /**
   * QUEUE -> RUN. The board is a navigation surface, and the link carries the
   * THREAD id as well as the run id — the detail page needs it to stream, and
   * a card that links to `/runs/<id>` alone reaches a page that can only say
   * "no thread". That failure surfaces one route later than its cause, which
   * is what makes it worth pinning here.
   */
  test("a card LINKS to its own run and carries the thread id", async ({
    page,
  }) => {
    await mockRuns(page, [run("r-42", "running", "the linked task")]);
    await page.goto("/");
    const card = page.getByTestId("run-detail-link").first();
    const href = await card.getAttribute("href");
    expect(href).toContain("/runs/r-42");
    expect(href).toContain("th-r-42"); // the thread, not just the run
    await card.click();
    await expect(page).toHaveURL(/\/runs\/r-42/);
  });
});
