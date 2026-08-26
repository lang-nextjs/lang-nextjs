import { test, expect, type Page } from "@playwright/test";

/**
 * E2E for the open-swe /chat and /settings surfaces.
 *
 * WHAT THESE ASSERT, AND WHY IT IS THE INTERESTING HALF. Almost every
 * assertion here is about what the UI says when a dependency is ABSENT OR
 * SLOW, not when it is healthy. That is deliberate: the bug these surfaces
 * exist to prevent shipped once already — a green dot that meant "the UI is
 * not busy" was read as "the system is ready", so the first thing a person
 * learned about a missing API key was a failed send. Every dependency is
 * mocked with `page.route`, which makes the absent and the never-answers cases
 * as easy to stage as the happy one.
 *
 * NO LIVE BACKEND. `/api/config`, `/api/open-swe/sandbox/health`,
 * `/api/chat/tools` and `/api/chat/stream` are all mocked per test. Nothing
 * here needs :8001.
 *
 * COVERAGE NOTE — one testid in this area is deliberately NOT asserted:
 * `chat-workspace`. It is an always-rendered container whose only
 * self-contained contract is "the aside exists"; everything meaningful about
 * it is the `ws-task` / `ws-tool` / `ws-subagent` / `tool-payload` content,
 * which is a separate unassigned work item. Asserting the container's presence
 * on its own would raise a coverage count while proving nothing, and would
 * make the surface look tested to whoever picks up the ws-* set. It is left
 * uncovered on purpose, to be done with those.
 */

// ---------------------------------------------------------------------------
// Route stubs. Each returns a promise-shaped control so a test can stage
// "answered", "answered with nothing", or "never answers".
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "open-swe:workspace-settings:v1";

/** `/api/config` answers with the given body. */
async function mockConfig(page: Page, body: Record<string, unknown>) {
  await page.route(
    "**/api/config",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
  );
}

/**
 * `/api/config` never answers.
 *
 * This is the case a lazy readiness implementation gets wrong: with the probe
 * still in flight there is no evidence either way, and the tempting default is
 * the optimistic one. Staged by holding the route open and never fulfilling.
 */
async function stallConfig(page: Page) {
  await page.route("**/api/config", () => {
    /* deliberately never fulfilled — the probe stays in flight */
  });
}

/** Tools list — always stubbed so a real backend is never required. */
async function mockTools(page: Page) {
  await page.route(
    "**/api/chat/tools**",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tools: [] }),
      })
  );
}

async function mockSandboxHealth(page: Page, body: Record<string, unknown>) {
  await page.route(
    "**/api/open-swe/sandbox/health",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
  );
}

/** The sandbox probe fails at the network layer, not with a body. */
async function failSandboxHealth(page: Page) {
  await page.route(
    "**/api/open-swe/sandbox/health",
    (route) => void route.abort("connectionrefused")
  );
}

// ---------------------------------------------------------------------------
// /chat — readiness
// ---------------------------------------------------------------------------

