import { test, expect } from "@playwright/test";

/**
 * A LONG RUNG ID MUST NOT WRAP OUT OF ITS ROW (#723).
 *
 * `software-developer-agent` is the longest id in rungs.json and the only rung
 * that is BOTH `target.kind: "none"` — the branch that renders a state badge —
 * and long enough to wrap. Its label had no `truncate`, so it laid out over
 * three lines inside a fixed-height button while the `ml-auto` badge came down
 * on top of the text. Measured on main before the fix:
 *
 *     label height 60px   row height 32px   overflows: true
 *
 * and after:
 *
 *     label height 20px   row height 32px   overflows: false
 *
 * WHY THIS ASSERTS GEOMETRY RATHER THAN A CLASS NAME. `toHaveClass(/truncate/)`
 * would pass against a label that still overflows — `truncate` needs the flex
 * parent to permit shrinking, so the utility can be present and defeated, and
 * the assertion would go green over the exact rendering it exists to forbid.
 * The property is "the label fits its row", so that is what is measured.
 *
 * THE COMPANION MATTERS AS MUCH AS THE ASSERTION. A row that failed to render
 * at all would satisfy any "does not overflow" check, so this first proves the
 * label is present and carries the full id — truncation is visual only, and the
 * accessible name must still be the whole thing.
 */
test("a long rung id truncates instead of wrapping over its badge", async ({
  page,
}) => {
  await page.goto("/runs");

  const label = page
    .locator("span")
    .filter({ hasText: /^software-developer-agent$/ })
    .first();

  // PRESENCE COMPANION: an absent row overflows nothing.
  await expect(label).toBeVisible();
  await expect(label).toHaveText("software-developer-agent");

  const box = await label.evaluate((el) => {
    const row = el.closest("li") ?? el.parentElement!;
    return {
      labelHeight: el.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });

  // The defect: a label taller than the row it sits in.
  expect(
    box.labelHeight,
    `label is ${box.labelHeight}px inside a ${box.rowHeight}px row — it is wrapping`
  ).toBeLessThanOrEqual(box.rowHeight);

  // And it is truncating rather than merely being short: the text really is
  // wider than the box. Without this the assertion above would also pass if the
  // id were ever shortened, which would retire the test without anyone noticing.
  expect(
    box.scrollWidth,
    "label is not actually overflowing horizontally — is this still the longest id?"
  ).toBeGreaterThan(box.clientWidth);
});
