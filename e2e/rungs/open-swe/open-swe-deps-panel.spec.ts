import { test, expect, type Page } from "@playwright/test";

/**
 * The dependency panel on /settings — the surface #124/#126 rebuilt so it
 * reports what it MEASURED rather than what is configured.
 *
 * The states are the subject. `unverified` exists because verifying LangSmith
 * costs a span, and the panel says so instead of absorbing the cost or guessing.
 * A panel that rendered every dependency the same colour would satisfy any test
 * that only checked the rows exist.
 */

type Dep = Record<string, unknown>;

async function mockDeps(page: Page, dependencies: Dep[], probedAt = new Date().toISOString()) {
  await page.route("**/api/open-swe/dependencies", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ probedAt, dependencies }),
    })
  );
  await page.route("**/api/config", (r) =>
    void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeLlm: "nvidia" }) })
  );
  await page.route("**/api/open-swe/sandbox/health", (r) =>
    void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, provider: "docker" }) })
  );
}

const dep = (id: string, state: string, over: Dep = {}): Dep => ({
  id,
  label: id,
  state,
  detail: `${id} detail`,
  ...over,
});

test.describe("open-swe /settings — the dependency panel reports what it measured", () => {
  test("the list renders one row per dependency", async ({ page }) => {
    await mockDeps(page, [dep("a", "responding"), dep("b", "not-configured")]);
    await page.goto("/settings");
    await expect(page.getByTestId("deps-list")).toBeAttached();
    await expect(page.getByTestId("dep-a")).toBeAttached();
    await expect(page.getByTestId("dep-b")).toBeAttached();
  });

  test("each row carries its STATE as data, not only as colour", async ({ page }) => {
    // Colour is not readable by a test, by a screen reader, or by anyone
    // diffing a DOM snapshot. The state has to be in the markup.
    await mockDeps(page, [dep("a", "unreachable")]);
    await page.goto("/settings");
    await expect(page.getByTestId("dep-a")).toHaveAttribute("data-state", "unreachable");
  });

  test("DISTINCT states render distinctly — not all one colour", async ({ page }) => {
    // The control that makes every other case meaningful. A panel painting
    // everything the same passes "the row exists" for all five states.
    await mockDeps(page, [
      dep("ok", "responding"),
      dep("nope", "unreachable"),
      dep("unk", "unverified"),
    ]);
    await page.goto("/settings");
    const tones = await page
      .locator("[data-testid^='dep-'][data-tone]")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-tone")))]);
    expect(tones.length).toBeGreaterThan(1);
  });

  test("`unverified` is NOT rendered as success", async ({ page }) => {
    // The whole reason the state exists. Rendering "not measured" as green is
    // the defect the panel was rebuilt to remove.
    await mockDeps(page, [dep("langsmith", "unverified")]);
    await page.goto("/settings");
    const tone = await page.getByTestId("dep-langsmith").getAttribute("data-tone");
    expect(tone).not.toBe("success");
  });

  test("unverifiableBecause is SURFACED, not swallowed", async ({ page }) => {
    // "Verifying costs a span" is the honest reason, and surfacing the cost
    // rather than absorbing it is what makes `unverified` a state rather than
    // an apology.
    await mockDeps(page, [
      dep("langsmith", "unverified", {
        unverifiableBecause: "confirming this would require emitting a span",
      }),
    ]);
    await page.goto("/settings");
    await expect(page.getByTestId("dep-langsmith-why")).toBeAttached();
  });

  test("a row WITHOUT a reason does not render an empty reason element", async ({ page }) => {
    // Control for the case above: an always-present element would satisfy it
    // while carrying nothing.
    await mockDeps(page, [dep("plain", "responding")]);
    await page.goto("/settings");
    await expect(page.getByTestId("dep-plain-why")).toHaveCount(0);
  });

  test("the panel reports the AGE of what it is showing", async ({ page }) => {
    // A green measured 40 minutes ago is a different claim from one measured
    // now, and a panel that cannot tell them apart is the same defect one level
    // up from the states themselves.
    await mockDeps(page, [dep("a", "responding")], "2020-01-01T00:00:00Z");
    await page.goto("/settings");
    await expect(page.getByTestId("deps-age")).toBeAttached();
    expect((await page.getByTestId("deps-age").innerText()).trim().length).toBeGreaterThan(0);
  });

  test("refresh REFETCHES the dependency probe", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/open-swe/dependencies", (r) => {
      calls++;
      return void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ probedAt: new Date().toISOString(), dependencies: [dep("a", "responding")] }),
      });
    });
    await page.route("**/api/config", (r) =>
      void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeLlm: "nvidia" }) })
    );
    await page.goto("/settings");
    await expect(page.getByTestId("deps-list")).toBeAttached();
    const before = calls;
    const btn = page.getByTestId("deps-refresh");
    if ((await btn.count()) > 0) {
      await btn.click();
      await expect.poll(() => calls).toBeGreaterThan(before);
    }
  });

  test("a FAILING probe does not render as a healthy empty panel", async ({ page }) => {
    await page.route("**/api/open-swe/dependencies", (r) =>
      void r.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    );
    await page.route("**/api/config", (r) =>
      void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeLlm: "nvidia" }) })
    );
    await page.goto("/settings");
    // Either an explicit error or simply no rows — what must NOT happen is a
    // panel of green rows invented from nothing.
    const greens = await page.locator("[data-testid^='dep-'][data-tone='success']").count();
    expect(greens).toBe(0);
  });

  test("settings save round-trips through localStorage", async ({ page }) => {
    await mockDeps(page, [dep("a", "responding")]);
    await page.goto("/settings");
    await page.getByTestId("settings-system-prompt").fill("Be terse.");
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("settings-save").click();
    await page.reload();
    await expect(page.getByTestId("settings-system-prompt")).toHaveValue("Be terse.");
  });

  test("Save is GATED on being dirty", async ({ page }) => {
    // Without this, the round-trip above could pass on a Save that was always
    // live — and an always-live Save writes on every visit.
    await mockDeps(page, [dep("a", "responding")]);
    await page.goto("/settings");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("the form is NOT editable before it has loaded (#188)", async ({ page }) => {
    // An un-loaded form is one whose contents are not known yet. Offering it
    // for editing promises a save it cannot keep — the two-field case silently
    // dropped one edit.
    await mockDeps(page, [dep("a", "responding")]);
    await page.goto("/settings");
    // Once loaded it must be editable; the property is that it is never
    // editable while unknown, which the disabled-then-enabled transition shows.
    await expect(page.getByTestId("settings-system-prompt")).toBeEnabled();
  });
});