test.describe("open-swe /chat — readiness is computed from prerequisites", () => {
  test("no model key: status is blocked, the banner says why, and send is disabled", async ({
    page,
  }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: null });

    await page.goto("/chat");

    // The machine-readable half. Asserting the attribute rather than the dot's
    // colour is the point of #70: colour is a rendering of state, not the state.
    await expect(page.getByTestId("chat-status")).toHaveAttribute(
      "data-readiness",
      "blocked"
    );

    // The human-readable half must actually name the unmet prerequisite. A
    // banner that appears but says nothing actionable is the original bug with
    // an extra div.
    const blocked = page.getByTestId("chat-blocked");
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText(/API key/i);
    await expect(blocked).toContainText(/NVIDIA_API_KEY/);

    // And the control must be unusable, not merely discouraged.
    await expect(page.getByTestId("chat-send")).toBeDisabled();
    await expect(page.getByTestId("chat-input")).toBeDisabled();
  });

  test("model key present: status is ready, no banner, composer usable", async ({
    page,
  }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });

    await page.goto("/chat");

    await expect(page.getByTestId("chat-status")).toHaveAttribute(
      "data-readiness",
      "ready"
    );
    // Absence matters as much as presence: a banner that never clears would
    // train people to ignore it.
    await expect(page.getByTestId("chat-blocked")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeEnabled();

    // Send stays disabled on an empty composer — that is input validation, not
    // readiness. Typing must be what enables it, which also proves the enabled
    // state above is real rather than a stuck attribute.
    await expect(page.getByTestId("chat-send")).toBeDisabled();
    await page.getByTestId("chat-input").fill("hello");
    await expect(page.getByTestId("chat-send")).toBeEnabled();
  });

  test("probe never answers: status is unknown — NOT ready, and NOT blocked", async ({
    page,
  }) => {
    await mockTools(page);
    await stallConfig(page);

    await page.goto("/chat");

    // THE ASSERTION THIS FILE EXISTS FOR. An in-flight probe is an absence of
    // evidence. Rendering it as "ready" is the shipped bug; rendering it as
    // "blocked" would be the opposite error, condemning a surface that may be
    // perfectly healthy. `unknown` is the only honest answer, and it is the one
    // an implementation that treats null as falsy silently gets wrong.
    await expect(page.getByTestId("chat-status")).toHaveAttribute(
      "data-readiness",
      "unknown"
    );
    await expect(page.getByTestId("chat-blocked")).toHaveCount(0);

    // Unknown must not be usable either. "We do not know" is not permission.
    await expect(page.getByTestId("chat-send")).toBeDisabled();
  });

  test("failed probe is treated as unknown, not as absence", async ({
    page,
  }) => {
    await mockTools(page);
    await page.route(
      "**/api/config",
      (route) => void route.abort("connectionrefused")
    );

    await page.goto("/chat");

    // A probe that errored tells you about the probe, not about the key. The
    // page keeps llmConfigured null on catch, so this must read unknown — the
    // same distinction as `tracing: null` on /health, one layer up.
    await expect(page.getByTestId("chat-status")).toHaveAttribute(
      "data-readiness",
      "unknown"
    );
    await expect(page.getByTestId("chat-blocked")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// /chat — error surfacing
// ---------------------------------------------------------------------------

test.describe("open-swe /chat — stream errors are shown, not swallowed", () => {
  test("a data-error frame renders chat-error with the server's message", async ({
    page,
  }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await page.route(
      "**/api/chat/stream",
      (route) =>
        void route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "x-vercel-ai-ui-message-stream": "v1",
          },
          // The data payload must satisfy DataErrorSchema in full — id, seq,
          // code, message and retryable are all required. A partial payload is
          // silently dropped by the schema map and never reaches the message
          // union, which looks exactly like the page swallowing the error. Worth
          // stating: the first version of this test sent only code+message and
          // failed for that reason, not because the page was wrong.
          body:
            [
              `data: {"type":"start","messageId":"m1"}`,
              `data: {"type":"data-error","data":{"id":"e1","seq":0,"code":"upstream_unavailable","message":"Upstream model refused the request","retryable":false}}`,
              `data: {"type":"finish","finishReason":"stop"}`,
            ].join("\n\n") + "\n\n",
        })
    );

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    // The server's own message must reach the user. A generic "An error
    // occurred" would be the page throwing away the only diagnostic it had.
    const err = page.getByTestId("chat-error");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toContainText("Upstream model refused the request");
  });
});

// ---------------------------------------------------------------------------
// /chat — conversations
// ---------------------------------------------------------------------------

