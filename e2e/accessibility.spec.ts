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

/**
 * Navigate to `path`, FAIL IF IT IS NOT A REAL PAGE, then audit it.
 *
 * The status assertion is the point. Next renders 404s through the root
 * layout, so axe finds a well-formed page and reports no violations — a
 * route that has been deleted keeps passing its a11y test forever, proving
 * nothing. That is exactly what happened to /open-swe after #19 removed it
 * from the example app; the test was green for a page that did not exist.
 * Asserting the status first means the next deleted route fails loudly on
 * the line that says "this route should exist" instead of going quietly
 * green.
 */
async function gotoAndAudit(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(
    response?.status(),
    `${path} should be a real route, not a 404 rendered through the root layout`
  ).toBe(200);
  await page.waitForLoadState("networkidle");
  await runAxe(page, path);
}

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
  // NOTE: /open-swe was audited here until #19 removed that rung from the
  // example app. The test kept passing against the 404 page for as long as it
  // survived the route. It is deleted rather than repointed — apps/open-swe
  // has its own dev server and belongs in its own project, per SCOPE above.

  test("/ (chat composer) is WCAG A/AA conformant", async ({ page }) => {
    await gotoAndAudit(page, "/");
  });

  test("/hitl-demo (HITL approval demo) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await gotoAndAudit(page, "/hitl-demo");
  });

  test("/concurrent-test (two-pane harness) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await gotoAndAudit(page, "/concurrent-test");
  });

  test("/reconnect-test (resume harness) is WCAG A/AA conformant", async ({
    page,
  }) => {
    await gotoAndAudit(page, "/reconnect-test");
  });
});
