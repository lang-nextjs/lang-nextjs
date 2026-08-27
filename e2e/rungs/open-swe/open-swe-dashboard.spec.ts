import { test, expect } from "@playwright/test";
import { mockThreadState } from "./thread-state-mock";
import { stageReady } from "./readiness-mock";

/**
 * E2E tests for the OpenSWE dashboard and cancel button.
 *
 * Uses page.route() to mock API endpoints and SSE streams,
 * then asserts the rendered dashboard and run detail page.
 *
 * Note: The "cancel button visible during streaming" scenario cannot be
 * tested with route.fulfill() because it sends the complete body instantly,
 * causing EventSource to process all events and transition to "error" before
 * React renders. That scenario is covered by the component unit tests instead.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
} as const;

function makeDoneSseBody(text = "Task complete."): string {
  const events: string[] = [
    `data: ${JSON.stringify({ type: "text-delta", delta: text })}`,
    `data: [DONE]`,
  ];
  return events.join("\n\n") + "\n\n";
}

const mockRuns = [
  {
    run_id: "run-alpha",
    status: "running",
    created_at: "2026-05-25T10:00:00Z",
    task: "Refactor authentication module",
  },
  {
    run_id: "run-beta",
    status: "completed",
    created_at: "2026-05-25T09:00:00Z",
    task: "Write unit tests for utils",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("OpenSWE Dashboard", () => {
  // #124: the queue refuses work it knows cannot run, so a spec that
  // submits must first establish that it CAN. See readiness-mock.ts.
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("dashboard shows run list from API", async ({ page }) => {
    await page.route("**/api/open-swe/runs", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockRuns),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Run list cards render
    const cards = page.getByTestId("run-list-card");
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    // Status badges visible. #22 RC-1: the wire status is "running" but the
    // badge renders the DISPLAY label "Running" (RunListCard.statusBadge), and
    // this asserted the wire value. Assert both halves so the mapping itself is
    // covered rather than papered over with a case-insensitive match: the badge
    // for the "running" run must read "Running", and the one for the
    // "completed" run must read "Completed". A case-insensitive regex would
    // have gone green while leaving the two badges free to swap.
    await expect(page.getByTestId("run-status").first()).toHaveText("Running");
    await expect(page.getByTestId("run-status").nth(1)).toHaveText("Completed");

    // Task descriptions visible — scoped to each card so a debug overlay,
    // notification toast, or browser-tab title echo can't satisfy the
    // assertion (same weakness class fixed in deepagents-cards.spec.ts).
    await expect(cards.nth(0)).toContainText("Refactor authentication module");
    await expect(cards.nth(1)).toContainText("Write unit tests for utils");

    // Detail links present
    await expect(page.getByTestId("run-detail-link").first()).toBeVisible();
  });

  test("dashboard new-run button is disabled on empty/whitespace input — no POST fires", async ({
    page,
  }) => {
    // The new-run button is gated on `!task.trim()` (apps/open-swe/app/page.tsx).
    // Regression coverage: a refactor that removed the trim() guard would
    // let users submit empty tasks, hitting the route's 422 validator at
    // runtime — bad UX and wasted round trips. Assert both halves: button
    // disabled AND no POST observed.
    let postCount = 0;
    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() === "POST") postCount++;
      await route.fulfill({
        status: route.request().method() === "GET" ? 200 : 201,
        contentType: "application/json",
        body: JSON.stringify(
          route.request().method() === "GET" ? [] : { run_id: "should-not" }
        ),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const newRunBtn = page.getByTestId("new-run-button");
    // #22 RC-3: was `input[placeholder="Describe a task..."]` — wrong element
    // (the composer is a textarea) AND wrong copy. Selecting on the testid
    // added to apps/open-swe/app/page.tsx keeps this from breaking on the next
    // copy edit.
    const input = page.getByTestId("task-input");

    // Empty input → disabled.
    await expect(newRunBtn).toBeDisabled();

    // Whitespace-only → still disabled (the trim() guard is the contract).
    await input.fill("    ");
    await expect(newRunBtn).toBeDisabled();

    // Try clicking anyway — disabled buttons don't fire onClick but a
    // regression that allowed it should be caught.
    await newRunBtn.click({ force: true }).catch(() => {});

    // Real content re-enables (positive control).
    await input.fill("Real task");
    await expect(newRunBtn).toBeEnabled();

    // Fire the real submission and wait for the POST to land — replaces
    // a waitForTimeout("no post fires") heuristic with a deterministic
    // checkpoint AND proves the counter is wired. If postCount stayed at
    // 0 here the counter logic would be suspect, retroactively
    // invalidating the whitespace assertion above.
    await Promise.all([
      page.waitForRequest(
        (r) => r.method() === "POST" && r.url().endsWith("/api/open-swe/runs"),
        { timeout: 5_000 }
      ),
      newRunBtn.click(),
    ]);
    expect(
      postCount,
      "exactly one POST must fire — for the typed real task, NOT the prior whitespace force-click"
    ).toBe(1);
  });

  test("dashboard new-run form creates run with typed task body and redirects", async ({
    page,
  }) => {
    // Capture the POST body so we can assert the form actually carried the
    // user-typed task. The previous test only checked the URL changed —
    // a regression where the form sent an empty body would have slipped
    // through because the mock accepts any payload.
    let capturedPostBody: string | null = null;

    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([]),
        });
        return;
      }
      // POST — create run
      capturedPostBody = route.request().postData();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "run-new-1" }),
      });
    });

    // Mock the stream endpoint for the redirected run detail page
    await page.route("**/api/open-swe/runs/run-new-1/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDoneSseBody("New run started."),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Fill and submit the form
    // #22 RC-3: was `input[placeholder="Describe a task..."]` — wrong element
    // (the composer is a textarea) AND wrong copy. Selecting on the testid
    // added to apps/open-swe/app/page.tsx keeps this from breaking on the next
    // copy edit.
    const input = page.getByTestId("task-input");
    await input.fill("Build a REST API");
    await page.getByTestId("new-run-button").click();

    // Should redirect to run detail page
    await expect(page).toHaveURL(/\/runs\/run-new-1/, { timeout: 10_000 });

    // POST body must contain the typed task — proves the form is wired to
    // the input, not sending a stale or empty payload.
    expect(
      capturedPostBody,
      "form POST must have a body — null means no POST was captured at all"
    ).not.toBeNull();
    const body = JSON.parse(capturedPostBody!) as Record<string, unknown>;
    // The API contract uses `task` for the description; assert it carries
    // exactly what the user typed.
    expect(body.task).toBe("Build a REST API");
  });
});

