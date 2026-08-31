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
    "**/api/config*",
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
  await page.route("**/api/config*", () => {
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
      "**/api/config*",
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
  test("a data-error frame renders generic copy, and the detail reaches the console", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
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
              /*
               * NO `origin`, ON PURPOSE — THIS IS THE UNATTRIBUTED CASE (#433).
               *
               * `origin` is optional at the schema precisely so a frame without
               * it is DELIVERED UNATTRIBUTED rather than deleted: an error
               * channel that drops error reports tells the user nothing went
               * wrong. Absence is a PERMANENT supported state, not a
               * transitional one — the suite has to be able to model a backend
               * that does not set it, because that is the only way to exercise
               * the classifier's unattributed bucket, which the live-transport
               * classifier already treats as real and red rather than
               * defaulting it.
               *
               * This test's subject is generic copy and the detail reaching the
               * console, not attribution, so it is the right place to carry it.
               * The ATTRIBUTED case is shared-cards.spec.ts, which sets
               * `origin: "backend"`.
               *
               * If you are here because a guard demanded origin: do not add it.
               * Adding it deletes the repo's only e2e coverage of absence.
               */
              `data: {"type":"data-error","data":{"id":"e1","seq":0,"code":"upstream_unavailable","message":"Upstream model refused the request","retryable":false}}`,
              `data: {"type":"finish","finishReason":"stop"}`,
            ].join("\n\n") + "\n\n",
        })
    );

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    /*
     * THIS ASSERTION REVERSED IN #262, AND THE REASON IT ORIGINALLY HELD IS
     * STILL RESPECTED.
     *
     * It used to require the server's own message in the bubble, on the grounds
     * that a generic line "would be the page throwing away the only diagnostic
     * it had". That reasoning is right about not DESTROYING the diagnostic and
     * wrong about where it belongs — what actually reached a person was:
     *
     *   Upstream ended while an approval was still pending; releasing buffered frames
     *
     * a sentence about buffer management, in red, where they expect to be told
     * what went wrong with their request.
     *
     * So the diagnostic MOVES rather than vanishing: generic copy in the
     * bubble, full detail on the console. Both halves are asserted below,
     * because either alone re-creates one of the two defects.
     */
    const err = page.getByTestId("chat-error");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).not.toContainText("Upstream model refused the request");
    await expect(err).toContainText(/something went wrong/i);

    // ...and the detail is not lost. `upstream_unavailable` is deliberately a
    // code with no copy, so this also exercises the fail-closed default: an
    // unmapped code renders the generic line rather than the backend's words.
    expect(
      consoleErrors.some((l) =>
        l.includes("Upstream model refused the request")
      ),
      `the detail never reached the console; saw: ${JSON.stringify(
        consoleErrors
      )}`
    ).toBe(true);
  });
});

test.describe("open-swe /chat — the dead air is not silent (#231)", () => {
  /**
   * #231 asks for this control by name: "A test that fails if the row renders
   * while `status === 'idle'`. An indicator that is always on is not an
   * indicator." It is first for that reason.
   */
  async function hangingStream(page: import("@playwright/test").Page) {
    // Never respond, so the turn stays in `submitted` — the dead air itself,
    // which is the state this whole feature exists for. `route.fulfill` would
    // close the stream and skip straight past it.
    await page.route("**/api/chat/stream", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort().catch(() => {});
    });
  }

  test("CONTROL: nothing renders while idle", async ({ page }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await expect(page.getByTestId("processing-row")).toHaveCount(0);
  });

  test("it appears in the dead air — before any assistant text exists", async ({
    page,
  }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await hangingStream(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    const row = page.getByTestId("processing-row");
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The gap this closes: no assistant message exists yet, which is precisely
    // why the pre-existing caret — rendered inside an assistant bubble —
    // showed nothing here.
    await expect(row).toHaveAttribute("data-verb", "Thinking");
    await expect(row).toHaveAttribute("role", "status");
    await expect(row).toHaveAttribute("aria-live", "polite");
  });

  test("the token segment is ABSENT, not zeroed, while usage is unmeasured", async ({
    page,
  }) => {
    // Criterion 4. A zero meaning "not measured" is indistinguishable from a
    // zero meaning "measured, and it was zero".
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await hangingStream(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    const detail = page.getByTestId("processing-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(detail).not.toContainText("token");
    await expect(detail).not.toContainText("0 tokens");
    await expect(detail).toContainText(/\d+s/);
  });

  test("it is gone once the reply lands", async ({ page }) => {
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
          body:
            [
              `data: {"type":"start","messageId":"m1"}`,
              `data: {"type":"text-start","id":"t1"}`,
              `data: {"type":"text-delta","id":"t1","delta":"done"}`,
              `data: {"type":"text-end","id":"t1"}`,
              `data: {"type":"finish","finishReason":"stop"}`,
            ].join("\n\n") + "\n\n",
        })
    );

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    // Replaced by the reply, not stacked above it. Asserting the row is gone
    // once text has landed is asserting both halves at once.
    await expect(page.getByText("done")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("processing-row")).toHaveCount(0);
  });
});

