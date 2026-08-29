import { test, expect, type Page } from "@playwright/test";

/**
 * The /chat control surface: FRAMEWORK x RUNTIME x MODE, plus the states around
 * sending.
 *
 * These three axes are derived from rungs.json, and the whole point of deriving
 * them is that a fork gets the cells it can actually serve. A control that
 * offers a combination the backend cannot answer hands the user a button that
 * produces an error — which is the same defect as a status nothing computed,
 * expressed as an affordance.
 *
 * #211's substitution notice is here too: a typo'd ?framework= must SAY it was
 * substituted rather than silently serving the default.
 */

async function mockChat(page: Page, over: Record<string, unknown> = {}) {
  await page.route("**/api/config", (r) =>
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        activeLlm: "nvidia",
        backends: { django: true, fastapi: true },
        ...over,
      }),
    })
  );
  await page.route("**/api/chat/tools**", (r) =>
    void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tools: [] }) })
  );
  await page.route("**/api/open-swe/sandbox/health", (r) =>
    void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, provider: "docker" }) })
  );
}

test.describe("open-swe /chat — the three axes", () => {
  test("all three conversation frameworks are offered", async ({ page }) => {
    await mockChat(page);
    await page.goto("/chat");
    for (const f of ["langchain", "langgraph", "deepagents"]) {
      await expect(page.getByTestId(`framework-${f}`)).toBeAttached();
    }
  });

  test("open-swe is NOT offered as a chat framework", async ({ page }) => {
    // It is run-shaped, not conversation-shaped. Offering it would route a chat
    // request at a rung that does not serve one.
    await mockChat(page);
    await page.goto("/chat");
    await expect(page.getByTestId("framework-open-swe")).toHaveCount(0);
  });

  test("both runtimes are offered when the backend reports both", async ({ page }) => {
    await mockChat(page);
    await page.goto("/chat");
    await expect(page.getByTestId("runtime-django")).toBeAttached();
    await expect(page.getByTestId("runtime-fastapi")).toBeAttached();
  });

  test("selecting a framework is REFLECTED in the URL, not just clicked", async ({ page }) => {
    // A control that accepts a click and changes nothing is the defect this repo
    // keeps finding.
    //
    // Asserted via the URL rather than via the control's own state: the URL is
    // what a shared link carries, and a control that updates itself while the
    // URL stays put is the exact half-wired failure this case exists for.
    //
    // (#158 retired the older note here. The framework axis is a <select> now,
    // so selection reaches assistive technology through the platform rather
    // than through an aria-pressed the framework buttons never carried.)
    await mockChat(page);
    await page.goto("/chat");
    const before = page.url();
    await page.getByTestId("framework-select").selectOption("langgraph");
    await expect.poll(() => page.url()).not.toBe(before);
  });

  test("the framework choice SURVIVES in the URL", async ({ page }) => {
    // A deep link is how somebody shares a configuration. If the click does not
    // reach the URL, the link they send is a different conversation.
    await mockChat(page);
    await page.goto("/chat");
    await page.getByTestId("framework-select").selectOption("langgraph");
    await expect.poll(() => page.url()).toContain("langgraph");
  });

  test("deepagents offers deep-research; langchain does not", async ({ page }) => {
    // The asymmetry that makes the two-axis derivation necessary. If every cell
    // offered every mode, the derivation would be decoration.
    await mockChat(page);
    await page.goto("/chat?framework=deepagents");
    await expect(page.getByTestId("topology-deep-research")).toBeAttached();
    await page.goto("/chat?framework=langchain");
    await expect(page.getByTestId("topology-deep-research")).toHaveCount(0);
  });

  test("react and plan-execute are offered on every framework", async ({ page }) => {
    await mockChat(page);
    for (const f of ["langchain", "langgraph", "deepagents"]) {
      await page.goto(`/chat?framework=${f}`);
      await expect(page.getByTestId("topology-react")).toBeAttached();
      await expect(page.getByTestId("topology-plan-execute")).toBeAttached();
    }
  });

  test("an UNKNOWN ?framework= says it was substituted (#211)", async ({ page }) => {
    // Silently serving the default means a typo'd bookmark lands somewhere else
    // with no signal — a wrong value producing a plausible screen.
    await mockChat(page);
    await page.goto("/chat?framework=not-a-real-rung");
    await expect(page.getByTestId("framework-substituted")).toBeAttached();
  });

  test("a KNOWN ?framework= is honoured SILENTLY — no substitution notice", async ({ page }) => {
    // The control. Without it, a page that always showed the notice would pass
    // the case above while telling every user their link was wrong.
    await mockChat(page);
    await page.goto("/chat?framework=langgraph");
    await expect(page.getByTestId("framework-substituted")).toHaveCount(0);
  });

  test("NO ?framework= is not a substitution either", async ({ page }) => {
    await mockChat(page);
    await page.goto("/chat");
    await expect(page.getByTestId("framework-substituted")).toHaveCount(0);
  });

  test("chat is BLOCKED and says why when no model is configured", async ({ page }) => {
    await mockChat(page, { activeLlm: null });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-blocked")).toBeAttached();
  });

  test("chat-status is present and non-empty", async ({ page }) => {
    await mockChat(page);
    await page.goto("/chat");
    // chat-status is rendered unconditionally by the chat page, so guarding on
    // its existence only bought the test a way to pass having asserted nothing.
    const s = page.getByTestId("chat-status");
    await expect(s).toBeAttached();
    expect((await s.innerText()).trim().length).toBeGreaterThan(0);
  });
});