test.describe("OpenSWE Run Detail — cancel button", () => {
  // #124: the queue refuses work it knows cannot run, so a spec that
  // submits must first establish that it CAN. See readiness-mock.ts.
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  // #22 RC-2: these specs mocked /stream but not /state. The page gates
  // the EventSource on the run being live, so without this every test in
  // this block failed at 'Status: completed' having never streamed.
  test.beforeEach(async ({ page }) => {
    await mockThreadState(page);
  });

  test("cancel button hidden after stream ends", async ({ page }) => {
    await page.route("**/api/open-swe/runs/run-done/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDoneSseBody("All done."),
      });
    });

    await page.goto("/runs/run-done?threadId=t1");
    await page.waitForLoadState("networkidle");

    // Wait for stream to finish — status should be "done"
    await expect(page.getByTestId("stream-status")).toContainText("done", {
      timeout: 10_000,
    });

    // Cancel button should NOT be visible
    await expect(page.getByTestId("cancel-run-button")).not.toBeVisible();
  });

  // [removed] "cancel button visible while connecting (fully mocked EventSource)"
  // synthesised a state real users effectively never see (CONNECTING is sub-ms
  // in practice) by stubbing EventSource to never fire "open". The contract
  // we actually care about — cancel button is visible during the non-terminal
  // streaming phase — is exercised by the next test, which opens EventSource
  // normally and asserts the button is visible while status="streaming".

  test("cancel button posts to cancel endpoint and transitions to done", async ({
    page,
  }) => {
    // Replace EventSource with a mock that fires "open" after a short delay,
    // keeping the hook in "streaming" state. No real network requests.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockStreamingES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        dispatchEvent() {
          return true;
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          // Fire "open" after 50ms to transition hook to "streaming"
          setTimeout(() => {
            this.readyState = 1; // OPEN
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
          }, 50);
        }
      };
    });

    // Track the cancel request explicitly so the assertion below proves the
    // upstream was actually told to stop — not just that the UI flipped state.
    let cancelRequest: {
      method: string;
      url: string;
      body: string | null;
    } | null = null;
    await page.route("**/api/open-swe/runs/run-cancel/cancel", (route) => {
      const req = route.request();
      cancelRequest = {
        method: req.method(),
        url: req.url(),
        body: req.postData(),
      };
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/runs/run-cancel?threadId=t1");
    await page.waitForLoadState("networkidle");

    // Status should become "streaming" from our mock's "open" event
    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    // Cancel button visible
    await expect(page.getByTestId("cancel-run-button")).toBeVisible();

    // Click cancel and wait for the actual POST to land at the proxy. Using
    // page.waitForRequest gives us a deterministic checkpoint that the network
    // call was made — without it, the test would pass even if the button just
    // mutated client state.
    const [cancelHttp] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().endsWith("/api/open-swe/runs/run-cancel/cancel") &&
          req.method() === "POST",
        { timeout: 10_000 }
      ),
      page.getByTestId("cancel-run-button").click(),
    ]);

    expect(cancelHttp.method()).toBe("POST");
    expect(cancelHttp.url()).toContain("/api/open-swe/runs/run-cancel/cancel");

    await expect(page.getByTestId("stream-status")).toContainText("done", {
      timeout: 10_000,
    });

    // Cancel button hidden after done
    await expect(page.getByTestId("cancel-run-button")).not.toBeVisible();

    // The route handler captured the request too — sanity-check it matches what
    // waitForRequest saw (proves the route intercept was the one that served it,
    // not a real backend that happened to be listening).
    expect(cancelRequest).not.toBeNull();
    expect(cancelRequest!.method).toBe("POST");
  });

  test("tool-input-start and tool-output-available render ToolCard with input/output", async ({
    page,
  }) => {
    // Mock EventSource that fires "open" then dispatches tool events.
    // No real network — route.fulfill() is replaced by a hanging handler so
    // the connection stays open and SSE events come from dispatchEvent.
    await page.route("**/api/open-swe/runs/run-tools/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockToolES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        dispatchEvent(type: string, data?: unknown) {
          const handlers = this.listeners.get(type) ?? [];
          for (const fn of handlers) {
            fn(data);
          }
          return true;
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          // Fire "open" after 50ms to transition hook to "streaming"
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
            // Dispatch tool-input-start event after open fires
            setTimeout(() => {
              const inputStart = {
                type: "tool-input-start",
                toolCallId: "tc-search-1",
                toolName: "search",
                input: { query: "weather in Tokyo" },
              };
              this.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify(inputStart),
                })
              );
              for (const fn of this.listeners.get("message") ?? []) {
                fn(
                  new MessageEvent("message", {
                    data: JSON.stringify(inputStart),
                  })
                );
              }
            }, 100);
            // Dispatch tool-output-available after another delay
            setTimeout(() => {
              const outputAvailable = {
                type: "tool-output-available",
                toolCallId: "tc-search-1",
                output: { result: "Sunny, 24°C in Tokyo" },
              };
              this.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify(outputAvailable),
                })
              );
              for (const fn of this.listeners.get("message") ?? []) {
                fn(
                  new MessageEvent("message", {
                    data: JSON.stringify(outputAvailable),
                  })
                );
              }
            }, 200);
          }, 50);
        }
      };
    });

    await page.goto("/runs/run-tools?threadId=t1");
    await page.waitForLoadState("networkidle");

    // Status should be "streaming"
    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    // ToolCard renders with tool name and input
    await expect(page.getByTestId("tool-name")).toContainText("search", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("tool-status")).toContainText("completed", {
      timeout: 10_000,
    });

    // The test name claims input/output verification — actually assert them.
    // Expand the card so the payload sections become visible, then verify the
    // query the tool was called with AND the result it returned. The earlier
    // version stopped at name+status, so a regression that dropped the
    // payload from the card would have slipped through.
    await page.getByTestId("expand-toggle").click();
    await expect(page.getByTestId("tool-input")).toContainText(
      "weather in Tokyo",
      { timeout: 5_000 }
    );
    await expect(page.getByTestId("tool-output")).toContainText(
      "Sunny, 24°C in Tokyo",
      { timeout: 5_000 }
    );
  });

  test("text deltas accumulate and render in the agent output section", async ({
    page,
  }) => {
    await page.route("**/api/open-swe/runs/run-text/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockTextES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        dispatchEvent() {
          return true;
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
            // Dispatch text-delta events
            setTimeout(() => {
              const delta1 = { type: "text-delta", delta: "Thinking..." };
              this.onmessage?.(
                new MessageEvent("message", { data: JSON.stringify(delta1) })
              );
              for (const fn of this.listeners.get("message") ?? []) {
                fn(
                  new MessageEvent("message", { data: JSON.stringify(delta1) })
                );
              }
            }, 100);
            setTimeout(() => {
              const delta2 = { type: "text-delta", delta: " Done." };
              this.onmessage?.(
                new MessageEvent("message", { data: JSON.stringify(delta2) })
              );
              for (const fn of this.listeners.get("message") ?? []) {
                fn(
                  new MessageEvent("message", { data: JSON.stringify(delta2) })
                );
              }
            }, 200);
          }, 50);
        }
      };
    });

    await page.goto("/runs/run-text?threadId=t1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    // Two independent toContainText calls would both pass even if the deltas
    // were rendered in the wrong order (e.g. "Done.Thinking..."). Assert the
    // combined text matches a regex requiring "Thinking..." BEFORE "Done." —
    // catches an accumulator regression that lost order across chunks.
    await expect(page.getByTestId("agent-text")).toContainText(
      /Thinking\.\.\.\s*Done\./,
      { timeout: 10_000 }
    );
  });

  test("tool-output-available before tool-input-start: no card mid-stream, then reconciles to completed when input arrives", async ({
    page,
  }) => {
    // This is the contract for useToolState's out-of-order handling
    // (apps/open-swe/lib/hooks/useToolState.ts:55-71):
    //   - output-available with no matching input → output is stashed, NO card
    //     is rendered yet (would-be phantom card).
    //   - the late input-start retrieves the stashed output → card renders with
    //     status="completed" directly (never appears as "pending" in this case).
    //
    // The previous test only asserted the final state. A regression where the
    // early output-available created a phantom card with status="pending"
    // would have slipped through. This version observes the mid-stream state
    // (no card while only the output has been received) and the reconciled
    // state separately, by triggering the two events from the test instead of
    // baking the timing into the mock.
    await page.route("**/api/open-swe/runs/run-ooto/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sseListeners = new Set<(d: string) => void>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sseDispatch = (data: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const fn of (window as any).__sseListeners) {
          fn(data);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockManualES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        dispatchEvent() {
          return true;
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          // Subscribe THIS instance's message handlers to __sseDispatch
          const wire = (data: string) => {
            const ev = new MessageEvent("message", { data });
            this.onmessage?.(ev);
            for (const fn of this.listeners.get("message") ?? []) {
              fn(ev);
            }
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__sseListeners.add(wire);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
          }, 20);
        }
      };
    });

    await page.goto("/runs/run-ooto?threadId=t1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    // No tool-card should exist before any tool events fire.
    await expect(page.getByTestId("tool-card")).toHaveCount(0);

    // Step 1 — fire only the output-available. The hook should stash it and
    // NOT render a phantom card (would indicate a regression where the output
    // alone produces a ToolCallState).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sseDispatch(
        JSON.stringify({
          type: "tool-output-available",
          toolCallId: "tc-write-1",
          output: { bytesWritten: 2048 },
        })
      );
    });

    // Give React a full microtask flush + a few animation frames so a phantom
    // would have time to appear if the hook was buggy.
    await page.waitForTimeout(200);
    await expect(page.getByTestId("tool-card")).toHaveCount(0);

    // Step 2 — fire the late input-start. The card should now appear and be
    // immediately "completed" (the stashed output is applied in one step).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sseDispatch(
        JSON.stringify({
          type: "tool-input-start",
          toolCallId: "tc-write-1",
          toolName: "write_file",
          input: { path: "/tmp/out.txt" },
        })
      );
    });

    await expect(page.getByTestId("tool-card")).toHaveCount(1, {
      timeout: 5_000,
    });
    await expect(page.getByTestId("tool-name")).toContainText("write_file");
    await expect(page.getByTestId("tool-status")).toContainText("completed");
  });

  test("increment tool renders ToolCard with name, empty input, and counter output", async ({
    page,
  }) => {
    // Both increment and get_counter take no arguments (input: {})
    const runId = "run-increment";
    const toolCallId = "tc-increment-1";

    await page.route(`**/api/open-swe/runs/${runId}/stream**`, (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockIncrementES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        private dispatch(type: string, data: string) {
          this.onmessage?.(new MessageEvent("message", { data }));
          for (const fn of this.listeners.get(type) ?? []) {
            fn(new MessageEvent("message", { data }));
          }
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
            // tool-input-start
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-start",
                  toolCallId: "tc-increment-1",
                  toolName: "increment",
                  input: {},
                })
              );
            }, 50);
            // tool-input-available (parsed args — always {} for increment)
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-available",
                  toolCallId: "tc-increment-1",
                  toolName: "increment",
                  input: {},
                })
              );
            }, 100);
            // tool-output-available
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-output-available",
                  toolCallId: "tc-increment-1",
                  output: "Counter incremented to 5",
                })
              );
            }, 150);
          }, 50);
        }
      };
    });

    await page.goto(`/runs/${runId}?threadId=t1`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    await expect(page.getByTestId("tool-name")).toContainText("increment", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("tool-status")).toContainText("completed", {
      timeout: 10_000,
    });

    // Expand to see input/output
    await page.getByTestId("expand-toggle").click();
    await expect(page.getByTestId("tool-input")).toContainText("{}", {
      timeout: 5_000,
    });
    await expect(page.getByTestId("tool-output")).toContainText(
      "Counter incremented to 5",
      { timeout: 5_000 }
    );
  });

  test("get_counter tool renders ToolCard with name, empty input, and current value", async ({
    page,
  }) => {
    const runId = "run-get-counter";
    const toolCallId = "tc-get-counter-1";

    await page.route(`**/api/open-swe/runs/${runId}/stream**`, (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockGetCounterES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        private dispatch(type: string, data: string) {
          this.onmessage?.(new MessageEvent("message", { data }));
          for (const fn of this.listeners.get(type) ?? []) {
            fn(new MessageEvent("message", { data }));
          }
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-start",
                  toolCallId: "tc-get-counter-1",
                  toolName: "get_counter",
                  input: {},
                })
              );
            }, 50);
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-available",
                  toolCallId: "tc-get-counter-1",
                  toolName: "get_counter",
                  input: {},
                })
              );
            }, 100);
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-output-available",
                  toolCallId: "tc-get-counter-1",
                  output: "Counter is 42",
                })
              );
            }, 150);
          }, 50);
        }
      };
    });

    await page.goto(`/runs/${runId}?threadId=t1`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    await expect(page.getByTestId("tool-name")).toContainText("get_counter", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("tool-status")).toContainText("completed", {
      timeout: 10_000,
    });

    await page.getByTestId("expand-toggle").click();
    await expect(page.getByTestId("tool-input")).toContainText("{}", {
      timeout: 5_000,
    });
    await expect(page.getByTestId("tool-output")).toContainText(
      "Counter is 42",
      { timeout: 5_000 }
    );
  });

  test("multiple tools (increment then get_counter) all render in order", async ({
    page,
  }) => {
    const runId = "run-multi-tools";

    await page.route(`**/api/open-swe/runs/${runId}/stream**`, (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: "data: {}\n\n",
      });
    });
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class MockMultiToolsES {
        url: string;
        readyState = 0;
        onopen: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        private listeners: Map<string, Function[]> = new Map();

        addEventListener(type: string, fn: Function) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type)!.push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          const arr = this.listeners.get(type);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        private dispatch(type: string, data: string) {
          this.onmessage?.(new MessageEvent("message", { data }));
          for (const fn of this.listeners.get(type) ?? []) {
            fn(new MessageEvent("message", { data }));
          }
        }
        constructor(url: string | URL) {
          this.url = url.toString();
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            for (const fn of this.listeners.get("open") ?? []) {
              fn(new Event("open"));
            }
            // --- increment tool ---
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-start",
                  toolCallId: "tc-increment-1",
                  toolName: "increment",
                  input: {},
                })
              );
            }, 50);
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-output-available",
                  toolCallId: "tc-increment-1",
                  output: "Counter incremented to 7",
                })
              );
            }, 120);
            // --- get_counter tool ---
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-input-start",
                  toolCallId: "tc-get-counter-1",
                  toolName: "get_counter",
                  input: {},
                })
              );
            }, 200);
            setTimeout(() => {
              this.dispatch(
                "message",
                JSON.stringify({
                  type: "tool-output-available",
                  toolCallId: "tc-get-counter-1",
                  output: "Counter is 7",
                })
              );
            }, 280);
          }, 50);
        }
      };
    });

    await page.goto(`/runs/${runId}?threadId=t1`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("stream-status")).toContainText("streaming", {
      timeout: 10_000,
    });

    // Both tool cards should be visible
    const toolCards = page.getByTestId("tool-card");
    await expect(toolCards).toHaveCount(2, { timeout: 10_000 });

    // Names in order
    const names = page.getByTestId("tool-name");
    await expect(names.nth(0)).toContainText("increment");
    await expect(names.nth(1)).toContainText("get_counter");

    // Both completed
    const statuses = page.getByTestId("tool-status");
    await expect(statuses.nth(0)).toContainText("completed");
    await expect(statuses.nth(1)).toContainText("completed");
  });
});

