import { test, expect } from "@playwright/test";

/**
 * #126 — every dependency row is a live observation, or says it is not.
 *
 * WHAT WAS THERE: `cfg?.activeLlm ? "configured" : "runs will fail"` — a
 * two-state CONFIG read rendered as health. A proxy verdict is worse than no
 * verdict in one specific way: it moves and looks responsive, so it earns
 * trust a static string never would.
 *
 * Each state below is driven and asserted, including CONFIGURED-BUT-NOT-
 * RESPONDING — the state a boolean hides and the one operators actually hit.
 */

const DEPS = "**/api/open-swe/dependencies**";

async function stub(
  page: import("@playwright/test").Page,
  deps: unknown[],
  at?: string
) {
  await page.route(DEPS, (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        probedAt: at ?? new Date().toISOString(),
        dependencies: deps,
      }),
    })
  );
}

test.describe("#126 — dependency panel reports observation, not configuration", () => {
  test("RESPONDING renders green with latency", async ({ page }) => {
    await stub(page, [
      {
        id: "sandbox",
        label: "Sandbox",
        state: "responding",
        latencyMs: 12,
        detail: "provider: docker",
      },
    ]);
    await page.goto("/settings");
    const row = page.getByTestId("dep-sandbox");
    await expect(row).toHaveAttribute("data-tone", "success", {
      timeout: 10_000,
    });
    await expect(row).toContainText("responding");
    await expect(row).toContainText("12ms");
  });

  /** THE STATE A BOOLEAN HIDES. */
  test("CONFIGURED-BUT-NOT-RESPONDING is red and says so", async ({ page }) => {
    await stub(page, [
      {
        id: "agent-backend",
        label: "Agent backend",
        state: "unreachable",
        detail: "http://localhost:8100 — no answer within 3000ms",
      },
    ]);
    await page.goto("/settings");
    const row = page.getByTestId("dep-agent-backend");
    await expect(row).toHaveAttribute("data-tone", "destructive", {
      timeout: 10_000,
    });
    await expect(row).toContainText("not responding");
    await expect(row).toContainText("no answer within 3000ms");
  });

  /** The degraded case the panel could not previously express at all. */
  test("UNVERIFIED is NOT green, and says why it cannot be verified", async ({
    page,
  }) => {
    await stub(page, [
      {
        id: "inference",
        label: "Inference",
        state: "unverified",
        detail: "openrouter key present",
        unverifiableBecause:
          "verifying the model answers costs one inference call, so it is not done on page load",
      },
    ]);
    await page.goto("/settings");
    const row = page.getByTestId("dep-inference");
    await expect(row).toHaveAttribute("data-state", "unverified", {
      timeout: 10_000,
    });
    // The whole issue: configuration must not render as observation.
    await expect(row).not.toHaveAttribute("data-tone", "success");
    await expect(row).toContainText("configured, not verified");
    await expect(page.getByTestId("dep-inference-why")).toContainText(
      /costs one inference call/i
    );
  });

  test("NOT-CONFIGURED is actionable and not red", async ({ page }) => {
    await stub(page, [
      {
        id: "agent-backend",
        label: "Agent backend",
        state: "not-configured",
        detail: "LANGGRAPH_PLATFORM_URL is not set",
      },
    ]);
    await page.goto("/settings");
    const row = page.getByTestId("dep-agent-backend");
    await expect(row).toContainText("not configured", { timeout: 10_000 });
    await expect(row).toContainText("LANGGRAPH_PLATFORM_URL");
    await expect(row).not.toHaveAttribute("data-tone", "destructive");
  });

  test("NOT-WIRED is never red — a capability that does not exist is not a failure", async ({
    page,
  }) => {
    await stub(page, [
      { id: "langfuse", label: "Langfuse", state: "not-wired" },
    ]);
    await page.goto("/settings");
    const row = page.getByTestId("dep-langfuse");
    await expect(row).toContainText("not wired in this build", {
      timeout: 10_000,
    });
    await expect(row).not.toHaveAttribute("data-tone", "destructive");
  });

  test("AGE is reported — a green from 40 minutes ago is a different claim", async ({
    page,
  }) => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    await stub(
      page,
      [{ id: "sandbox", label: "Sandbox", state: "responding" }],
      old
    );
    await page.goto("/settings");
    await expect(page.getByTestId("deps-age")).toContainText("40m ago", {
      timeout: 10_000,
    });
  });

  test("the old two-state config verdict is gone from the panel", async ({
    page,
  }) => {
    await stub(page, [
      { id: "inference", label: "Inference", state: "unverified" },
    ]);
    await page.goto("/settings");
    await expect(page.getByTestId("deps-list")).toBeVisible({
      timeout: 10_000,
    });
    // The literal the panel used to render from a config read.
    await expect(page.getByTestId("deps-list")).not.toContainText(
      "runs will fail"
    );
  });
});
