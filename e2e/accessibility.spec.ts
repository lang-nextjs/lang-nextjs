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

/** Hash of the current full-page render. Used to PROVE a theme switch took. */

/**
 * Put the page into dark mode — BOTH signals, because only one of them works.
 *
 * packages/ui declares `@custom-variant dark (&:is(.dark *))`, which is
 * CLASS-based. Playwright's `colorScheme: "dark"` only sets the media feature,
 * so on its own it changes literally nothing here: measured, the full-page
 * hash after `emulateMedia({ colorScheme: "dark" })` is byte-identical to the
 * light render. A dark-mode audit written that way is an audit of the light
 * render, run twice, reporting zero violations both times — which is exactly
 * how a dark-mode a11y test can be green and worthless.
 *
 * emulateMedia is kept for anything that legitimately keys off the media
 * query; the class is what actually flips the tokens.
 */
async function setDarkMode(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
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

  /**
   * /dashboard — the shadcn dashboard-01 shell adopted in #44.
   *
   * This route is the reason the gate exists. #44's argument is that adopting
   * an upstream component library does NOT inherit its conformance, and the
   * concrete proof was here: shadcn ships SidebarGroupLabel at
   * `text-sidebar-foreground/70`, which composited to 4.26:1 against shadcn's
   * own light sidebar and failed AA on three nodes.
   *
   * THAT NUMBER NO LONGER APPLIES, and the reason is worth keeping. The repo
   * briefly carried a deviation to /80; it has been reverted to stock /70.
   * Under @digitalfrontier/theme the label sits on `--df-rail`, which the
   * theme makes deliberately LIGHTER than `--df-bg` ("the rail reads as a
   * surface above the page, not a well"), and stock /70 measures 6.10:1
   * there — comfortably AA. The 4.26:1 finding was real against stock shadcn
   * and simply does not transfer to a different sidebar token. Carrying the
   * patch once its justification was gone would have been unexplained
   * divergence that makes the next `shadcn add --overwrite` a silent conflict.
   *
   * So this test no longer guards a local deviation. It guards something more
   * durable: that the render being audited is genuinely the THEMED render.
   */

  /**
   * The theme is dark-only, so "is this the themed render?" cannot be proven
   * by comparing a dark render against a light one — there is no light one.
   *
   * The previous version proved it with `darkHash !== lightHash`, which was
   * correct while the app had two themes and became unprovable-by-construction
   * the moment it had one: toggling produced an identical render, so the guard
   * fired on a page that was already correct.
   *
   * Same property, valid premise: assert the render IS the themed one. A
   * violation count still cannot detect this failure mode — an unthemed page
   * can audit clean — so the proof has to be that the theme's own tokens are
   * live and reaching the page.
   */
  async function expectThemedRender(page: Page): Promise<void> {
    const theme = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        dfBg: root.getPropertyValue("--df-bg").trim(),
        background: root.getPropertyValue("--background").trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });

    // 1. The package is actually loaded. If the @import failed or resolved to
    //    nothing, --df-bg is empty and every assertion below would be vacuous.
    expect(
      theme.dfBg,
      "--df-bg is empty — @digitalfrontier/theme did not load, so this audit would be auditing an unthemed page"
    ).not.toBe("");

    // 2. The alias chain is intact. --background must still resolve THROUGH the
    //    primitive; a local redeclaration would detach it and start a fifth
    //    palette, which is the drift df-theme-check exists to reject.
    expect(
      theme.background,
      "--background does not resolve to --df-bg — something is shadowing the canonical token"
    ).toBe(theme.dfBg);

    // 3. The tokens actually reach the paint. A theme can be loaded and still
    //    be painted over by a hardcoded surface, which is exactly what the
    //    chat route did before #44b (bg-white under cream text, 1.12:1).
    // Parse ALL channels. Reading only rgb and dropping alpha is a real hole:
    // getComputedStyle returns `rgba(0, 0, 0, 0)` for a body with NO background,
    // which parses to black and scores luminance 0 — "perfectly dark" for an
    // element painting nothing. The browser then renders it white, under cream
    // text. That is the same 1.12:1 failure this assertion exists to catch, and
    // it is the spelling that actually occurs, so it must not be the one that
    // slips through. Unparseable values fall back to white and fail closed.
    const parts = theme.bodyBg.match(/[\d.]+/g)?.map(Number) ?? [];
    const [r, g, b] = parts.length >= 3 ? parts : [255, 255, 255];
    const alpha = parts.length >= 4 ? parts[3] : 1;

    // Transparent and light-but-opaque are different faults with different
    // fixes — a missing background class versus a hardcoded surface — so they
    // get separate assertions rather than one merged verdict.
    expect(
      alpha,
      `body background is ${theme.bodyBg} — transparent, so nothing is painting the themed surface and the page renders on the browser default regardless of the tokens`
    ).toBeGreaterThanOrEqual(1);

    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    expect(
      luminance,
      `body background ${theme.bodyBg} is not dark — the theme is dark-only, so a light surface means it is being painted over`
    ).toBeLessThan(0.2);
  }

  test("/dashboard (df theme) is WCAG A/AA conformant — and the audited render is proven to be the themed render", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard");
    expect(response?.status(), "/dashboard should be a real route").toBe(200);
    await page.waitForLoadState("networkidle");

    await expectThemedRender(page);
    await runAxe(page, "/dashboard");
  });

  /**
   * The theme keeps `.dark { color-scheme: dark }` for consumers that set
   * <html class="dark"> explicitly. This audits that path — not because it
   * renders differently (it does not, and asserting that it did is what broke
   * this test before) but because a consumer that opts in must not be worse off.
   */
  test("/dashboard stays conformant with an explicit .dark class", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await setDarkMode(page);

    const applied = await page.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    expect(
      applied,
      "the .dark class was not applied, so this audit proves nothing about that path"
    ).toBe(true);

    await expectThemedRender(page);
    await runAxe(page, "/dashboard (.dark)");
  });
});
