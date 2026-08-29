import { test, expect } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * #127 — the user's actual journey: open the dashboard, leave it open, submit a
 * task. Before the fix that returned `Create run failed: 429`.
 *
 * WHY NOTHING CAUGHT THIS. `rate-limit.test.ts` and `middleware.test.ts` are
 * neither absent nor weak — the limits are tested and the "unknown" fallback is
 * tested. But every one of those tests drives ONE call class, and the defect
 * exists only BETWEEN two of them: the bucket was keyed on IP alone, so the
 * dashboard's 5s poll (useRuns.ts:19 — GET /api/open-swe/runs under STANDARD,
 * 60/60s) wrote into the same timestamp array that POST reads under STRICT
 * (10/60s). Twelve polls per window against a budget of ten, and every
 * submission 429'd from ~50s after page load — permanently, because the poll
 * kept refilling the window.
 *
 * No e2e caught it either, because catching it needs a sequence no spec walked:
 * open the dashboard, let the poll cross the window, THEN submit.
 *
 * TWO DEVIATIONS FROM THE LITERAL JOURNEY, both deliberate:
 *
 * 1. Each test sends a unique `x-forwarded-for`. extractIp prefers it over the
 *    "unknown" fallback, so each test owns its bucket. The dev server's limiter
 *    is a process-global singleton (rate-limit.ts getLimiter), so without this
 *    these tests would both pollute and be polluted by every other spec hitting
 *    :3001. The shared-"unknown" case is covered at unit level instead.
 * 2. The window is crossed by issuing the poll's GETs directly rather than
 *    waiting 60s of wall clock. Same requests, same middleware, same buckets —
 *    just not in real time. A literal 60s version belongs in a nightly tier,
 *    not on every PR.
 *
 * The assertion is `not 429`, not `2xx`: without LANGGRAPH_PLATFORM_URL the
 * route legitimately answers 502. The middleware is what is under test, and a
 * 502 means the request reached the handler — which is the whole point.
 */

/** A 5s poll issues 12 GETs per 60s window; STRICT allows 10. */
const POLLS_PER_WINDOW = 12;

function identity(tag: string): Record<string, string> {
  // Unique per test run so a re-run never inherits a drained bucket.
  return { "x-forwarded-for": `127.0.0.${Math.floor(Math.random() * 200) + 10}-${tag}` };
}

test.describe("#127 — dashboard polling must not consume the task-submission budget", () => {
  // #124: the queue refuses work it knows cannot run, so a spec that
  // submits must first establish that it CAN. See readiness-mock.ts.
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("API: a full window of GET polls leaves POST /runs still submittable", async ({
    request,
  }) => {
    const headers = identity("api");

    for (let i = 0; i < POLLS_PER_WINDOW; i++) {
      const poll = await request.get("/api/open-swe/runs", { headers });
      expect(
        poll.status(),
        `poll #${i + 1} was itself rate-limited — STANDARD should allow 60/min`
      ).not.toBe(429);
    }

    // The user's first write of the session. It must reach the handler.
    const submit = await request.post("/api/open-swe/runs", {
      headers: { ...headers, "Content-Type": "application/json" },
      data: { task: "e2e: submit after a full window of polling" },
    });

    expect(
      submit.status(),
      "POST was rate-limited by traffic that belongs to a different limit class"
    ).not.toBe(429);
  });

  test("UI: submitting from a dashboard that has been polling does not surface a 429", async ({
    page,
    request,
  }) => {
    const headers = identity("ui");
    // The whole browser context adopts this identity, so the page's OWN poll
    // shares the bucket with the submission — which is the real coupling.
    await page.setExtraHTTPHeaders(headers);

    await page.goto("/runs");
    await expect(page.getByTestId("task-input")).toBeVisible();

    // Cross the window without waiting for it: same endpoint, same identity,
    // same middleware as the poll the page is already running.
    for (let i = 0; i < POLLS_PER_WINDOW; i++) {
      await request.get("/api/open-swe/runs", { headers });
    }

    // Wait for the POST itself. The first draft asserted on the `runs-error`
    // element and on a response-listener array, and BOTH were unsound:
    //
    //   - `runs-error` (page.tsx:128) is fed by useRuns' list fetch, NOT by
    //     submission. handleSubmit's catch (page.tsx:31-33) only console.errors,
    //     so a failed submit renders NOTHING. `not.toContainText` against an
    //     element that never exists passes vacuously.
    //   - reading a listener array right after click() raced the request.
    //
    // Verified: that draft PASSED against the pre-fix code, i.e. it would not
    // have caught the defect it exists for. This form fails against pre-fix
    // code, which is the only property that makes it a regression test.
    const postResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/api/open-swe/runs") &&
        r.request().method() === "POST",
      { timeout: 15_000 }
    );

    await page.getByTestId("task-input").fill("e2e: task after sustained polling");
    await page.getByTestId("new-run-button").click();

    const post = await postResponse;
    expect(
      post.status(),
      "the dashboard's own polling consumed the budget its submit needs"
    ).not.toBe(429);
  });
});
