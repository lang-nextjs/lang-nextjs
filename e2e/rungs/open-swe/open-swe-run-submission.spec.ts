import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * DISPATCHING WORK — the success path and the guards around it.
 *
 * `open-swe-submit-failure.spec.ts` covers what happens when submission FAILS,
 * thoroughly: 429, 502, dead network, persistence, dismissal, retry. What it
 * does not cover is the path a person actually takes, and the guards that keep
 * that path from doing the wrong thing twice.
 *
 * THE ONES THAT MATTER MOST ARE THE GUARDS. `if (!text || submitting) return`
 * is two separate protections on one line, and both fail silently when broken:
 * a whitespace-only task dispatches a run with no instruction, and a
 * double-click dispatches the same work twice. Neither shows an error. The
 * second is the expensive one — two agents editing one repository, and the
 * person who caused it saw a single click.
 *
 * The trimming is the same class. The body is built from `task.trim()`, so a
 * task typed with a trailing newline must reach the backend without it —
 * otherwise identical work submitted twice looks like two different tasks, and
 * the queue silently stops deduplicating anything by eye.
 */

const run = (id: string, status: string, task = `task ${id}`) => ({
  run_id: id,
  thread_id: `th-${id}`,
  status,
  task,
  created_at: "2026-01-01T00:00:00Z",
});

interface Capture {
  posts: () => number;
  bodies: () => Array<Record<string, unknown>>;
}

/** Accept submissions, recording every one, and serve a list. */
function acceptSubmissions(
  page: Page,
  opts: { runs?: unknown[]; reply?: Record<string, unknown> } = {}
): Capture {
  const bodies: Array<Record<string, unknown>> = [];
  void page.route("**/api/open-swe/runs", (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(opts.runs ?? []),
      });
    }
    bodies.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
    return void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        opts.reply ?? { run_id: "new-run", thread_id: "new-thread" }
      ),
    });
  });
  return { posts: () => bodies.length, bodies: () => bodies };
}

/** The run page pulls state and a stream; neither is the subject here. */
async function quietRunPage(page: Page): Promise<void> {
  await page.route("**/api/open-swe/runs/*/state**", (route) =>
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "busy", messages: [], files: {}, interrupts: [] }),
    })
  );
  await page.route("**/api/open-swe/runs/*/stream**", () => {
    /* held open — the detail page is not what these cases assert */
  });
}

test.describe("dispatching a run — the path a person takes", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
    await quietRunPage(page);
  });

  test("a submitted task NAVIGATES to its own run", async ({ page }) => {
    const cap = acceptSubmissions(page, {
      reply: { run_id: "r-77", thread_id: "th-77" },
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("fix the flaky test");
    await page.getByTestId("new-run-button").click();
    await expect(page).toHaveURL(/\/runs\/r-77/);
    expect(cap.posts()).toBe(1);
  });

  test("the URL carries the THREAD id the server assigned", async ({ page }) => {
    // Without it the detail page can only say "no thread". The failure lands one
    // route after its cause, which is what makes it worth pinning at the source.
    acceptSubmissions(page, {
      reply: { run_id: "r-77", thread_id: "th-assigned" },
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect(page).toHaveURL(/threadId=th-assigned/);
  });

  test("a reply with NO thread id still navigates, without a bogus param", async ({
    page,
  }) => {
    // `threadParam` is conditional. Appending `?threadId=undefined` would send
    // the detail page looking for a thread literally named "undefined".
    acceptSubmissions(page, { reply: { run_id: "r-78" } });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect(page).toHaveURL(/\/runs\/r-78/);
    expect(page.url()).not.toContain("undefined");
  });

  test("the POST carries the TASK TEXT, not an empty body", async ({ page }) => {
    const cap = acceptSubmissions(page);
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("rename the widget");
    await page.getByTestId("new-run-button").click();
    await expect.poll(() => cap.posts()).toBe(1);
    expect(cap.bodies()[0].task).toBe("rename the widget");
  });

  test("the task is TRIMMED before it is sent", async ({ page }) => {
    // Identical work submitted twice must look identical in the queue. Leading
    // and trailing whitespace is invisible on screen and decisive to a string
    // comparison, so it is exactly the difference nobody can see.
    const cap = acceptSubmissions(page);
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("   padded task   ");
    await page.getByTestId("new-run-button").click();
    await expect.poll(() => cap.posts()).toBe(1);
    expect(cap.bodies()[0].task).toBe("padded task");
  });

  test("submitting sends JSON, with the content type that says so", async ({
    page,
  }) => {
    let contentType = "";
    await page.route("**/api/open-swe/runs", (route) => {
      const req = route.request();
      if (req.method() !== "POST") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      contentType = req.headers()["content-type"] ?? "";
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "r-1" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect.poll(() => contentType).toContain("application/json");
  });
});

test.describe("dispatching a run — the guards", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
    await quietRunPage(page);
  });

  test("A WHITESPACE-ONLY TASK DISPATCHES NOTHING", async ({ page }) => {
    // `!text` after trimming. A run with no instruction is worse than no run:
    // it occupies the queue, consumes a worker, and produces nothing anybody
    // asked for — and the person who typed a space sees a run appear.
    const cap = acceptSubmissions(page);
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("     ");
    // TWO GUARDS, ASSERTED SEPARATELY. The button is disabled, which is the one
    // a person sees — and a plain .click() would simply hang on it, which is
    // why the first version of this case timed out rather than passing.
    // Forcing the click past the disabled state exercises the SECOND guard,
    // `if (!text || submitting) return`, which is the one that still has to
    // hold when the button is reached by keyboard, by a stale render, or by a
    // future refactor that forgets the disabled attribute.
    await expect(page.getByTestId("new-run-button")).toBeDisabled();
    await page.getByTestId("new-run-button").click({ force: true });
    await page.waitForTimeout(600);
    expect(cap.posts()).toBe(0);
    await expect(page).not.toHaveURL(/\/runs\//);
  });

  test("an EMPTY task dispatches nothing either", async ({ page }) => {
    const cap = acceptSubmissions(page);
    await page.goto("/runs");
    await expect(page.getByTestId("new-run-button")).toBeDisabled();
    await page.getByTestId("new-run-button").click({ force: true });
    await page.waitForTimeout(600);
    expect(cap.posts()).toBe(0);
  });

  test("DOUBLE-CLICKING DISPATCHES ONE RUN, NOT TWO", async ({ page }) => {
    // The `submitting` half of the guard, and the expensive one to lose: two
    // agents editing one repository, from a person who clicked once as far as
    // they are concerned. Nothing on screen reports the duplicate.
    let posts = 0;
    await page.route("**/api/open-swe/runs", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      posts += 1;
      // Hold the response so the second click lands while the first is in
      // flight — the only window in which the guard is doing anything.
      await new Promise((r) => setTimeout(r, 900));
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "r-1", thread_id: "t-1" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("do the thing once");
    const button = page.getByTestId("new-run-button");
    await button.click();
    await button.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1600);
    expect(posts).toBe(1);
  });

  test("a previous failure is CLEARED when a retry is submitted", async ({
    page,
  }) => {
    // "Retrying is the acknowledgement", per the handler's own comment. A stale
    // error banner over a submission that is currently in flight reports on the
    // wrong attempt.
    let attempt = 0;
    await page.route("**/api/open-swe/runs", (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      attempt += 1;
      if (attempt === 1) {
        return void route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "backend down" }),
        });
      }
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "r-ok", thread_id: "t-ok" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect(page.getByTestId("submit-error")).toBeVisible();
    await page.getByTestId("new-run-button").click();
    await expect(page).toHaveURL(/\/runs\/r-ok/);
  });
});

