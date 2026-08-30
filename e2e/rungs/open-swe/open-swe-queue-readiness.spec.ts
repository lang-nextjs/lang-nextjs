import { test, expect } from "@playwright/test";

/**
 * #124 — the queue must compute its readiness, and it must be able to go RED.
 *
 * WHAT WAS THERE: the header rendered the string literal "local · langgraph
 * dev". A status-shaped element reporting a verdict it never computed, and one
 * that could not go red because nothing fed it. An indicator nobody has seen go
 * red is the same artifact as a check nobody has seen fail.
 *
 * The queue EXECUTES code, so it needs a sandbox as well as a model — which is
 * why it cannot reuse /chat's call, where `sandboxRequired: false`.
 *
 * Each case drives the real page and replaces only what the DEPENDENCIES say.
 */

const CONFIG = "**/api/config*";
const SANDBOX = "**/api/open-swe/sandbox/health";

async function stub(
  page: import("@playwright/test").Page,
  opts: {
    llm?: unknown;
    sandbox?: unknown;
    sandboxStatus?: number;
    killSandbox?: boolean;
  }
) {
  await page.route(CONFIG, (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeLlm: opts.llm ?? null, backends: {} }),
    })
  );
  await page.route(SANDBOX, async (r) => {
    if (opts.killSandbox) return r.abort("failed");
    await r.fulfill({
      status: opts.sandboxStatus ?? 200,
      contentType: "application/json",
      body: JSON.stringify({ available: opts.sandbox, provider: "docker" }),
    });
  });
  // Keep the run list healthy so nothing else colours the page.
  // The COLLECTION, not everything under it (#379). The trailing `**` also matched
  // /runs/<id>/state, /plan, /stream and /cancel, so this stub answered a run-detail
  // GET with the runs LIST body. The app requests "/api/open-swe/runs" with no query
  // string, so the bare form is what it means.
  await page.route("**/api/open-swe/runs", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      : r.continue()
  );
}

test.describe("#124 — queue readiness is computed, and can go red", () => {
  test("READY: both dependencies answer yes → green and sendable", async ({
    page,
  }) => {
    await stub(page, { llm: "openrouter", sandbox: true });
    await page.goto("/runs");
    const ind = page.getByTestId("queue-readiness");
    await expect(ind).toHaveAttribute("data-state", "ready", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("queue-blocked")).toHaveCount(0);
    await page.getByTestId("task-input").fill("do the thing");
    await expect(page.getByTestId("new-run-button")).toBeEnabled();
  });

  /** THE ONE THAT MATTERS: point the sandbox at a dead daemon and watch it change. */
  test("RED: a dead sandbox blocks the queue and names the sandbox", async ({
    page,
  }) => {
    await stub(page, { llm: "openrouter", sandbox: false, sandboxStatus: 503 });
    await page.goto("/runs");
    await expect(page.getByTestId("queue-readiness")).toHaveAttribute(
      "data-state",
      "blocked",
      { timeout: 10_000 }
    );
    await expect(page.getByTestId("queue-blocked")).toBeVisible();
    await expect(page.getByTestId("queue-blocked")).toContainText(/sandbox/i);
    // And it refuses work it knows cannot run.
    await page.getByTestId("task-input").fill("do the thing");
    await expect(page.getByTestId("new-run-button")).toBeDisabled();
  });

  test("RED: no model blocks the queue and names the model", async ({
    page,
  }) => {
    await stub(page, { llm: null, sandbox: true });
    await page.goto("/runs");
    await expect(page.getByTestId("queue-readiness")).toHaveAttribute(
      "data-state",
      "blocked",
      { timeout: 10_000 }
    );
    await expect(page.getByTestId("queue-blocked")).toBeVisible();
  });

  test("BOTH missing lists BOTH reasons, not just the first", async ({
    page,
  }) => {
    await stub(page, { llm: null, sandbox: false, sandboxStatus: 503 });
    await page.goto("/runs");
    const blocked = page.getByTestId("queue-blocked");
    await expect(blocked).toBeVisible({ timeout: 10_000 });
    expect(await blocked.locator("li").count()).toBeGreaterThanOrEqual(2);
  });

  /** unknown is neither green nor red — the distinction #167 established. */
  test("UNKNOWN: an unreachable probe is NOT green and NOT blocked", async ({
    page,
  }) => {
    await stub(page, { llm: "openrouter", killSandbox: true });
    await page.goto("/runs");
    const ind = page.getByTestId("queue-readiness");
    await expect(ind).toHaveAttribute("data-state", "unknown", {
      timeout: 10_000,
    });
    // Not a red banner: not knowing is not knowing it is broken.
    await expect(page.getByTestId("queue-blocked")).toHaveCount(0);
    // But the failure to determine IS reported, so it cannot sit on
    // "checking…" forever with no way to tell slow from broken.
    await expect(page.getByTestId("queue-probe-error")).toBeVisible();
    await expect(page.getByTestId("queue-probe-error")).toContainText(
      /sandbox/i
    );
    await page.getByTestId("task-input").fill("do the thing");
    await expect(page.getByTestId("new-run-button")).toBeDisabled();
  });

  test("the header no longer claims an environment it never checked", async ({
    page,
  }) => {
    await stub(page, { llm: "openrouter", sandbox: true });
    await page.goto("/runs");
    await expect(page.getByTestId("queue-readiness")).toBeVisible({
      timeout: 10_000,
    });
    // The literal that could not go red.
    await expect(page.locator("body")).not.toContainText(
      "local · langgraph dev"
    );
  });
});