test.describe("open-swe sidebar — new chat and the conversation list", () => {
  test("new-chat creates a conversation, navigates to it, and lists it", async ({
    page,
  }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });

    await page.goto("/chat");

    // Empty state first, so the populated assertion below is a transition
    // rather than a coincidence of pre-existing storage.
    const list = page.getByTestId("conversation-list");
    await expect(list).toContainText("No conversations yet");

    await page.getByTestId("new-chat").click();

    // The button's contract is three things at once: it mints a conversation,
    // it routes you to that conversation, and the list reflects it. Asserting
    // only that the click "did something" would pass on a button that
    // navigated without persisting.
    await expect(page).toHaveURL(/\/chat\?framework=[^&]+&c=/);
    await expect(list).not.toContainText("No conversations yet");
    await expect(list).toContainText("New chat");
  });
});

// ---------------------------------------------------------------------------
// /settings — dependency panels
// ---------------------------------------------------------------------------

test.describe("open-swe /settings — absent and checking are distinct from configured", () => {
  test("llm panel: configured, no-key, and checking are three different renderings", async ({
    page,
  }) => {
    // 1. configured
    await mockSandboxHealth(page, { available: true, provider: "docker" });
    await mockConfig(page, { activeLlm: "nvidia" });
    await page.goto("/settings");
    await expect(page.getByTestId("settings-llm")).toContainText("configured");

    // 2. no key — must say runs will fail, not fall back to "checking"
    await page.unroute("**/api/config");
    await mockConfig(page, { activeLlm: null });
    await page.reload();
    const llm = page.getByTestId("settings-llm");
    await expect(llm).toContainText(/No key configured/i);
    await expect(llm).toContainText(/runs will fail/i);
    await expect(llm).not.toContainText("checking");

    // 3. never answers — "checking…", and specifically NOT the configured
    // rendering. This is the settings-page twin of the chat `unknown` case.
    await page.unroute("**/api/config");
    await stallConfig(page);
    await page.reload();
    await expect(llm).toContainText("checking");
    await expect(llm).not.toContainText("configured");
  });

  test("sandbox panel: unreachable is rendered as unreachable, not as checking", async ({
    page,
  }) => {
    await mockConfig(page, { activeLlm: "nvidia" });
    await failSandboxHealth(page);

    await page.goto("/settings");

    // An unreachable probe and an in-flight probe are different facts and the
    // panel has separate renderings for them. Collapsing them would leave a
    // dead sandbox looking like a slow one indefinitely.
    const sandbox = page.getByTestId("settings-sandbox");
    await expect(sandbox).toContainText("unreachable");
    await expect(sandbox).not.toContainText("checking");
  });

  test("sandbox panel: an available provider is named", async ({ page }) => {
    await mockConfig(page, { activeLlm: "nvidia" });
    await mockSandboxHealth(page, {
      available: true,
      provider: "docker",
      detail: "daemon reachable",
    });

    await page.goto("/settings");

    const sandbox = page.getByTestId("settings-sandbox");
    await expect(sandbox).toContainText("docker");
    await expect(sandbox).not.toContainText("unreachable");
    await expect(sandbox).not.toContainText("checking");
  });
});

// ---------------------------------------------------------------------------
// /settings — save round-trip
// ---------------------------------------------------------------------------

