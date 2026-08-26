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

/** Sum of the per-column counts the board renders. */
async function renderedTotal(page: Page): Promise<number> {
  let total = 0;
  for (const c of COLUMNS) {
    const el = page.getByTestId(`board-count-${c}`);
    if ((await el.count()) === 0) continue;
    total += Number((await el.innerText()).replace(/\D/g, "") || 0);
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

    expect(await renderedTotal(page)).toBe(runs.length);

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
    const ids = await page
      .locator('[data-testid^="board-column-"]')
      .evaluateAll((els) =>
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
});
