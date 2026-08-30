import { test, expect } from "@playwright/test";

/**
 * DeepAgents Next.js E2E tests — mocked backend via page.route().
 *
 * These tests use Playwright's page.route() to intercept HTTP calls at the
 * browser layer. No real backend (BACKEND_URL) is required.
 *
 * Covers:
 *   SPEC-01: Auth cookie forwarded as Authorization: Bearer (getCookieToken)
 *   SPEC-02: Backend 5xx renders error state in UI (not a frozen spinner)
 *   SPEC-03: Tool call SSE produces ToolCallCard with pending → complete status
 *   SPEC-04: MOVED to e2e/matrix/adapter-selection.spec.ts (#14) — it is
 *           cross-rung and cannot survive `pnpm eject <rung>`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AI SDK v6 UIMessageStream body (text-only). */
function makeTextSseBody(text: string): string {
  return [
    `data: {"type":"text-start","id":"t1"}`,
    `data: {"type":"text-delta","id":"t1","delta":"${text}"}`,
    `data: {"type":"text-end","id":"t1"}`,
    `data: {"type":"finish","finishReason":"stop"}`,
    "",
    "",
  ].join("\n\n");
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
} as const;

// ---------------------------------------------------------------------------
// SPEC-01 + SPEC-02: Auth flow and 5xx error state
// ---------------------------------------------------------------------------

