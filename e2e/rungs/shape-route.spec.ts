import { test, expect } from "@playwright/test";

/**
 * `/r/[rung]` — THE SHAPE-ROUTED SURFACE, which had no end-to-end coverage.
 *
 * This route is where the manifest stops being a file and starts being
 * behaviour. `rungs.json` declares each rung's SHAPE, and the route dispatches
 * on it: a `conversation` rung mounts a chat surface, a `run` rung renders a
 * departure to wherever that rung actually lives. They are different
 * information architectures, not two tabs of one.
 *
 * WHY THE FIRST CASE HERE IS THE ONE ABOUT TWO PAGES BEING DIFFERENT.
 * ConversationMount's own comment records the defect this route exists to
 * prevent, and it is a vacuity defect:
 *
 *   "for a while it could not apply the rung at all. app/page.tsx exported a
 *    surface that took no props, so /r/langchain and /r/deepagents resolved,
 *    dispatched correctly, and rendered byte-identical pages — the rung was
 *    validated and discarded."
 *
 * Every obvious assertion passes in that world. The route resolves. It does not
 * 404. It renders a chat surface. It dispatches by shape. All true, all green,
 * and the rung is being thrown away. The only assertion that fails is one that
 * compares two rungs against each other — so that is the assertion this file
 * leads with.
 */

const CONVERSATION_RUNGS = ["langchain", "langgraph", "deepagents"] as const;
const RUN_RUNGS = ["open-swe", "software-developer-agent"] as const;
const ALL_RUNGS = [...CONVERSATION_RUNGS, ...RUN_RUNGS];

/** The adapter button for a rung, which carries aria-pressed on the surface. */
const adapterButton = (name: string) => `button[aria-pressed][title^="${name} "]`;

test.describe("/r/[rung] — the manifest's shape, routed", () => {
  test("THE REGRESSION THIS ROUTE EXISTS TO PREVENT: two conversation rungs do not render the same page", async ({
    page,
  }) => {
    // If the rung is validated and discarded, both of these mount the default
    // and this is the only case in the file that notices.
    await page.goto("/r/langchain");
    await expect(page.locator(adapterButton("langchain"))).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await page.goto("/r/deepagents");
    await expect(page.locator(adapterButton("deepagents"))).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // and the other rung is NOT the active one — "both pressed" would satisfy
    // the two assertions above while still meaning the selection did nothing.
    await expect(page.locator(adapterButton("langchain"))).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  for (const rung of CONVERSATION_RUNGS) {
    test(`/r/${rung} seeds the conversation surface with ${rung}, not the default`, async ({
      page,
    }) => {
      await page.goto(`/r/${rung}`);
      await expect(page.locator(adapterButton(rung))).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  }

  test("a conversation rung mounts a COMPOSER — the surface you can talk to", async ({
    page,
  }) => {
    await page.goto("/r/langchain");
    await expect(page.getByRole("textbox")).toBeAttached();
  });

  test("a run rung renders a DEPARTURE, not a composer", async ({ page }) => {
    // The asymmetry is the design: a run rung is not a chat, so this app routes
    // you out rather than pretending to embed it. A composer here would mean
    // the shape dispatch collapsed into one surface.
    await page.goto("/r/open-swe");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("own origin", { exact: false })).toBeVisible();
  });

  test("the departure for a rung that HAS a target offers a link to it", async ({
    page,
  }) => {
    await page.goto("/r/open-swe");
    const link = page.getByRole("link", { name: /Open open-swe/i });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^https?:\/\//); // a real origin, not a relative path
  });

  test("a rung DECLARED but not present says so, and offers no link", async ({
    page,
  }) => {
    // software-developer-agent is `target: { kind: "none" }`. The honest answer
    // is "declared in the ladder, not present in this repo" — not a 404, because
    // it IS in the ladder, and not a dead button, because there is nowhere to go.
    await page.goto("/r/software-developer-agent");
    await expect(
      page.getByText("not present in this repo", { exact: false })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open /i })).toHaveCount(0);
  });

  test("the two run rungs do NOT render the same departure", async ({ page }) => {
    // The same vacuity check as the conversation pair, on the other branch: one
    // has a target and one does not, so a departure that ignored its rung would
    // show a link on both or neither.
    await page.goto("/r/open-swe");
    const withTarget = await page.getByRole("link", { name: /^Open /i }).count();
    await page.goto("/r/software-developer-agent");
    const withoutTarget = await page
      .getByRole("link", { name: /^Open /i })
      .count();
    expect(withTarget).toBeGreaterThan(0);
    expect(withoutTarget).toBe(0);
  });

  test("every rung in the manifest is ADDRESSABLE — none 404s", async ({
    page,
  }) => {
    for (const rung of ALL_RUNGS) {
      const res = await page.goto(`/r/${rung}`);
      expect(res?.status(), `/r/${rung} should resolve`).toBeLessThan(400);
    }
  });

  test("an id that is NOT in the manifest is a real 404", async ({ page }) => {
    // The manifest is the authority on what a rung is, so "not in RUNGS" is the
    // definition of unknown — and unknown must not fall through to the default
    // rung, which would make every typo silently open langchain.
    const res = await page.goto("/r/not-a-rung");
    expect(res?.status()).toBe(404);
    await expect(page.locator(adapterButton("langchain"))).toHaveCount(0);
  });

  test("the departure names the rung's ORDINAL and SHAPE from the manifest", async ({
    page,
  }) => {
    // Rendering the id alone would look correct while proving only that the
    // route read the URL. The ordinal and shape can only come from the manifest.
    await page.goto("/r/open-swe");
    // Scoped to the BADGES. The word "run" also appears as <code>run</code> in
    // the explanatory prose, and a page-wide text match is satisfied by that
    // paragraph alone — which would prove the page contains the right words
    // rather than that it read the manifest. The badges are the rendered
    // manifest values; the prose is a fixed string.
    const badges = page.locator('[data-slot="badge"]');
    await expect(badges.filter({ hasText: /^rung \d+$/ })).toHaveCount(1);
    await expect(badges.filter({ hasText: /^run$/ })).toHaveCount(1);
  });
});