test.describe("open-swe /settings — save round-trips through localStorage", () => {
  test("edited values survive a reload, and Save is gated on being dirty", async ({
    page,
  }) => {
    await mockConfig(page, { activeLlm: "nvidia" });
    await mockSandboxHealth(page, { available: true, provider: "docker" });

    await page.goto("/settings");

    // Nothing edited yet, so Save is disabled. Without this the round-trip
    // below could pass on a Save button that was always live.
    await expect(page.getByTestId("settings-save")).toBeDisabled();

    await page
      .getByTestId("settings-system-prompt")
      .fill("Be extremely terse.");
    await page.getByTestId("settings-folders").fill("/work/src\n/work/docs");
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("settings-save").click();

    // Assert the STORAGE, not just the pixels: a page that kept the values in
    // React state and never persisted would look identical until reload.
    const stored = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      SETTINGS_KEY
    );
    expect(stored, "settings must reach localStorage").toBeTruthy();
    expect(stored!).toContain("Be extremely terse.");

    // And the reload is what proves it is read back, not merely written.
    await page.reload();
    await expect(page.getByTestId("settings-system-prompt")).toHaveValue(
      "Be extremely terse."
    );
    await expect(page.getByTestId("settings-folders")).toHaveValue(
      "/work/src\n/work/docs"
    );
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("when localStorage is blocked, the failure is stated rather than silent", async ({
    page,
  }) => {
    await mockConfig(page, { activeLlm: "nvidia" });
    await mockSandboxHealth(page, { available: true, provider: "docker" });

    // Private windows and blocked site-data make setItem throw. A save that
    // quietly does nothing is worse than one that fails loudly, because the
    // user walks away believing their settings are stored.
    await page.addInitScript(() => {
      const proto = Object.getPrototypeOf(window.localStorage);
      proto.setItem = function () {
        throw new DOMException("QuotaExceededError");
      };
    });

    await page.goto("/settings");
    await page.getByTestId("settings-system-prompt").fill("anything");
    await page.getByTestId("settings-save").click();

    await expect(page.getByText(/blocking local storage/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// /chat — the runtime selector (#133)
// ---------------------------------------------------------------------------

/**
 * #133 shipped this control with module-level unit coverage only —
 * topologiesFor, asPythonBackend, resolveBackendBase and buildBackendUrl are
 * all well tested; the rendered control was not. These are the assertions that
 * need a browser.
 *
 * NOTE ON EXPECTATIONS: the mode lists below are written as LITERALS on
 * purpose. Deriving them from @deepagents-nextjs/rungs would read the same
 * generated source the component reads, putting one source on both sides of
 * the comparison and producing a test that cannot fail. That is not
 * hypothetical here — a stale generated.ts survived in a branch precisely
 * because its tests derived their expectation from it.
 */
test.describe("open-swe /chat — the runtime selector selects a runtime", () => {
  async function configWith(
    page: Page,
    backends: { django: boolean; fastapi: boolean }
  ) {
    await page.route("**/api/config", (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ activeLlm: "nvidia", backends }),
      })
    );
  }

  test("aria-pressed reflects the selected runtime, and clicking moves it", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true });

    await page.goto("/chat");

    // fastapi is the initial selection. Reading aria-pressed rather than a
    // class keeps this about state, and it is the same attribute a screen
    // reader gets — so the assertion and the accessibility contract are one
    // thing rather than two that can drift.
    await expect(page.getByTestId("runtime-fastapi")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("runtime-django")).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    await page.getByTestId("runtime-django").click();

    // Both directions. Asserting only that django became pressed would pass on
    // a control that pressed everything it was clicked.
    await expect(page.getByTestId("runtime-django")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("runtime-fastapi")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("an unconfigured runtime is disabled and cannot be selected", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: false, fastapi: true });

    await page.goto("/chat");

    const django = page.getByTestId("runtime-django");
    await expect(django).toBeDisabled();

    // The real failure mode is a control that looks selectable and then 502s
    // on send, so assert the click genuinely does not take.
    await django.click({ force: true }).catch(() => {});
    await expect(django).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("runtime-fastapi")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  test("a disabled runtime names the env var that would enable it", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: false, fastapi: true });

    await page.goto("/chat");

    // Disabled-not-hidden is deliberate: an unconfigured runtime is one
    // .env.local line away, so hiding it would hide the remedy. A title that
    // stopped naming the variable would remove the remedy while still looking
    // correct, which nothing else would catch.
    await expect(page.getByTestId("runtime-django")).toHaveAttribute(
      "title",
      /DJANGO_URL/
    );
  });

  test("the mode list follows the runtime — deepagents serves deep-research on both", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true });

    await page.goto("/chat");
    await page.getByTestId("framework-deepagents").click();

    // LITERAL, not derived — see the note above this describe block.
    await expect(page.getByTestId("topology-deep-research")).toBeVisible();
    await page.getByTestId("runtime-django").click();
    await expect(page.getByTestId("topology-deep-research")).toBeVisible();

    // And the negative half, which is what stops a derivation that returned
    // everything everywhere from passing: langchain serves no deep-research on
    // either runtime.
    await page.getByTestId("framework-langchain").click();
    await expect(page.getByTestId("topology-deep-research")).toHaveCount(0);
    await page.getByTestId("runtime-fastapi").click();
    await expect(page.getByTestId("topology-deep-research")).toHaveCount(0);
  });
});