/**
 * THE CREATE -> BOARD JOURNEY.
 *
 * Both halves were already covered and the seam between them was not: the create
 * test above submits and follows the redirect to /runs/<id>, and never comes back.
 * `run-board` and `board-column-*` appeared in zero e2e specs — the board's only
 * coverage was lib/run-board.test.ts, which tests `groupRuns()` as a function and
 * cannot see whether a column reaches the page.
 *
 * WHY THE GET MOCK IS DRIVEN BY THE POST. The list handler below returns [] until
 * a POST has happened and the created run afterwards. If it simply always returned
 * the run, this would pass against a form that submits nothing at all — asserting
 * the mock rather than the journey. The state transition IS the seam being walked.
 *
 * The queue polls every 5s (useRuns.ts), so the GET is hit repeatedly; these
 * handlers are therefore idempotent and consistent rather than one-shot.
 */
test.describe("OpenSWE Dashboard — create-to-board journey", () => {
  // #124: the queue refuses work it knows cannot run, so a spec that
  // submits must first establish that it CAN. See readiness-mock.ts.
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  /** Column a status is expected to land in, per lib/run-board.ts. */
  const COLUMN_FOR: Record<string, string> = {
    pending: "backlog",
    running: "in-progress",
    interrupted: "needs-approval",
    completed: "done",
    failed: "errored",
  };
  /** The five that always render. `other` is hideWhenEmpty. */
  const ALWAYS_VISIBLE = [
    "backlog",
    "in-progress",
    "needs-approval",
    "done",
    "errored",
  ];

  test("a created run comes back on the board, in the column its status maps to", async ({
    page,
  }) => {
    const created: Array<Record<string, unknown>> = [];

    await page.route("**/api/open-swe/runs", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          // Empty until the POST lands — see the note above.
          body: JSON.stringify(created),
        });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        task?: string;
      };
      created.push({
        run_id: "run-journey-1",
        // `pending` so this asserts the backlog column specifically. A run that
        // arrived as `running` would pass a weaker version of this test.
        status: "pending",
        created_at: "2026-05-25T12:00:00Z",
        task: body.task,
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "run-journey-1" }),
      });
    });
    await page.route("**/api/open-swe/runs/run-journey-1/stream**", (route) => {
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: makeDoneSseBody("Started."),
      });
    });

    // 1-2. Open the board and submit a task.
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("run-board")).toBeVisible();
    await page.getByTestId("task-input").fill("Add a health endpoint");
    await page.getByTestId("new-run-button").click();

    // 3. It redirects away to the run detail page...
    await expect(page).toHaveURL(/\/runs\/run-journey-1/, { timeout: 10_000 });

    // ...and back to the board, which is the step nothing walked before.
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 4a. The run is on the board at all.
    const card = page
      .getByTestId("run-list-card")
      .filter({ hasText: "Add a health endpoint" });
    await expect(card).toHaveCount(1);

    // 4b. And in the RIGHT column. Scoping the card query to the backlog column
    // is the assertion — a board that piles everything into one column passes
    // "is it present somewhere" and fails this.
    const backlog = page.getByTestId("board-column-backlog");
    await expect(
      backlog.getByTestId("run-list-card").filter({ hasText: "Add a health endpoint" })
    ).toHaveCount(1);
    // ASSERTED ON THE DATA, THEN ON THE WORDS. This read
    // `toContainText("pending")`, which passed only because the badge rendered
    // the RAW ENUM VALUE — the defect this branch fixes. Every status now has
    // a human label, so a text assertion alone would have to be rewritten
    // whenever the wording improves, while `data-status` is the contract.
    await expect(backlog.getByTestId("run-status")).toHaveAttribute(
      "data-status",
      "pending"
    );
    // And the words a person reads are not the enum.
    const pill = await backlog.getByTestId("run-status").innerText();
    expect(pill.trim()).not.toBe("pending");
    expect(pill.trim().length).toBeGreaterThan(0);
    await expect(page.getByTestId("board-count-backlog")).toHaveText("1");

    // And nowhere else: every other column is still empty.
    for (const id of ALWAYS_VISIBLE.filter((c) => c !== "backlog")) {
      await expect(
        page.getByTestId(`board-count-${id}`),
        `column ${id} should not have received the new run`
      ).toHaveText("0");
    }
  });

  test("all five columns render when the queue is EMPTY", async ({ page }) => {
    // Regression guard: the board was once replaced wholesale by a "No threads
    // yet" box, so an empty queue rendered one rectangle and no columns at all.
    // A kanban's columns are information before anything is in them.
    await page.route("**/api/open-swe/runs", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("run-board")).toBeVisible();
    for (const id of ALWAYS_VISIBLE) {
      await expect(
        page.getByTestId(`board-column-${id}`),
        `column ${id} must render on an empty queue`
      ).toBeVisible();
      await expect(page.getByTestId(`board-count-${id}`)).toHaveText("0");
    }
    // The empty-queue hint coexists with the board rather than replacing it.
    await expect(page.getByText("No threads yet")).toBeVisible();
    // `other` is hideWhenEmpty — absent here, which is the complement of the
    // unrecognised-status test below. Without this pair, a board that always
    // rendered `other` and one that never did would both pass.
    await expect(page.getByTestId("board-column-other")).toHaveCount(0);
  });

  test("an unrecognised status lands in `other` and is not dropped", async ({
    page,
  }) => {
    // THE ONE THAT MATTERS MOST. A board that silently omits work looks exactly
    // like a board with less work on it. `other` exists so a status the columns
    // do not name makes a sixth column APPEAR rather than making runs vanish —
    // and this asserts it reaches the DOM, not that groupRuns() returned it.
    await page.route("**/api/open-swe/runs", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            run_id: "run-known",
            status: "running",
            created_at: "2026-05-25T10:00:00Z",
            task: "A status the board knows",
          },
          {
            run_id: "run-weird",
            status: "quiesced",
            created_at: "2026-05-25T11:00:00Z",
            task: "A status the board has never heard of",
          },
        ]),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const other = page.getByTestId("board-column-other");
    await expect(other).toBeVisible();
    await expect(
      other.getByTestId("run-list-card").filter({ hasText: "never heard of" })
    ).toHaveCount(1);
    await expect(page.getByTestId("board-count-other")).toHaveText("1");

    // The known run still routed normally — an `other` column that swallowed
    // everything would satisfy the assertions above on its own.
    await expect(
      page
        .getByTestId("board-column-in-progress")
        .getByTestId("run-list-card")
        .filter({ hasText: "the board knows" })
    ).toHaveCount(1);

    // NOTHING WAS LOST. Counted across every rendered column, so a run that fell
    // out of grouping entirely fails here even if each column looks plausible.
    const counts = await page.getByTestId(/^board-count-/).allTextContents();
    const total = counts.reduce((n, t) => n + Number(t), 0);
    expect(total, "every run must appear in exactly one column").toBe(2);
  });
});