test.describe("dispatching a run — the board around it", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
    await quietRunPage(page);
  });

  test("the board is still readable WHILE a submission is in flight", async ({
    page,
  }) => {
    // Submitting must not blank the queue you already have. A person dispatching
    // their fourth run should still see the other three.
    await page.route("**/api/open-swe/runs", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([run("existing", "running", "already queued")]),
        });
      }
      await new Promise((r) => setTimeout(r, 1200));
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "r-1" }),
      });
    });
    await page.goto("/runs");
    await expect(page.getByText("already queued")).toBeVisible();
    await page.getByTestId("task-input").fill("a second task");
    await page.getByTestId("new-run-button").click();
    await expect(page.getByText("already queued")).toBeVisible();
  });

  test("a SUBMIT failure and a LIST failure are different surfaces", async ({
    page,
  }) => {
    // Both are "something went wrong with runs", and collapsing them tells a
    // person their queue is broken when only their submission was refused.
    await page.route("**/api/open-swe/runs", (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([run("ok", "running", "healthy list")]),
        });
      }
      return void route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "backend down" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect(page.getByTestId("submit-error")).toBeVisible();
    await expect(page.getByTestId("runs-error")).toHaveCount(0);
    await expect(page.getByText("healthy list")).toBeVisible();
  });

  test("the composer is USABLE again after a failed submission", async ({
    page,
  }) => {
    // `setSubmitting(false)` in the finally block. Leaving it true strands the
    // person on a dead form with no way back except a reload.
    await page.route("**/api/open-swe/runs", (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      }
      return void route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "backend down" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("a task");
    await page.getByTestId("new-run-button").click();
    await expect(page.getByTestId("submit-error")).toBeVisible();
    await expect(page.getByTestId("new-run-button")).toBeEnabled();
    await expect(page.getByTestId("task-input")).toBeEditable();
  });

  test("a run dispatched from the board APPEARS on it when it comes back", async ({
    page,
  }) => {
    // The round trip. Navigation carries you to the run; the queue you came
    // from has to know about it too, or the board and the work disagree.
    let posted = false;
    await page.route("**/api/open-swe/runs", (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            posted ? [run("fresh", "pending", "dispatched task")] : []
          ),
        });
      }
      posted = true;
      return void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "fresh", thread_id: "th-fresh" }),
      });
    });
    await page.goto("/runs");
    await page.getByTestId("task-input").fill("dispatched task");
    await page.getByTestId("new-run-button").click();
    await expect(page).toHaveURL(/\/runs\/fresh/);
    await page.goto("/runs");
    await expect(
      page.getByTestId("board-column-backlog").getByText("dispatched task")
    ).toBeVisible();
  });
});