/**
 * THE DEPENDENCY PANEL, WHEN THE PROBE ITSELF FAILS (#237).
 *
 * Reported from a running app: the settings dependency panel showed nothing
 * useful. `loadDeps` did `const b = (await r.json())` and never read `r.ok`, so
 * a 500 carrying {"error": …} fell through `b.dependencies ?? []` — and the
 * panel renders `[]` as no rows and no message.
 *
 * The panel a person opens to find out whether their backends are reachable
 * went silently blank exactly when they were not, and looked identical to a
 * healthy system with nothing configured.
 *
 * EACH CASE IS A PAIR. Asserting only that a failure shows an error would be
 * satisfied by a panel that shows an error unconditionally, which is the same
 * defect facing the other way. The empty-but-successful case is what makes the
 * failure case mean anything.
 */
test.describe("open-swe /settings — a failed probe is distinguishable from an empty one", () => {
  const serveDeps = (page: Page, status: number, body: string) =>
    page.route("**/api/open-swe/dependencies**", (route) =>
      void route.fulfill({
        status,
        contentType: "application/json",
        body,
      })
    );

  test("a 500 says the probe failed, with the status and the reason", async ({
    page,
  }) => {
    await serveDeps(page, 500, JSON.stringify({ error: "probe crashed" }));
    await page.goto("/settings");

    const err = page.getByTestId("deps-error");
    await expect(err).toBeVisible();
    // NOT merely "an error appeared". The reported failure was a panel that
    // rendered without complaint, so a test satisfied by any visible error
    // would still pass against a banner that said nothing actionable.
    await expect(err).toContainText("500");
    await expect(err).toContainText("probe crashed");

    // And it must not ALSO claim the probe ran and found nothing.
    await expect(page.getByTestId("deps-empty")).toHaveCount(0);
  });

  test("a probe that ran and found nothing says THAT instead", async ({
    page,
  }) => {
    // The other half of the pair, and the one the old code collapsed the
    // failure into. Before #237 both of these rendered as an empty box.
    await serveDeps(page, 200, JSON.stringify({ dependencies: [], probedAt: "2026-08-26T12:00:00Z" }));
    await page.goto("/settings");

    await expect(page.getByTestId("deps-empty")).toBeVisible();
    await expect(page.getByTestId("deps-error")).toHaveCount(0);
  });

  test("a healthy probe still renders its rows", async ({ page }) => {
    // The control for both. Without it, "shows an error on 500" and "shows
    // empty on []" are both satisfied by a panel that never renders a
    // dependency at all.
    await serveDeps(
      page,
      200,
      JSON.stringify({
        probedAt: "2026-08-26T12:00:00Z",
        dependencies: [
          { id: "agent-backend", label: "Agent backend", state: "responding", latencyMs: 12 },
        ],
      })
    );
    await page.goto("/settings");

    await expect(page.getByTestId("dep-agent-backend")).toBeVisible();
    await expect(page.getByTestId("deps-error")).toHaveCount(0);
    await expect(page.getByTestId("deps-empty")).toHaveCount(0);
  });

  test("a 200 whose body is not a dependency list is a failure, not zero rows", async ({
    page,
  }) => {
    // `b.dependencies ?? []` is the exact line that produced the bug: an absent
    // key became a successful empty answer. A 200 is not, on its own, evidence
    // that the probe worked.
    await serveDeps(page, 200, JSON.stringify({ probedAt: "2026-08-26T12:00:00Z" }));
    await page.goto("/settings");

    await expect(page.getByTestId("deps-error")).toBeVisible();
    await expect(page.getByTestId("deps-empty")).toHaveCount(0);
  });
});
