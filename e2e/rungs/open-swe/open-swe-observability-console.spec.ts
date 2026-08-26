import { test, expect, type Page } from "@playwright/test";

/**
 * THE SHORTCUT INTO THE OBSERVABILITY CONSOLE.
 *
 * The settings panel already says whether spans are reaching LangSmith or
 * Langfuse. What it could not do is take you there — and "take you there" is
 * the whole action a person performs after reading that row, especially when
 * the row says a span was REJECTED or could not be verified.
 *
 * THE INTERESTING PART IS THE REFUSAL, NOT THE LINK. For Langfuse the address
 * the backend posts spans to and the address a human opens are routinely
 * different, and the repo's own fixture says so:
 *
 *   LANGFUSE_HOST: http://langfuse:3000
 *   # the in-network address, not localhost:3100
 *
 * Building the link from that host would produce a control that looks live and
 * resolves nowhere. So the resolver declines, and says why. These cases exist
 * mostly to hold that refusal in place, because the version that links
 * everything passes every "the link is there" test.
 */

interface Row {
  id: string;
  label: string;
  state: string;
  detail?: string;
  consoleUrl?: string;
  consoleUnavailableBecause?: string;
}

/**
 * Mock the DEPENDENCIES endpoint, not /api/config.
 *
 * The first version of this file stubbed /api/config, which is what the
 * dependencies route reads — and intercepted nothing, because that fetch is
 * server-to-server and `page.route` only sees the browser's own requests. The
 * console resolution itself is unit-tested next to the route; what these cases
 * own is the rendering and, above all, the refusal.
 */
async function mockDeps(page: Page, dependencies: Row[]): Promise<void> {
  await page.route("**/api/open-swe/dependencies**", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ probedAt: new Date().toISOString(), dependencies }),
    })
  );
  await page.route("**/api/config", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeLlm: "nvidia" }),
    })
  );
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "observability-langsmith",
  label: "LangSmith",
  state: "unverified",
  detail: "credentials present",
  ...over,
});

test.describe("settings — the observability console shortcut", () => {
  test("LangSmith offers a link to its console", async ({ page }) => {
    await mockDeps(page, [row({ consoleUrl: "https://smith.langchain.com" })]);
    await page.goto("/settings");
    const link = page.getByTestId("dep-observability-langsmith-console");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toBe("https://smith.langchain.com");
  });

  test("the link opens in a new tab and does not leak the referrer", async ({
    page,
  }) => {
    // `noreferrer` also drops window.opener, which is the half that matters for
    // a link out to a third-party console.
    await mockDeps(page, [row({ consoleUrl: "https://smith.langchain.com" })]);
    await page.goto("/settings");
    const link = page.getByTestId("dep-observability-langsmith-console");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noreferrer/);
  });

  test("the link is labelled with the integration it opens", async ({ page }) => {
    // Several rows can carry a console. "Open" alone is ambiguous the moment
    // there are two of them.
    await mockDeps(page, [
      row({ consoleUrl: "https://smith.langchain.com" }),
      row({
        id: "observability-langfuse",
        label: "Langfuse",
        consoleUrl: "https://cloud.langfuse.com",
      }),
    ]);
    await page.goto("/settings");
    await expect(
      page.getByTestId("dep-observability-langsmith-console")
    ).toContainText("LangSmith");
    await expect(
      page.getByTestId("dep-observability-langfuse-console")
    ).toContainText("Langfuse");
  });

  test("two integrations each get their OWN link, not a shared one", async ({
    page,
  }) => {
    await mockDeps(page, [
      row({ consoleUrl: "https://smith.langchain.com" }),
      row({
        id: "observability-langfuse",
        label: "Langfuse",
        consoleUrl: "http://localhost:3100",
      }),
    ]);
    await page.goto("/settings");
    expect(
      await page
        .getByTestId("dep-observability-langsmith-console")
        .getAttribute("href")
    ).toBe("https://smith.langchain.com");
    expect(
      await page
        .getByTestId("dep-observability-langfuse-console")
        .getAttribute("href")
    ).toBe("http://localhost:3100");
  });

  test("THE REFUSAL: a row with no console URL renders no link", async ({
    page,
  }) => {
    await mockDeps(page, [
      row({
        id: "observability-langfuse",
        label: "Langfuse",
        consoleUnavailableBecause:
          "the backend sends spans to http://langfuse:3000, which is not an address this browser can open — set LANGFUSE_CONSOLE_URL to the public one",
      }),
    ]);
    await page.goto("/settings");
    await expect(
      page.getByTestId("dep-observability-langfuse-console")
    ).toHaveCount(0);
  });

  test("…and it SAYS WHY, naming the host and the way out", async ({ page }) => {
    // An absent link with no explanation is indistinguishable from a missing
    // feature. The reason has to name what it rejected and what fixes it.
    await mockDeps(page, [
      row({
        id: "observability-langfuse",
        label: "Langfuse",
        consoleUnavailableBecause:
          "the backend sends spans to http://langfuse:3000, which is not an address this browser can open — set LANGFUSE_CONSOLE_URL to the public one",
      }),
    ]);
    await page.goto("/settings");
    const why = page.getByTestId("dep-observability-langfuse-console-why");
    await expect(why).toBeVisible();
    await expect(why).toContainText("langfuse:3000");
    await expect(why).toContainText("LANGFUSE_CONSOLE_URL");
  });

  test("a row with NEITHER a link nor a reason renders neither element", async ({
    page,
  }) => {
    // The control for the case above: an explanation element that is always
    // present would satisfy it while carrying nothing.
    await mockDeps(page, [row({ id: "observability-langfuse", label: "Langfuse" })]);
    await page.goto("/settings");
    await expect(
      page.getByTestId("dep-observability-langfuse-console")
    ).toHaveCount(0);
    await expect(
      page.getByTestId("dep-observability-langfuse-console-why")
    ).toHaveCount(0);
  });

  test("a REJECTED span still gets a console link", async ({ page }) => {
    // The case where you most need to go and look.
    await mockDeps(page, [
      row({ state: "unreachable", consoleUrl: "https://smith.langchain.com" }),
    ]);
    await page.goto("/settings");
    await expect(
      page.getByTestId("dep-observability-langsmith-console")
    ).toBeVisible();
  });

  test("the link does not replace the STATUS — both are rendered", async ({
    page,
  }) => {
    // A shortcut that displaced the health row would trade a fact for a
    // convenience. The row still has to say what it observed.
    await mockDeps(page, [row({ consoleUrl: "https://smith.langchain.com" })]);
    await page.goto("/settings");
    await expect(
      page.getByTestId("dep-observability-langsmith-label")
    ).toBeVisible();
    await expect(
      page.getByTestId("dep-observability-langsmith-console")
    ).toBeVisible();
  });

  test("a NON-observability dependency gets no console link", async ({ page }) => {
    // The resolver answers only for the integrations it knows. A sandbox row
    // with an "Open" button would be a link to nowhere.
    await mockDeps(page, [
      { id: "sandbox", label: "Sandbox", state: "responding" },
    ]);
    await page.goto("/settings");
    await expect(page.getByTestId("dep-sandbox-console")).toHaveCount(0);
  });
});
