import { test, expect } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * #131 — a failed task submission must be VISIBLE.
 *
 * Before this, `handleSubmit`'s catch was `console.error` only. The spinner
 * stopped and the form returned to its idle appearance, so a failure was
 * indistinguishable from a slow success — and from never having pressed the
 * button. The PO hit exactly this: submissions were 429'd by #127 and they
 * only knew because devtools happened to be open.
 *
 * EVERY ASSERTION HERE IS POSITIVE. "No success message" is satisfied by a
 * form that shows an error AND by a form that crashed; only asserting the
 * error's own content distinguishes them. So each case names the class it
 * expects — rate limit, backend unreachable, offline — because 429, 502 and a
 * dead network send the user to three different places.
 *
 * These drive the real page against mocked RESPONSES, not a mocked page: the
 * route interception replaces what the server says, and everything from
 * `fetch` inward is the shipping code path.
 */

const TASK = "investigate the failing build";

async function submit(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("task-input").fill(TASK);
  await page.getByTestId("new-run-button").click();
}

test.describe("#131 — a failed submission is visible, named, and persistent", () => {
  // #124: the queue refuses work it knows cannot run, so a spec that
  // submits must first establish that it CAN. See readiness-mock.ts.
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("429 renders a rate-limit error naming the wait, not a silent no-op", async ({
    page,
  }) => {
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 429,
        headers: { "retry-after": "30" },
        contentType: "application/json",
        body: JSON.stringify({ error: "Rate limit exceeded" }),
      });
    });

    await page.goto("/runs");
    await submit(page);

    const alert = page.getByTestId("submit-error");
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("submit-error-title")).toContainText(/rate limit/i);
    await expect(page.getByTestId("submit-error-hint")).toContainText("30s");
    await expect(page.getByTestId("submit-error-detail")).toContainText(
      "Rate limit exceeded"
    );
    // role=alert so it reaches assistive tech, not only sighted users.
    await expect(alert).toHaveAttribute("role", "alert");
  });

  test("502 names the BACKEND and surfaces the server's own sentence", async ({
    page,
  }) => {
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "LANGGRAPH_PLATFORM_URL is not configured" }),
      });
    });

    await page.goto("/runs");
    await submit(page);

    await expect(page.getByTestId("submit-error-title")).toContainText(
      /backend is unreachable/i
    );
    // The actionable sentence. The old code read the status and threw the body
    // away, which is why "502" was all anyone ever saw.
    await expect(page.getByTestId("submit-error-detail")).toContainText(
      "LANGGRAPH_PLATFORM_URL is not configured"
    );
  });

  test("a dead network says the request never left — not that the server refused", async ({
    page,
  }) => {
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.abort("failed");
    });

    await page.goto("/runs");
    await submit(page);

    await expect(page.getByTestId("submit-error-title")).toContainText(
      /reach the server/i
    );
    await expect(page.getByTestId("submit-error-hint")).toContainText(/never left/i);
  });

  test("the error PERSISTS — it is not a toast that vanishes while you look away", async ({
    page,
  }) => {
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 500, body: "boom" });
    });

    await page.goto("/runs");
    await submit(page);
    await expect(page.getByTestId("submit-error")).toBeVisible();

    // A toast would be gone by now. This is the whole difference between a
    // fix and a mute button with better styling.
    await page.waitForTimeout(6_000);
    await expect(page.getByTestId("submit-error")).toBeVisible();
    await expect(page.getByTestId("submit-error-title")).toContainText("500");
  });

  test("dismiss clears it, and it does not come back on its own", async ({ page }) => {
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 500, body: "boom" });
    });

    await page.goto("/runs");
    await submit(page);
    await expect(page.getByTestId("submit-error")).toBeVisible();

    await page.getByTestId("submit-error-dismiss").click();
    await expect(page.getByTestId("submit-error")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("submit-error")).toHaveCount(0);
  });

  test("retry re-submits and a now-healthy server navigates to the run", async ({
    page,
  }) => {
    let attempt = 0;
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempt += 1;
      if (attempt === 1) {
        return route.fulfill({ status: 503, body: "unavailable" });
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "run-recovered", thread_id: "th-1" }),
      });
    });

    await page.goto("/runs");
    await submit(page);
    await expect(page.getByTestId("submit-error")).toBeVisible();

    await page.getByTestId("submit-error-retry").click();

    // The POSITIVE claim: recovery navigates to the created run. Asserting only
    // "the error disappeared" would also pass if the page had crashed.
    await expect(page).toHaveURL(/\/runs\/run-recovered/, { timeout: 10_000 });
    expect(attempt).toBe(2);
  });

  test("the submission error is a DIFFERENT surface from the run-list error", async ({
    page,
  }) => {
    // Conflating them is what let a failed submission look like a healthy page.
    //
    // The GET is mocked HEALTHY on purpose. Without LANGGRAPH_PLATFORM_URL the
    // real list fetch 502s, so `runs-error` would be present for a reason that
    // has nothing to do with this test — and the assertion would pass or fail
    // on the environment rather than on the claim. Making the premise true is
    // the fix; loosening the assertion would have hidden the distinction the
    // test exists to prove.
    await page.route("**/api/open-swe/runs**", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, body: "boom" });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.goto("/runs");
    // Precondition: with a healthy list fetch there is no list error to confuse
    // with the submission error.
    await expect(page.getByTestId("runs-error")).toHaveCount(0);

    await submit(page);

    await expect(page.getByTestId("submit-error")).toBeVisible();
    await expect(page.getByTestId("runs-error")).toHaveCount(0);
  });
});
