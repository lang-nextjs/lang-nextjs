import { test, expect } from "@playwright/test";

/**
 * The theme must actually RENDER — #148.
 *
 * WHY THIS EXISTS, AND WHY THE RATCHET DOES NOT COVER IT.
 * `palette-ratchet` counts HARDCODED palette classes. That is a different noun
 * from "the design tokens resolve". Measured against a reproduction of #148, the
 * ratchet emitted byte-identical output for a correctly themed app and for a
 * black-and-hairlines wireframe:
 *
 *   BROKEN:  0 findings in 0 files (baseline 0 in 0)  exit 0
 *   HEALTHY: 0 findings in 0 files (baseline 0 in 0)  exit 0
 *
 * It is not the ratchet's fault. A surface that lost its tokens has zero
 * hardcoded classes BECAUSE IT HAS ZERO RESOLVED ANYTHING, so it passes
 * perfectly. We had a guard against the wrong noun and were reading its green as
 * "the theme is fine".
 *
 * WHY THE FAILURE LOOKS LIKE A WIREFRAME RATHER THAN A BROKEN PAGE — the thing
 * that made #148 hard to spot, and the reason to assert FILLS rather than just
 * "some CSS loaded". When a custom property is undefined:
 *
 *   border-color: var(--border)          -> falls back to currentColor -> HAIRLINE SURVIVES
 *   background-color: var(--background)  -> falls back to transparent  -> FILL VANISHES
 *
 * Two different fallback rules, so every surface becomes an outlined rectangle
 * on black and the page still renders confidently. Nothing errors, nothing warns.
 *
 * WHAT THIS ASSERTS, DELIBERATELY: that the tokens RESOLVE, not what colour they
 * are. Pinning values would make every legitimate theme change a test failure,
 * which is how a guard gets rubber-stamped and then removed.
 */

const TOKENS = [
  // Primitive, from @digitalfrontier/theme's :root. This is the one that was
  // absent in the reproduction while its consumers were present.
  "--df-bg",
  // The alias layer that maps primitives onto Tailwind's semantic names. Both
  // are checked because they can fail independently: the mapping arrived in the
  // reproduction while the primitives did not.
  "--background",
  "--card",
  "--border",
];

test.describe("open-swe — the theme renders (#148)", () => {
  test("design tokens resolve to real values, not empty strings", async ({ page }) => {
    await page.goto("/");
    const resolved = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
    }, TOKENS);

    for (const name of TOKENS) {
      expect(
        resolved[name],
        `${name} resolved to an empty string. The stylesheet loaded but its custom ` +
          `properties are absent — every surface using it renders transparent while ` +
          `borders fall back to currentColor. See #148.`
      ).not.toBe("");
    }
  });

  test("themed surfaces have real fills, and are distinguishable from the page", async ({
    page,
  }) => {
    await page.goto("/");

    // SUBJECT GUARD, and it is not optional. Every assertion below is of the
    // form "no card is transparent". With zero cards that is VACUOUSLY TRUE —
    // and zero cards is precisely what a catastrophically broken page looks
    // like. Without this, the guard reports success loudest exactly when things
    // are worst.
    const cards = page.locator('[class*="bg-card"]');
    const count = await cards.count();
    expect(
      count,
      "no element carrying bg-card was found, so the fill assertions below would " +
        "pass without checking anything. Either the page failed to render or the " +
        "selector is stale — both are failures, neither is a pass."
    ).toBeGreaterThan(0);

    const transparent = (c: string) =>
      c === "transparent" || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c);

    const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(transparent(pageBg), `page background is transparent (${pageBg})`).toBe(false);

    for (let i = 0; i < count; i++) {
      const bg = await cards.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(
        transparent(bg),
        `a bg-card surface computed to ${bg}. An undefined --card makes the fill ` +
          `transparent while its border survives as currentColor — the #148 wireframe.`
      ).toBe(false);
    }

    // ELEVATION. Tokens can all resolve and still collapse to one flat colour,
    // which reads as "no surfaces" to a human even though nothing is empty.
    // The theme's own comment says --df-rail is deliberately LIGHTER than
    // --df-bg, so a card that matches the page is a real regression.
    const cardBg = await cards.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(
      cardBg,
      `card background is identical to the page background (${cardBg}). The tokens ` +
        `resolve but the surfaces are indistinguishable — visually this is still flat.`
    ).not.toBe(pageBg);
  });
});