test.describe("open-swe /chat — a reply can be stopped (#262)", () => {
  /**
   * THE CONTROL IS THE FIRST ASSERTION, and #262 asks for it by name: "a test
   * that fails if it renders while idle". A Stop button that is always present
   * would satisfy every positive assertion here and be worse than none — it
   * offers to cancel something that is not running.
   */
  async function stallingStream(page: import("@playwright/test").Page) {
    /*
     * NEVER RESPOND. The first version of this fulfilled a body with no
     * terminal frame, on the assumption that made the stream "unfinished" — it
     * does not: `route.fulfill` writes the body and CLOSES, so the reply
     * completed and the status went back to idle. One of the two tests using it
     * passed anyway, on timing, which is the worse outcome of the two.
     *
     * Holding the route open leaves the request genuinely in flight
     * (`submitted`), which is the state Stop exists for, and it is deterministic
     * rather than a race with the SDK's stream reader.
     */
    await page.route("**/api/chat/stream", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort().catch(() => {});
    });
  }

  test("CONTROL: no Stop control while idle", async ({ page }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    // Nothing sent, nothing in flight. If this is ever visible the control has
    // become decoration and every assertion below is worthless.
    await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  });

  test("Stop appears while a reply is in flight", async ({ page }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await stallingStream(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await expect(page.getByTestId("chat-stop")).toHaveCount(0);

    await page.getByTestId("chat-input").fill("write me something long");
    await page.getByTestId("chat-send").click();

    await expect(page.getByTestId("chat-stop")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("clicking Stop ends the in-flight state", async ({ page }) => {
    await mockTools(page);
    await mockConfig(page, { activeLlm: "nvidia" });
    await stallingStream(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill("write me something long");
    await page.getByTestId("chat-send").click();

    const stop = page.getByTestId("chat-stop");
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await stop.click();

    // Gone, because the status left submitted/streaming. Asserting the button
    // disappears is asserting the STATE changed — the button's visibility is
    // derived from it, so this cannot pass on a click handler that does nothing.
    await expect(stop).toHaveCount(0, { timeout: 15_000 });
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
    await page.unroute("**/api/config*");
    await mockConfig(page, { activeLlm: null });
    await page.reload();
    const llm = page.getByTestId("settings-llm");
    await expect(llm).toContainText(/No key configured/i);
    await expect(llm).toContainText(/runs will fail/i);
    await expect(llm).not.toContainText("checking");

    // 3. never answers — "checking…", and specifically NOT the configured
    // rendering. This is the settings-page twin of the chat `unknown` case.
    await page.unroute("**/api/config*");
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

test.describe("open-swe /settings — the form is not typeable before it is seeded", () => {
  test("no painted frame has the prompt field interactive while still un-seeded", async ({
    page,
  }) => {
    // WHY A FRAME COUNTER AND NOT A `fill()`.
    //
    // The window is ONE RENDER wide. `loaded` flips inside the hook's effect,
    // React paints with the inputs now ENABLED and `draft` still
    // DEFAULT_SETTINGS, and only then does the seeding effect run. Anything
    // typed into that frame is discarded by the seed that lands next, and the
    // visible symptom is that Save never enables — `dirty` compares draft to
    // settings, and the seed has just made them equal again.
    //
    // A test that types into it would be a coin flip against one frame. So this
    // asserts the INVARIANT instead: the field must never be interactive while
    // showing something other than what storage holds. Measured against the
    // unfixed page this reports exactly one such frame; against the fixed page,
    // zero.
    //
    // This is the deterministic form of a failure that had been showing up in
    // CI as an intermittent "settings-save is not enabled" timeout.
    const STORED = "seeded-from-storage";

    await page.addInitScript(
      ([key, stored]) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({ systemPrompt: stored, folders: [] })
        );
        (window as unknown as { __frames: unknown[] }).__frames = [];
        const tick = () => {
          const el = document.querySelector(
            '[data-testid="settings-system-prompt"]'
          ) as HTMLTextAreaElement | null;
          if (el)
            (
              window as unknown as {
                __frames: { disabled: boolean; value: string }[];
              }
            ).__frames.push({ disabled: el.disabled, value: el.value });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      [SETTINGS_KEY, STORED] as const
    );

    await mockConfig(page, { activeLlm: "nvidia" });
    await mockSandboxHealth(page, { available: true, provider: "docker" });

    await page.goto("/settings");
    await expect(page.getByTestId("settings-system-prompt")).toBeEnabled();
    // Let the seeding effect and a few more frames land, so a LATE seed would
    // still be caught rather than simply not sampled yet.
    await page.waitForTimeout(1000);

    const frames = await page.evaluate(
      () =>
        (
          window as unknown as {
            __frames: { disabled: boolean; value: string }[];
          }
        ).__frames
    );

    // Guard against a vacuous pass: if the sampler never saw an enabled frame,
    // "zero violations" would mean the probe missed the page, not that the page
    // is correct.
    const enabled = frames.filter((f) => !f.disabled);
    expect(
      enabled.length,
      "sampler never observed an enabled field — it measured nothing"
    ).toBeGreaterThan(0);

    const unseeded = enabled.filter((f) => f.value !== STORED);
    expect(
      unseeded.length,
      `the prompt field was interactive but un-seeded in ${unseeded.length} painted frame(s); ` +
        `anything typed there is discarded by the seed that follows`
    ).toBe(0);
  });
});

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
    // #360 — `node` is optional so the existing cases read unchanged, and
    // defaults to FALSE rather than true: a fixture that silently marks a
    // runtime available would make "unconfigured runtimes are disabled" pass
    // for the wrong reason in every case that does not mention it.
    backends: { django: boolean; fastapi: boolean; node?: boolean }
  ) {
    await page.route(
      "**/api/config*",
      (route) =>
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            activeLlm: "nvidia",
            backends: { node: false, ...backends },
          }),
        })
    );
  }

  test("the select reports the chosen runtime, and choosing moves it", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true });

    await page.goto("/chat");

    /*
     * #158 — this read aria-pressed on two buttons. A native <select> carries
     * the same fact in the place assistive technology actually reads it, so the
     * assertion and the accessibility contract are still one thing rather than
     * two that can drift.
     *
     * Both directions are still asserted per-option rather than only through
     * the select's value: `toHaveValue` alone would pass on a control that
     * marked every option selected.
     */
    const select = page.getByTestId("runtime-select");
    await expect(select).toHaveValue("fastapi");
    await expect(page.getByTestId("runtime-fastapi")).toHaveJSProperty(
      "selected",
      true
    );
    await expect(page.getByTestId("runtime-django")).toHaveJSProperty(
      "selected",
      false
    );

    await select.selectOption("django");

    await expect(select).toHaveValue("django");
    await expect(page.getByTestId("runtime-django")).toHaveJSProperty(
      "selected",
      true
    );
    await expect(page.getByTestId("runtime-fastapi")).toHaveJSProperty(
      "selected",
      false
    );
  });

  test("an unconfigured runtime is LISTED and disabled, and cannot be selected", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: false, fastapi: true });

    await page.goto("/chat");

    // PRESENT is half the assertion and the half a dropdown conversion is most
    // likely to lose: a <select> built from "available options" drops the row
    // entirely, which looks tidy and deletes the remedy with it.
    const django = page.getByTestId("runtime-django");
    await expect(django).toBeAttached();
    await expect(django).toBeDisabled();

    // The real failure mode is a control that looks selectable and then 502s on
    // send, so assert the selection genuinely does not take.
    await page
      .getByTestId("runtime-select")
      .selectOption("django", { timeout: 2000 })
      .catch(() => {});
    await expect(page.getByTestId("runtime-select")).toHaveValue("fastapi");
  });

  test("a disabled runtime names the env var that would enable it", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: false, fastapi: true });

    await page.goto("/chat");

    // Disabled-not-hidden is deliberate: an unconfigured runtime is one
    // .env.local line away, so hiding it would hide the remedy. A label that
    // stopped naming the variable would remove the remedy while still looking
    // correct, which nothing else would catch.
    //
    // #158 moved the remedy into the option's TEXT and kept the title. The text
    // is asserted first because it is the half a screen reader and a touch user
    // receive; `title` reaches a pointer only.
    const django = page.getByTestId("runtime-django");
    await expect(django).toHaveText(/DJANGO_URL/);
    await expect(django).toHaveAttribute("title", /DJANGO_URL/);
  });

  /*
   * #360 — THE ACCEPTANCE CRITERION, WHICH THREE RUNG ISSUES SHARED AND NONE
   * COULD SATISFY: "the capability panel reflects reality for BOTH language
   * planes."
   *
   * It went unnoticed through two rung closures because the grid was UNIFORM:
   * every rung served the same topologies on every runtime, so the claim read
   * as true by symmetry rather than because anything computed it. Measured on
   * main before this change — a `topologiesFor` that discards its runtime
   * argument entirely passed all 927 unit tests.
   *
   * These therefore assert on the cell that is NOT symmetric.
   */
  test("the TypeScript runtime is offered, and disabled when unconfigured", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true, node: false });
    await page.goto("/");

    // PRESENT, not hidden — an unconfigured runtime is one .env.local line
    // away, so hiding it would hide the remedy. Same rule as django's.
    const node = page.getByTestId("runtime-node");
    await expect(node).toBeAttached();
    await expect(node).toBeDisabled();
    await expect(node).toHaveText(/NODE_URL/);
  });

  test("and is SELECTABLE once configured — the presence companion", async ({
    page,
  }) => {
    // Without this, "node is disabled" is satisfied by a build where node is
    // permanently unusable, which is the state this issue exists to end.
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true, node: true });
    await page.goto("/");

    await expect(page.getByTestId("runtime-node")).not.toBeDisabled();
    await page.getByTestId("runtime-select").selectOption("node");
    await expect(page.getByTestId("runtime-select")).toHaveValue("node");
  });

  test("deep-research is offered on Python and NOT on node — the asymmetry, on screen", async ({
    page,
  }) => {
    /*
     * THE PAIR IS THE TEST. Either half alone passes against a Mode list that
     * ignores the runtime entirely; only the difference between them does not.
     *
     * If #354 gives node a web-search tool, THIS FIXTURE'S PREMISE EXPIRES —
     * the two halves become equal and this stops discriminating while still
     * passing. Whoever closes #354 needs another non-uniform cell first.
     */
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true, node: true });
    await page.goto("/?framework=deepagents");

    await expect(page.getByTestId("topology-deep-research")).toBeAttached();

    await page.getByTestId("runtime-select").selectOption("node");
    await expect(page.getByTestId("topology-deep-research")).toHaveCount(0);

    // And back, so the absence is caused by the runtime rather than by the
    // option having been destroyed on first switch.
    await page.getByTestId("runtime-select").selectOption("fastapi");
    await expect(page.getByTestId("topology-deep-research")).toBeAttached();
  });

  test("the mode list follows the runtime — deepagents serves deep-research on both", async ({
    page,
  }) => {
    await mockTools(page);
    await configWith(page, { django: true, fastapi: true });

    await page.goto("/chat");
    await page.getByTestId("framework-select").selectOption("deepagents");

    // LITERAL, not derived — see the note above this describe block.
    // `toBeAttached`, not `toBeVisible`: an <option> inside a closed native
    // select is present in the tree and not painted, and presence is the
    // property this rule is about.
    await expect(page.getByTestId("topology-deep-research")).toBeAttached();
    await page.getByTestId("runtime-select").selectOption("django");
    await expect(page.getByTestId("topology-deep-research")).toBeAttached();

    // And the negative half, which is what stops a derivation that returned
    // everything everywhere from passing: langchain serves no deep-research on
    // either runtime. ABSENT, not disabled — count 0 is the assertion that
    // separates the mode rule from the runtime rule above.
    await page.getByTestId("framework-select").selectOption("langchain");
    await expect(page.getByTestId("topology-deep-research")).toHaveCount(0);
    await page.getByTestId("runtime-select").selectOption("fastapi");
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
    page.route(
      "**/api/open-swe/dependencies**",
      (route) =>
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
    await serveDeps(
      page,
      200,
      JSON.stringify({ dependencies: [], probedAt: "2026-08-26T12:00:00Z" })
    );
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
          {
            id: "agent-backend",
            label: "Agent backend",
            state: "responding",
            latencyMs: 12,
          },
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
    await serveDeps(
      page,
      200,
      JSON.stringify({ probedAt: "2026-08-26T12:00:00Z" })
    );
    await page.goto("/settings");

    await expect(page.getByTestId("deps-error")).toBeVisible();
    await expect(page.getByTestId("deps-empty")).toHaveCount(0);
  });
});

