import { test, expect } from "@playwright/test";
import { mockThreadState } from "./thread-state-mock";

// DASH-03: Live stream view — text tokens appear progressively via SSE
test.describe("DeepAgents E2E — open-swe Dashboard (DASH-03)", () => {
  // #22 RC-2: without a /state mock the page never goes live and no
  // EventSource is constructed, so every assertion below fails before
  // reaching its subject. See thread-state-mock.ts.
  test.beforeEach(async ({ page }) => {
    await mockThreadState(page);
  });

  test("DASH-03: run detail page shows streaming text from GET /stream endpoint", async ({
    page,
  }) => {
    const runId = "run-test-1";
    const threadId = "thread-test-1";

    // Mock the SSE stream endpoint
    await page.route(`**/api/open-swe/runs/${runId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"type":"text-start","id":"t1"}',
          "",
          'data: {"type":"text-delta","id":"t1","delta":"Hello from agent"}',
          "",
          'data: {"type":"text-end","id":"t1"}',
          "",
          'data: {"type":"finish","finishReason":"stop"}',
          "",
          "",
        ].join("\n"),
      });
    });

    await page.goto(`/runs/${runId}?threadId=${threadId}`);
    await expect(page.locator("text=Hello from agent")).toBeVisible({
      timeout: 10_000,
    });
    // Status assertion under route.fulfill: Chrome's EventSource transitions
    // to readyState=CLOSED the moment the synchronously-delivered body ends,
    // which the hook surfaces as "error" — a known mocking artefact, NOT a
    // real failure mode of the agent pipeline. The text-visibility check
    // above proves the happy path.
    //
    // Round 7 used `not.toContainText("connecting")`, which silently
    // false-greens if connect() never fires (status stays at "idle", the
    // hook's pre-connect initial state from useRunStream.ts:24). Asserting
    // an explicit allow-list — {streaming, done, error} — catches both
    // failure modes: stuck-at-idle (connect didn't fire) AND
    // stuck-at-connecting (EventSource construction failed).
    //
    // Format note: the page renders "Status: {status}" (page.tsx:43), so
    // the regex matches the full label rather than just the value.
    await expect(page.locator('[data-testid="stream-status"]')).toHaveText(
      /^Status: (streaming|done|error)$/,
      { timeout: 10_000 }
    );
  });
});

// DASH-04: Tool visualization — tool cards show pending then completed state
test.describe("DeepAgents E2E — open-swe Dashboard (DASH-04)", () => {
  // #22 RC-2: without a /state mock the page never goes live and no
  // EventSource is constructed, so every assertion below fails before
  // reaching its subject. See thread-state-mock.ts.
  test.beforeEach(async ({ page }) => {
    await mockThreadState(page);
  });

  // The route.fulfill mock delivers the entire SSE body in one shot, so the
  // "pending" state between tool-input-start and tool-output-available is
  // sub-frame and unobservable from the browser. The honest claim for this
  // test is "the final completed state renders with the right name+output."
  // Observable pending→completed transition coverage lives in
  // e2e/open-swe-dashboard.spec.ts where the EventSource mock dispatches
  // events with explicit setTimeout delays.
  test("DASH-04: tool-input-start + tool-output-available render a completed ToolCard with the right tool name", async ({
    page,
  }) => {
    const runId = "run-tool-test";
    const threadId = "thread-tool-test";

    await page.route(`**/api/open-swe/runs/${runId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"type":"tool-input-start","toolCallId":"tc1","toolName":"read_file","input":"{}"}',
          "",
          'data: {"type":"tool-output-available","toolCallId":"tc1","output":"file contents here"}',
          "",
          'data: {"type":"finish","finishReason":"stop"}',
          "",
          "",
        ].join("\n"),
      });
    });

    await page.goto(`/runs/${runId}?threadId=${threadId}`);

    // Tool card for read_file appears
    await expect(page.locator('[data-testid="tool-card"]')).toBeVisible({
      timeout: 10_000,
    });
    // Tool name is visible
    await expect(page.locator('[data-testid="tool-name"]')).toContainText(
      "read_file"
    );
    // Tool status shows completed
    await expect(page.locator('[data-testid="tool-status"]')).toContainText(
      "completed"
    );
  });

  test("DASH-04: expanding a completed tool card shows full input payload", async ({
    page,
  }) => {
    const runId = "run-tool-expand";
    const threadId = "thread-tool-expand";

    await page.route(`**/api/open-swe/runs/${runId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"type":"tool-input-start","toolCallId":"tc2","toolName":"write_file","input":"{\\"path\\":\\"/tmp/test.txt\\"}"}',
          "",
          'data: {"type":"tool-output-available","toolCallId":"tc2","output":"written"}',
          "",
          'data: {"type":"finish","finishReason":"stop"}',
          "",
          "",
        ].join("\n"),
      });
    });

    await page.goto(`/runs/${runId}?threadId=${threadId}`);

    // Wait for tool card to appear
    const toolCard = page.locator('[data-testid="tool-card"]').first();
    await expect(toolCard).toBeVisible({ timeout: 10_000 });

    // Click expand button to see input payload
    const expandButton = page.locator('[data-testid="expand-toggle"]');
    await expect(expandButton).toBeVisible({ timeout: 5_000 });
    await expandButton.click();

    // Input payload contract — the wire format sends `input` as a JSON
    // STRING (the SSE frame is `"input":"{\\"path\\":\\"/tmp/test.txt\\"}"`,
    // which parses to the JS string `'{"path":"/tmp/test.txt"}'`). The
    // hook stores it as-is (useToolState.ts:20,31,43,50 — no JSON.parse),
    // and ToolCard renders JSON.stringify(tool.input, null, 2). So the
    // current rendered output is the escaped-string form:
    //   "{\"path\":\"/tmp/test.txt\"}"
    //
    // Round 7 asserted just `toContainText("path")` AND
    // `toContainText("/tmp/test.txt")` — both pass whether the card
    // renders the escaped string OR a parsed object (`{ "path": "..." }`).
    // The distinction matters: if the hook is later changed to parse the
    // input, this test should fail and force a conscious decision (e.g.,
    // update the expected rendering). Use textContent + regex to pin
    // EXACTLY which form is rendered today.
    const toolInput = page.locator('[data-testid="tool-input"]');
    await expect(toolInput).toBeVisible({ timeout: 5_000 });
    const renderedInput = (await toolInput.textContent()) ?? "";
    // Current rendering: starts with a quote (escaped string form). If
    // this changes to start with `{` (parsed object), the test fails and
    // a deliberate update is needed.
    expect(
      renderedInput.trim(),
      "current contract: input is stored as wire-format string, NOT parsed; rendered output starts with a quote"
    ).toMatch(/^"\{\\"path\\":/);
    // Sanity: the path value remains present regardless of form change.
    expect(renderedInput).toContain("/tmp/test.txt");
  });
});

// DASH-05: Concurrent stream isolation — events from run A don't appear on page B
test.describe("DeepAgents E2E — open-swe Dashboard (DASH-05)", () => {
  // #22 RC-2: without a /state mock the page never goes live and no
  // EventSource is constructed, so every assertion below fails before
  // reaching its subject. See thread-state-mock.ts.
  test.beforeEach(async ({ page }) => {
    await mockThreadState(page);
  });

  test("DASH-05: concurrent run pages do not leak events between streams", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // #22 RC-2 again, and note WHY the describe-level beforeEach does not cover
    // this one: that hook mocks the `page` fixture, and this test never uses it
    // — it builds its own contexts so the two runs are genuinely isolated.
    // Each page therefore needs its own /state mock, or neither goes live and
    // the isolation assertion passes vacuously by finding nothing anywhere.
    await mockThreadState(pageA);
    await mockThreadState(pageB);

    const runIdA = "run-isolation-a";
    const runIdB = "run-isolation-b";
    const threadId = "thread-iso";

    await pageA.route(
      `**/api/open-swe/runs/${runIdA}/stream*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
          body: [
            'data: {"type":"text-start","id":"ta1"}',
            "",
            'data: {"type":"text-delta","id":"ta1","delta":"Content from run A"}',
            "",
            'data: {"type":"finish","finishReason":"stop"}',
            "",
            "",
          ].join("\n"),
        });
      }
    );

    await pageB.route(
      `**/api/open-swe/runs/${runIdB}/stream*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
          body: [
            'data: {"type":"text-start","id":"tb1"}',
            "",
            'data: {"type":"text-delta","id":"tb1","delta":"Content from run B"}',
            "",
            'data: {"type":"finish","finishReason":"stop"}',
            "",
            "",
          ].join("\n"),
        });
      }
    );

    await pageA.goto(`/runs/${runIdA}?threadId=${threadId}`);
    await pageB.goto(`/runs/${runIdB}?threadId=${threadId}`);

    await expect(pageA.locator("text=Content from run A")).toBeVisible({
      timeout: 10_000,
    });
    await expect(pageB.locator("text=Content from run B")).toBeVisible({
      timeout: 10_000,
    });

    // Assert no cross-contamination
    await expect(pageA.locator("text=Content from run B")).not.toBeVisible();
    await expect(pageB.locator("text=Content from run A")).not.toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
