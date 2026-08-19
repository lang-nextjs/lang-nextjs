import { test, expect } from "@playwright/test";

// Tests run against http://localhost:3000 (chromium project, default baseURL).
// Start the Next.js dev server before running: pnpm --filter example dev

test.describe("DeepAgents Next.js extra scenarios", () => {
  test("E2E-07: two successive sends (sequential, gated on idle) — both responses render in order", async ({
    page,
  }) => {
    // NAME ACCURACY: this test waits for header-status="idle" between sends,
    // so the two requests are strictly sequential, not "rapid". A true rapid-
    // sends test (overlapping in-flight) would need either a backpressure-
    // friendly input or driving sendMessage directly to bypass the
    // status-gated send button.
    let callCount = 0;
    await page.route("**/api/chat/stream", async (route) => {
      callCount++;
      const msgNum = callCount;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body: [
          `data: {"type":"text-start","id":"t${msgNum}"}`,
          `data: {"type":"text-delta","id":"t${msgNum}","delta":"Response ${msgNum}"}`,
          `data: {"type":"text-end","id":"t${msgNum}"}`,
          `data: {"type":"finish","finishReason":"stop"}`,
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // First message
    await page.getByRole("textbox").fill("Message 1");
    await page.keyboard.press("Enter");
    // Wait for first response to complete (status back to idle)
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });

    // Second message after first completes
    await page.getByRole("textbox").fill("Message 2");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 10_000,
    });

    // Assert both responses appear and in order
    const assistantMessages = page.locator('[data-role="assistant"]');
    await expect(assistantMessages).toHaveCount(2, { timeout: 10_000 });
    await expect(assistantMessages.nth(0)).toContainText("Response 1");
    await expect(assistantMessages.nth(1)).toContainText("Response 2");
    expect(callCount).toBe(2);
  });

  test("E2E-08: custom data-plan schema renders PlanCard in UI", async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"type":"text-start","id":"t1"}',
          'data: {"type":"text-delta","id":"t1","delta":"Here is your plan:"}',
          'data: {"type":"text-end","id":"t1"}',
          'data: {"type":"data-plan","data":{"id":"p1","seq":1,"title":"Test Plan","markdown":"## Test Plan","subtasks":[{"id":"s1","label":"step1","status":"pending"},{"id":"s2","label":"step2","status":"pending"}],"updatedAt":"2026-05-04T00:00:00Z"}}',
          'data: {"type":"finish","finishReason":"stop"}',
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox").fill("create a plan");
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-testid="plan-card"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="plan-card"]')).toContainText(
      "Test Plan"
    );
    await expect(page.locator('[data-testid="plan-card"]')).toContainText(
      "step1"
    );
  });

  test("E2E-10: large response (23 chunks, ≥1000 chars) accumulates fully in DOM", async ({
    page,
  }) => {
    const CHUNK_TEXT = "The quick brown fox jumps over the lazy dog. "; // 45 chars
    const CHUNKS = 23; // 23 * 45 = 1035 chars total (>= 1000)

    await page.route("**/api/chat/stream", async (route) => {
      const deltaFrames = Array.from(
        { length: CHUNKS },
        (_, i) =>
          `data: {"type":"text-delta","id":"t1","delta":"${CHUNK_TEXT}"}`
      );
      const body = [
        'data: {"type":"text-start","id":"t1"}',
        ...deltaFrames,
        'data: {"type":"text-end","id":"t1"}',
        'data: {"type":"finish","finishReason":"stop"}',
        "",
      ].join("\n\n");
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body,
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox").fill("tell me a long story");
    await page.keyboard.press("Enter");

    // Wait for response to complete (status back to idle)
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 15_000,
    });

    // Assert assistant message contains the full accumulated text
    const assistantMsg = page.locator('[data-role="assistant"]').first();
    await expect(assistantMsg).toBeVisible({ timeout: 15_000 });

    // Verify no truncation: full repeated text should be present
    const text = await assistantMsg.textContent();
    expect(text?.length ?? 0).toBeGreaterThanOrEqual(1000);
    // Count occurrences of "quick brown fox" — the mock emits CHUNKS=23
    // identical deltas, so the substring should appear 23 times in the
    // assembled DOM text. The previous `toContain("quick brown fox")`
    // would have passed even if only ONE chunk reached the DOM (and the
    // other 22 were dropped/coalesced). Asserting the count proves
    // accumulation, not just delivery of *any* chunk.
    const occurrences = text?.match(/quick brown fox/g)?.length ?? 0;
    expect(
      occurrences,
      `mock emitted ${CHUNKS} 'quick brown fox' chunks — the assembled DOM text must contain all of them; an accumulator regression that coalesced or dropped chunks would fail this`
    ).toBe(CHUNKS);
  });

  test("E2E-11: two useDeepAgentsChat instances in the same React tree maintain independent message state", async ({
    page,
  }) => {
    // Mount the concurrent-test page (apps/example/app/concurrent-test/page.tsx)
    // which renders two ChatPanes — each with a distinct sessionId and its own
    // useDeepAgentsChat instance. We mock /api/chat/stream to branch on the
    // POST body's sessionId, returning a session-tagged response. Then we send
    // from each pane and assert each pane's message tree contains ONLY its own
    // response — no leak between hook instances.
    //
    // NOTE: this is not a true "in-flight overlap" test — the send button
    // disables on streaming, so each pane is sent sequentially. The shared-
    // state contract under test (message isolation per hook instance) doesn't
    // require overlap to be exercised; a bug that pooled state across hooks
    // would leak regardless of timing.
    const requestsBySession = new Map<string, number>();

    await page.route("**/api/chat/stream", async (route) => {
      const raw = route.request().postData() ?? "{}";
      const body = JSON.parse(raw) as { sessionId?: string };
      const sessionId = body.sessionId ?? "unknown";
      requestsBySession.set(
        sessionId,
        (requestsBySession.get(sessionId) ?? 0) + 1
      );

      // Each pane's response is tagged with its sessionId so cross-leak is
      // visually detectable.
      const responseText = `reply for ${sessionId}`;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body: [
          `data: {"type":"text-start","id":"t-${sessionId}"}`,
          `data: {"type":"text-delta","id":"t-${sessionId}","delta":${JSON.stringify(
            responseText
          )}}`,
          `data: {"type":"text-end","id":"t-${sessionId}"}`,
          `data: {"type":"finish","finishReason":"stop"}`,
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/concurrent-test");
    await page.waitForLoadState("networkidle");

    // Send from both panes serially. The route handler fulfills instantly,
    // so by the time pane A's click returns control, the response has been
    // received but React may not have committed the render yet. We don't need
    // strict in-flight overlap to test cross-contamination — a single shared
    // state bug would leak messages either way.
    await page.getByTestId("pane-a-input").fill("hello A");
    await page.getByTestId("pane-a-send").click();
    // Wait for A's request to be observed before sending B, so we don't race
    // the disabled-while-streaming state of the send button.
    await expect
      .poll(() => requestsBySession.get("concurrent-session-a") ?? 0, {
        timeout: 5_000,
      })
      .toBe(1);

    await page.getByTestId("pane-b-input").fill("hello B");
    await page.getByTestId("pane-b-send").click();
    await expect
      .poll(() => requestsBySession.get("concurrent-session-b") ?? 0, {
        timeout: 5_000,
      })
      .toBe(1);

    // Wait for both panes to receive their session-tagged response.
    await expect(page.getByTestId("pane-a-messages")).toContainText(
      "reply for concurrent-session-a",
      { timeout: 10_000 }
    );
    await expect(page.getByTestId("pane-b-messages")).toContainText(
      "reply for concurrent-session-b",
      { timeout: 10_000 }
    );

    // Cross-contamination check: pane A must NOT contain pane B's reply, and
    // vice versa. If the two hook instances shared state by mistake, both
    // would render both replies.
    await expect(page.getByTestId("pane-a-messages")).not.toContainText(
      "reply for concurrent-session-b"
    );
    await expect(page.getByTestId("pane-b-messages")).not.toContainText(
      "reply for concurrent-session-a"
    );

    // Each session fired exactly one request. This catches a bug where a
    // shared transport instance would issue duplicate POSTs.
    expect(requestsBySession.get("concurrent-session-a")).toBe(1);
    expect(requestsBySession.get("concurrent-session-b")).toBe(1);
  });

  test("E2E-11b: two useDeepAgentsChat instances stay isolated with TRULY overlapping in-flight requests", async ({
    page,
  }) => {
    // Variant of E2E-11 with delayed mock responses so both POSTs are open
    // simultaneously. This forecloses a class of bug E2E-11 can't see: a
    // hook implementation that races shared state when two requests are
    // resolving at the same time (e.g., a shared in-flight messageId or a
    // global "current stream" pointer would swap responses across panes).
    //
    // Strategy:
    //   1. Mock /api/chat/stream to hang for ~600ms before responding.
    //   2. Click pane A (POST opens, hangs).
    //   3. While A is still in flight, click pane B (POST opens — both alive).
    //   4. Sanity-check both panes are in non-idle status at the same moment.
    //   5. Let both complete; assert each pane only contains its own reply.
    test.setTimeout(20_000);

    const requestStarts: { sessionId: string; at: number }[] = [];
    const requestEnds: { sessionId: string; at: number }[] = [];
    const start = Date.now();

    await page.route("**/api/chat/stream", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        sessionId?: string;
      };
      const sessionId = body.sessionId ?? "unknown";
      requestStarts.push({ sessionId, at: Date.now() - start });
      // Hold the response so both POSTs overlap on the wire.
      await new Promise((r) => setTimeout(r, 600));
      requestEnds.push({ sessionId, at: Date.now() - start });

      const responseText = `delayed reply for ${sessionId}`;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache",
        },
        body: [
          `data: {"type":"text-start","id":"t-${sessionId}"}`,
          `data: {"type":"text-delta","id":"t-${sessionId}","delta":${JSON.stringify(
            responseText
          )}}`,
          `data: {"type":"text-end","id":"t-${sessionId}"}`,
          `data: {"type":"finish","finishReason":"stop"}`,
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/concurrent-test");
    await page.waitForLoadState("networkidle");

    // Fire pane A's send and pane B's send back-to-back. We do NOT await the
    // first click's chain to settle — we want both POSTs in flight at once.
    await page.getByTestId("pane-a-input").fill("hello A");
    await page.getByTestId("pane-b-input").fill("hello B");
    // Click both immediately. The buttons are per-pane and start enabled, so
    // both clicks register before either response returns 600ms later.
    await page.getByTestId("pane-a-send").click();
    await page.getByTestId("pane-b-send").click();

    // Sanity: BOTH panes should be in a non-idle status at this moment
    // (submitted or streaming) — proving both requests are actually overlapping.
    await expect
      .poll(
        async () =>
          (await page.getByTestId("pane-a-status").textContent()) ?? "",
        { timeout: 1_000 }
      )
      .toMatch(/submitted|streaming/);
    await expect(page.getByTestId("pane-b-status")).toHaveText(
      /submitted|streaming/
    );

    // Wait for both responses to render.
    await expect(page.getByTestId("pane-a-messages")).toContainText(
      "delayed reply for concurrent-session-a",
      { timeout: 10_000 }
    );
    await expect(page.getByTestId("pane-b-messages")).toContainText(
      "delayed reply for concurrent-session-b",
      { timeout: 10_000 }
    );

    // Isolation: under overlap, neither pane must contain the other's reply.
    await expect(page.getByTestId("pane-a-messages")).not.toContainText(
      "delayed reply for concurrent-session-b"
    );
    await expect(page.getByTestId("pane-b-messages")).not.toContainText(
      "delayed reply for concurrent-session-a"
    );

    // Prove overlap happened on the wire: both started before either ended.
    // Without this, the test would only prove sequential isolation (already
    // covered by E2E-11).
    expect(requestStarts.length).toBe(2);
    expect(requestEnds.length).toBe(2);
    const lastStart = Math.max(...requestStarts.map((r) => r.at));
    const firstEnd = Math.min(...requestEnds.map((r) => r.at));
    expect(
      lastStart,
      `both requests must overlap: second started at ${lastStart}ms but first ended at ${firstEnd}ms`
    ).toBeLessThan(firstEnd);
  });
});