/**
 * INFERENCE IS VERIFIED WITHOUT BEING ASKED — AND THE VERIFICATION IS REAL.
 *
 * Requested directly: "i want it to consume that call ... dont want to have to
 * click on Verify inference (costs a call)".
 *
 * Two things had to change together, and the second is why this file gets
 * cases rather than just a flipped boolean. The button warned that verifying
 * cost an inference call, and then fetched the BACKEND'S /health — which
 * reports {"configured": true, "provider": "nvidia"}, i.e. whether a KEY IS
 * PRESENT — and rendered that as `responding`. It cost nothing and could not
 * fail for the reason it named. Auto-running it would have made the panel
 * assert model health on every page load while never asking the model
 * anything.
 *
 * A key can be present while the model is dead: NVIDIA retired a model
 * mid-session and every stream returned 410 with the key still perfectly
 * configured. These cases drive that exact shape.
 */
test.describe("open-swe /settings — inference verifies on load, for real", () => {
  const serveDeps = (page: Page, dependencies: unknown[]) =>
    page.route(
      "**/api/open-swe/dependencies**",
      (route) =>
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            probedAt: "2026-08-26T12:00:00Z",
            dependencies,
          }),
        })
    );

  test("the page asks for verification itself — no click required", async ({
    page,
  }) => {
    // THE ASK, PINNED AT THE REQUEST LEVEL. Asserting the rendered row would
    // not catch a regression to `loadDeps(false)`, because a mock can return a
    // verified row regardless of what was requested. What matters is that the
    // page ASKED.
    const asked: string[] = [];
    await page.route("**/api/open-swe/dependencies**", (route) => {
      asked.push(new URL(route.request().url()).search);
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dependencies: [] }),
      });
    });

    await page.goto("/settings");
    await expect(page.getByTestId("deps-list")).toBeVisible();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked.some((s) => s.includes("verify=llm"))).toBe(true);
  });

  test("a model that ANSWERED is reported as responding, quoting what it said", async ({
    page,
  }) => {
    await serveDeps(page, [
      {
        id: "inference",
        label: "Inference",
        state: "responding",
        detail: 'nvidia — the model answered "ok"',
        latencyMs: 1175,
        probedAt: "2026-08-26T12:00:00Z",
      },
    ]);
    await page.goto("/settings");

    const row = page.getByTestId("dep-inference");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-state", "responding");
    // The quoted answer is what distinguishes this from a key check. A row that
    // said only "backend reachable" is the bug this replaces.
    await expect(row).toContainText("the model answered");
  });

  test("A CONFIGURED KEY WITH A DEAD MODEL IS NOT 'responding'", async ({
    page,
  }) => {
    // The case the old check got wrong, and the reason it mattered. The key is
    // fine; the model is retired. Anything other than a failure state here
    // means the panel is reporting configuration as health again.
    await serveDeps(page, [
      {
        id: "inference",
        label: "Inference",
        state: "unreachable",
        detail: "nvidia — 410 model has been retired",
        probedAt: "2026-08-26T12:00:00Z",
      },
    ]);
    await page.goto("/settings");

    const row = page.getByTestId("dep-inference");
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute("data-state", "responding");
    // And it must carry the reason, so the person knows to change the model
    // rather than to check their key.
    await expect(row).toContainText("410");
  });

  test("the button is a RE-check, and it actually forces a fresh call", async ({
    page,
  }) => {
    // It still exists — someone who distrusts a cached verdict can force a new
    // one — but its label must no longer imply clicking is required for the row
    // to mean anything.
    //
    // AND IT MUST CARRY refresh=1. The verdict is cached for five minutes, so a
    // button labelled "spends a call" that omitted this would spend nothing and
    // hand back the answer already on screen — the same defect this whole
    // change removes, rebuilt one layer up. Asserted on the REQUEST, because
    // the rendered row looks identical either way.
    const asked: string[] = [];
    await page.route("**/api/open-swe/dependencies**", (route) => {
      asked.push(new URL(route.request().url()).search);
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dependencies: [] }),
      });
    });
    await page.goto("/settings");
    await expect(page.getByTestId("deps-list")).toBeVisible();

    const btn = page.getByTestId("deps-verify-llm");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/re-verify/i);

    // The load already happened and must NOT have forced a refresh — otherwise
    // every page view spends a call and the cache is decorative.
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked.every((s) => !s.includes("refresh=1"))).toBe(true);

    const before = asked.length;
    await btn.click();
    await expect.poll(() => asked.length).toBeGreaterThan(before);
    expect(asked[asked.length - 1]).toContain("refresh=1");
    expect(asked[asked.length - 1]).toContain("verify=llm");
  });
});