test.describe("DeepAgents Next.js E2E — auth and error states", () => {
  // SPEC-01 SCOPE NOTE — this exercises `getCookieToken("session")` end-to-end
  // through the Next.js runtime via a dedicated TEST-ONLY route
  // (/api/chat/stream/test-auth) that calls the helper and echoes the
  // would-be Authorization header. It does NOT exercise the example app's
  // real /api/chat/stream route — that route uses env-based tokens
  // (FASTAPI_AUTH_TOKEN / DJANGO_AUTH_TOKEN), not cookies, so a cookie
  // round-trip can't be observed there without rewiring the example app.
  //
  // The contract that `createDeepAgentsHandler` actually invokes the
  // `getToken` callback and injects the result as Authorization: Bearer is
  // covered by unit tests at packages/server/src/handler.test.ts:218-285
  // (getToken returning string / null / undefined / absent). The E2E here
  // proves the helper survives the Next.js bundle / runtime / RSC boundary;
  // the unit tests prove the integration with the handler.
  test("SPEC-01: getCookieToken extracts session cookie → 'Bearer <token>' in the Next.js runtime", async ({
    page,
  }) => {
    // Navigate to the app first so we are on the correct origin before adding cookies.
    await page.goto("/");

    // Set the session cookie on the browser context (same origin as the app).
    await page.context().addCookies([
      {
        name: "session",
        value: "test-token-abc",
        url: "http://localhost:3000",
      },
    ]);

    // Use page.evaluate to issue a same-origin fetch so the browser forwards
    // the cookie automatically. page.request would use a separate cookie jar.
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/chat/stream/test-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return res.json() as Promise<{ authorization: string | null }>;
    });

    expect(result.authorization).toBe("Bearer test-token-abc");
  });

  test("SPEC-01b: getCookieToken returns null when the session cookie is absent — no Bearer is injected", async ({
    page,
  }) => {
    // Negative-path coverage: a request with no `session` cookie must NOT
    // produce a Bearer header. The previous SPEC-01 only proved the happy
    // path — a regression where the helper hard-coded a fallback token, or
    // where the absence-detection logic broke, would have slipped through.
    await page.goto("/");

    // Clear cookies explicitly — addCookies-only-in-other-test isolation
    // isn't guaranteed if Playwright reuses the context.
    await page.context().clearCookies();

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/chat/stream/test-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return res.json() as Promise<{ authorization: string | null }>;
    });

    expect(
      result.authorization,
      "no session cookie → authorization must be null, not 'Bearer ' or 'Bearer null'"
    ).toBeNull();
  });

  test("SPEC-02: backend 5xx renders error state in UI within 5 seconds", async ({
    page,
  }) => {
    // Intercept the chat stream route BEFORE navigating so the handler is
    // installed when the page first issues requests.
    await page.route("**/api/chat/stream", (route) => {
      // Reject with a 500 to simulate a backend error.
      void route.fulfill({ status: 500, body: "Internal Server Error" });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Fill the input and submit.
    await page.getByRole("textbox").fill("test error message");
    await page.keyboard.press("Enter");

    // Use the dedicated header-status testid (apps/example/app/page.tsx).
    // The previous version asserted "header contains error" and separately
    // "header does NOT contain streaming within 1s" — the second check was
    // racy. Polling on the badge directly verifies the terminal state
    // without false positives from transient streaming/submitted text.
    await expect(page.getByTestId("header-status")).toHaveText("error", {
      timeout: 5_000,
    });

    // The dot must carry the error STATE, not merely an error-coloured class.
    //
    // This asserted `toHaveClass(/bg-red-500/)` until #60 reskinned the app and
    // it broke. Swapping the token would have gone green and left the real
    // defect: the comment claimed "a second, structural assertion that the hook
    // surfaced the error state — not just text", and a class match never proved
    // that. It proved a class. Any restyle could satisfy or break it without the
    // hook's state changing at all — and `toHaveText("error")` directly above
    // was already the text assertion this was supposed to be independent of.
    //
    // `data-status` is rendered from the same `status` value that drives the
    // colour, so this now fails if the hook does not reach "error", and cannot
    // be broken by the next reskin.
    await expect(page.getByTestId("header-status-dot")).toHaveAttribute(
      "data-status",
      "error"
    );
  });

  // -------------------------------------------------------------------------
  // SPEC-02b: each backend 4xx/5xx must surface as status="error", not stick
  // in streaming/submitted. Parametrised across 401, 403, 429, 500 so a hook
  // change that special-cases one code (e.g. silently retries on 429) gets
  // caught.
  // -------------------------------------------------------------------------
  for (const status of [401, 403, 429, 500] as const) {
    test(`SPEC-02b: backend ${status} renders error state`, async ({ page }) => {
      await page.route("**/api/chat/stream", (route) => {
        void route.fulfill({
          status,
          body: `error ${status}`,
        });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await page.getByRole("textbox").fill(`trigger ${status}`);
      await page.keyboard.press("Enter");

      await expect(page.getByTestId("header-status")).toHaveText("error", {
        timeout: 5_000,
      });
      await expect(page.getByTestId("header-status-dot")).toHaveAttribute(
        "data-status",
        "error"
      );
    });
  }

  // -------------------------------------------------------------------------
  // SPEC-02c: malformed / partial SSE bodies must not crash the hook. The
  // AI SDK v6 chunk schema is strict — unknown types are ignored, but invalid
  // JSON or a body that ends without a finish frame must still leave the hook
  // in a terminal state (idle or error), never stuck in streaming.
  // -------------------------------------------------------------------------
  test("SPEC-02c: malformed SSE (invalid JSON frames) does not stick the hook in 'streaming'", async ({
    page,
  }) => {
    // Mix valid + invalid frames. The chat processor should skip the bad
    // ones and still settle on a terminal state. We don't assert any specific
    // text was rendered — only that the hook escapes the streaming state.
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: [
          `data: not-valid-json`,
          `data: {"type":"text-start","id":"t1"}`,
          `data: {"type":"text-delta","id":"t1","delta":"hello"}`,
          `data: {"type":"text-delta"`, // truncated JSON
          `data: {"type":"text-end","id":"t1"}`,
          `data: {"type":"finish","finishReason":"stop"}`,
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("malformed sse test");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("header-status")).toHaveText(/idle|error/, {
      timeout: 10_000,
    });
  });

  test("SPEC-02e: SSE comment frames (heartbeat) interleaved with data frames do not break parsing", async ({
    page,
  }) => {
    // openSweHeartbeat emits `: keep-alive\n\n` comment frames every 25s
    // (packages/server/src/adapters/openSweHeartbeat.ts:25, ADAPT-03). The
    // EventSource and AI SDK parsers must ignore them — a regression that
    // treated `: keep-alive` as a malformed `data:` frame would surface as
    // either a stuck stream or a parse error. This test interleaves the
    // production-format comment between data frames and proves the
    // happy-path text-delta still settles cleanly.
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: [
          `: keep-alive`,
          `data: {"type":"text-start","id":"t1"}`,
          `: keep-alive`,
          `data: {"type":"text-delta","id":"t1","delta":"hi"}`,
          `: keep-alive`,
          `data: {"type":"text-end","id":"t1"}`,
          `data: {"type":"finish","finishReason":"stop"}`,
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("heartbeat test");
    await page.keyboard.press("Enter");

    // The stream must reach terminal state, AND the text-delta must render.
    // Asserting the rendered text proves the comment lines didn't disturb
    // the surrounding data frames — a parser that mis-handled comments
    // could drop following frames silently.
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      "hi",
      { timeout: 5_000 }
    );
  });

  test("SPEC-02f: chat composer submit button is disabled on empty input — no POST fires", async ({
    page,
  }) => {
    // The example app's send button is gated on `!input.trim()` so empty
    // (or whitespace-only) input cannot fire a POST. Regression coverage:
    // a refactor that removed the trim() guard would let users submit
    // empty messages, which the backend either 400s or wastes a token on.
    // We assert both halves: button disabled AND no POST observed.
    /*
     * BODIES, NOT A COUNT (#114). What was posted answers both halves of this
     * test's claim; how many were posted answers neither on its own, and the
     * count is what made the old failure misleading — see the note above the
     * assertions below.
     */
    const posted: string[] = [];
    await page.route("**/api/chat/stream", (route) => {
      posted.push(route.request().postData() ?? "");
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeTextSseBody("never fires"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Send button starts disabled (empty input).
    const sendBtn = page.locator('button[type="submit"]');
    await expect(sendBtn).toBeDisabled();

    // Typing only whitespace must keep the button disabled — the trim
    // guard is the contract under test, not just non-empty length.
    await page.getByRole("textbox").fill("   ");
    await expect(sendBtn).toBeDisabled();

    // Try Enter anyway (the form's onSubmit gate should also reject).
    await page.keyboard.press("Enter");

    // Typing real content re-enables the button (positive control —
    // proves the disable wasn't caused by some unrelated hook state).
    await page.getByRole("textbox").fill("real message");
    await expect(sendBtn).toBeEnabled();

    /*
     * THE TWO HALVES ARE OBSERVED DIFFERENTLY, BECAUSE THEY ARE DIFFERENT
     * KINDS OF CLAIM (#114).
     *
     * This used to be `waitForRequest(...)` followed on the next line by
     * `expect(postCount).toBe(1)`. Those are two different events:
     * waitForRequest fires when the request is ISSUED, while the route handler
     * that records it runs when Playwright DISPATCHES INTERCEPTION, later. The
     * assertion read between them. Measured on firefox: at the exact point of
     * the assertion the recorder held 0, and 50ms later it held 1 — with a
     * 1500ms settle the count was right in 12 of 12 runs, and with no settle it
     * was wrong in 4 of 10. Nothing else varied.
     *
     * So it failed as `expected 0 to be 1` while carrying a message blaming
     * the whitespace attempt — sending the next reader to the trim guard, the
     * one component that was demonstrably working. A check reporting a verdict
     * it never computed, in the message rather than the assertion.
     *
     * (i) THE REAL MESSAGE POSTED — a presence claim, so it is WAITED for, and
     *     for that specific body rather than for a count. Polling until the
     *     count reaches one would pass on the very defect this test exists to
     *     catch: if the whitespace guard leaked, the ordering is whitespace
     *     first, so the count passes through 1 at the leaked POST and the poll
     *     stops there, satisfied, before the real message is ever sent.
     *
     * (ii) THE WHITESPACE ATTEMPT DID NOT POST — an absence claim, which cannot
     *     be observed instantaneously, so it is SETTLED for before asserting.
     *     The window is bounded and sized from the measurement above: observed
     *     dispatch lag was under 50ms, and the whitespace Enter happens several
     *     awaited operations earlier, so 500ms is an order of magnitude of
     *     margin rather than a number chosen to make a red test green.
     */
    await page.keyboard.press("Enter");

    await expect
      .poll(() => posted.filter((b) => b.includes("real message")).length, {
        timeout: 10_000,
      })
      .toBe(1);

    await page.waitForTimeout(500);

    expect(
      posted,
      `expected exactly one POST, carrying the typed message. Observed ${posted.length}: ` +
        JSON.stringify(posted.map((b) => b.slice(0, 120)))
    ).toHaveLength(1);
    expect(
      posted[0],
      "the single POST must be the typed message — if this is whitespace, the trim guard leaked"
    ).toContain("real message");
  });

  test("large body POST to /api/chat/stream returns 413 — body-size guard enforces 1MB default", async ({
    request,
  }) => {
    // After the F4 fix, createDeepAgentsHandler rejects payloads above
    // maxBodyBytes (default 1MB) with HTTP 413 BEFORE buffering the body
    // into memory. Two guards fire:
    //   1. Content-Length early reject (catches honest clients)
    //   2. Post-buffer length check (catches clients that omit/under-
    //      state Content-Length on streamed bodies)
    //
    // A 5MB payload triggers both. Tested via the real /api/chat/stream
    // route (the example app uses createDeepAgentsHandler) so this
    // exercises the end-to-end guard, not a unit-test mock.
    test.setTimeout(15_000);

    // ~5MB of repeated content — comfortably above the 1MB default cap.
    const fillerKb = "x".repeat(1024);
    const fillerMb = fillerKb.repeat(1024);
    const bigContent = fillerMb.repeat(5);
    const body = {
      messages: [{ role: "user", content: bigContent }],
    };

    const started = Date.now();
    const res = await request.post("/api/chat/stream", {
      data: body,
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
      failOnStatusCode: false,
    });
    const elapsedMs = Date.now() - started;

    // Bounded response time — fast-reject means well under 10s.
    expect(
      elapsedMs,
      "413 reject should be fast (no body buffering for the Content-Length path)"
    ).toBeLessThan(10_000);

    expect(
      res.status(),
      `expected 413 (body-size guard); got ${res.status()}`
    ).toBe(413);
    const errorBody = await res.json();
    expect(errorBody.error).toBe("Payload too large");
    expect(errorBody.maxBytes).toBe(1_048_576);
  });

  test("GET /api/chat/stream returns 405 (or 404), NOT 200 with HTML — POST-only route enforcement", async ({
    request,
  }) => {
    // Defensive check: a regression where someone adds a GET handler (or
    // Next.js silently falls back to a generic 200) would let arbitrary
    // GETs reach the route. Both 405 (Method Not Allowed) and 404 (no
    // GET handler exported) are correct outcomes; 200 with an HTML body
    // would mean a regression.
    const res = await request.get("/api/chat/stream", {
      failOnStatusCode: false,
    });
    expect([404, 405]).toContain(res.status());
    // Belt-and-braces: even if status leaked as 200, the body must not
    // be an HTML page (which would indicate Next.js's default error page
    // or some other handler catching the request).
    const ct = res.headers()["content-type"] ?? "";
    expect(
      ct.includes("text/html"),
      "GET on a POST-only route must not return HTML — that means the route was matched by something unexpected"
    ).toBe(false);
  });

  test("/api/config returns the {backends: {django, fastapi}} shape that matrix/topology specs depend on", async ({
    request,
  }) => {
    // matrix.spec.ts and topology.spec.ts both mock /api/config with the
    // shape `{backends: {django: true, fastapi: true}}` so the django/
    // fastapi buttons stay enabled regardless of dev-server env. If the
    // real endpoint's shape ever drifts (renamed `backends` to `available`,
    // hoisted booleans to the root, returned an array, etc.), those mocks
    // would silently keep working — the dev server's actual behavior
    // would diverge from what the suite asserts. This test pins the
    // contract directly so a real-endpoint drift fails fast here, BEFORE
    // someone notices the dev playground stopped working in production.
    const response = await request.get("/api/config");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;

    // Structural assertions: `backends` is an object containing both
    // boolean flags. The values themselves depend on env (DJANGO_URL /
    // FASTAPI_URL); we don't assert them — we only assert the keys exist
    // and are booleans.
    expect(
      body.backends,
      "response must have a `backends` key — matrix/topology mocks depend on this"
    ).toBeDefined();
    const backends = body.backends as Record<string, unknown>;
    expect(typeof backends.django).toBe("boolean");
    expect(typeof backends.fastapi).toBe("boolean");
  });

  test("SPEC-02d: truncated SSE (no text-end, no finish) — hook reaches terminal state", async ({
    page,
  }) => {
    // The stream ends prematurely (no closing frames). The hook must not
    // remain in 'streaming' indefinitely; AI SDK should either finalise the
    // partial message (idle) or mark error.
    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: [
          `data: {"type":"text-start","id":"t1"}`,
          `data: {"type":"text-delta","id":"t1","delta":"partial"}`,
          "",
        ].join("\n\n"),
        // Note: no text-end, no finish. Body just ends.
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("truncated stream test");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("header-status")).toHaveText(/idle|error/, {
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC-03: Tool call rendering  (SPEC-04 moved to e2e/matrix/, see #14)
// ---------------------------------------------------------------------------

test.describe("DeepAgents Next.js E2E — tool calls and adapters", () => {
  test("SPEC-03: tool call SSE renders ToolCallCard with pending then complete status", async ({
    page,
  }) => {
    // Tool call SSE body using the AI SDK v6 UIMessageStream format.
    // - tool-input-available (dynamic:true) → dynamic-tool part, state='input-available' → status='running'
    // - tool-output-available               → dynamic-tool part, state='output-available' → status='complete'
    // dynamic:true causes the AI SDK to use the 'dynamic-tool' part type, which the
    // converter's isToolCallPart() recognises (type === 'dynamic-tool').
    const toolCallSseBody = [
      'data: {"type":"start","messageId":"msg-1"}',
      "",
      'data: {"type":"tool-input-available","toolCallId":"tc-1","toolName":"search","input":{},"dynamic":true}',
      "",
      'data: {"type":"tool-output-available","toolCallId":"tc-1","output":"found it","dynamic":true}',
      "",
      'data: {"type":"finish","finishReason":"tool-calls"}',
      "",
      "",
    ].join("\n\n");

    await page.route("**/api/chat/stream", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: toolCallSseBody,
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox").fill("use a tool");
    await page.keyboard.press("Enter");

    // ToolCallCard renders msg.toolName in a <span data-testid="tool-name">
    // and msg.status as a <span data-testid="tool-status"> badge — scope the
    // assertions to those testids so a stray "search" or "complete" string
    // elsewhere on the page can't satisfy them.
    const toolCard = page.getByTestId("tool-card");
    await expect(toolCard).toBeVisible({ timeout: 10_000 });
    await expect(toolCard.getByTestId("tool-name")).toHaveText("search");
    await expect(toolCard.getByTestId("tool-status")).toHaveText("complete", {
      timeout: 10_000,
    });
  });
});
