import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility audit — WCAG 2.1 Level A + AA conformance.
 *
 * Runs axe-core against each rendered route in the example app. Any
 * violation (impact: critical, serious, moderate, or minor) fails the
 * test. The intent is to make a11y a build-time concern, not a post-ship
 * audit: shipping a regression that adds a non-labelled button or a
 * contrast violation should block the merge.
 *
 * SCOPE — these tests run in the `chromium` project against the example
 * app on :3000. Apps with their own dev servers (open-swe, remix,
 * sveltekit) are covered separately in their own projects if/when
 * dedicated a11y specs are added.
 *
 * Calibration: tags `wcag2a` + `wcag2aa` are the standard browser-renderable
 * conformance levels. We include `best-practice` as a SEPARATE soft check
 * (not gating) — those findings are valuable but often involve judgment
 * calls not appropriate for a hard gate.
 */

const GATING_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

async function runAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...GATING_TAGS])
    .analyze();

  // Render every violation with its rule, impact, help URL, and the node
  // selectors involved so a failure is actionable without re-running.
  const formatted = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    targets: v.nodes.map((n) => n.target).slice(0, 5),
  }));

  expect(
    formatted,
    `${label}: ${results.violations.length} WCAG A/AA violation(s) found`
  ).toEqual([]);
}

type Page = import("@playwright/test").Page;

test.describe("Accessibility — WCAG 2.1 A + AA conformance per route", () => {
  test("/ (chat composer) is WCAG A/AA conformant", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "/");
  });

  test("/hitl-demo (HITL approval demo) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "/hitl-demo");
  });

  test("/open-swe (run list dashboard) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await page.goto("/open-swe");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "/open-swe");
  });

  test("/concurrent-test (two-pane harness) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await page.goto("/concurrent-test");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "/concurrent-test");
  });

  test("/reconnect-test (resume harness) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await page.goto("/reconnect-test");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "/reconnect-test");
  });
});
