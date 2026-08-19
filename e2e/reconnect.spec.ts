import { test, expect } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Reconnect / retry E2E coverage for the example app's /reconnect-test page.
 *
 * Naming history: the original "retry resumes stream without duplicating
 * messages" test claimed to exercise the SSE resume/reconnect path but in
 * fact fulfilled two complete responses via Playwright's route.fulfill —
 * which cannot hold a stream open mid-way, so the "interruption" was fiction.
 *
 * This file now has three distinct tests with honest names:
 *   1. retry() replaces the assistant message — no duplication on a fresh
 *      retry against the same POST endpoint. (What the old spec actually
 *      tested.)
 *   2. enableReconnect + resumeId wires up the auto-GET to the resume
 *      endpoint with the correct query string at mount time. (Proves the
 *      resume code path is connected, even though we don't run the AI SDK's
 *      full resume protocol here.)
 *   3. real mid-stream abort: a local Node HTTP server streams a partial
 *      response, then destroys the socket. Asserts the hook surfaces an
 *      error state (status !== 'streaming' once the socket dies) and that
 *      a subsequent retry against a healthy backend recovers without
 *      duplicating the partial content.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
  // Allow the browser to read the streamed body cross-origin when the test
  // forwards to a local Node server (test #3).
  "Access-Control-Allow-Origin": "*",
} as const;

test.describe("DeepAgents E2E — retry & resume (E2E-09)", () => {
  test("retry() against the same endpoint replaces the assistant message instead of duplicating it", async ({
    page,
  }) => {
    let requestCount = 0;

    // The hook fires an auto-GET to the resume endpoint on mount (resume:true
    // when enableReconnect && resumeId). For this test we stub it with 204 —
    // see the next test for an honest resume-wire assertion.
    await page.route("**/api/chat/stream/resume**", async (route) => {
      await route.fulfill({ status: 204 });
    });

    await page.route("**/api/chat/stream", async (route) => {
      requestCount++;
      if (requestCount === 1) {
        // First request: complete short response.
        await route.fulfill({
          status: 200,
          headers: { ...SSE_HEADERS },
          body: [
            'data: {"type":"text-start","id":"t1"}',
            'data: {"type":"text-delta","id":"t1","delta":"First part"}',
            'data: {"type":"text-end","id":"t1"}',
            "",
            "",
          ].join("\n\n"),
        });
      } else {
        // Retry: extended response. The contract under test is that retry()
        // replaces — not appends — the assistant bubble.
        await route.fulfill({
          status: 200,
          headers: { ...SSE_HEADERS },
          body: [
            'data: {"type":"text-start","id":"t1"}',
            'data: {"type":"text-delta","id":"t1","delta":"First part"}',
            'data: {"type":"text-delta","id":"t1","delta":" continued"}',
            'data: {"type":"text-end","id":"t1"}',
            "",
            "",
          ].join("\n\n"),
        });
      }
    });

    await page.goto("/reconnect-test");
    await page.waitForLoadState("networkidle");

    await page.locator('[data-testid="input"]').fill("hello");
    await page.locator('[data-testid="send"]').click();

    await expect(page.locator("text=First part")).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('[data-testid="retry"]').click();

    await expect(page.locator("text=continued")).toBeVisible({
      timeout: 10_000,
    });

    // Dedup contract: only one message element contains "First part".
    // Scoped to the [data-testid="messages"] list root so a debug overlay,
    // sidebar, or any other div elsewhere on the page that incidentally
    // renders the same content can't inflate the count and fail the test
    // for the wrong reason (or, conversely, mask a real duplication).
    const messageEls = page
      .getByTestId("messages")
      .locator('[data-testid="message"]');
    const count = await messageEls.count();
    let firstPartCount = 0;
    for (let i = 0; i < count; i++) {
      const text = await messageEls.nth(i).textContent();
      if (text && text.includes("First part")) firstPartCount++;
    }
    expect(firstPartCount).toBe(1);
    expect(requestCount).toBe(2);
  });

  test("enableReconnect+resumeId auto-fires GET to the resume endpoint with the correct query string on mount", async ({
    page,
  }) => {
    // Stub the resume endpoint with a no-content response. We only care that
    // the request was made with the right URL — that proves
    // prepareReconnectToStreamRequest in packages/react/src/hook.ts:143-147 is
    // wired up to the resumeEndpoint+resumeId options on the page.
    await page.route("**/api/chat/stream/resume**", async (route) => {
      await route.fulfill({ status: 204 });
    });
    // Stub POST chat stream so React never sits in a streaming state.
    await page.route("**/api/chat/stream", async (route) => {
      await route.fulfill({ status: 204 });
    });

    // Race: start waiting BEFORE navigation so the auto-fire on mount is caught.
    const resumeReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "GET" && req.url().includes("/api/chat/stream/resume"),
      { timeout: 15_000 }
    );

    await page.goto("/reconnect-test");

    const resumeReq = await resumeReqPromise;
    // Page hardcodes resumeId="test-resume-id-123" — see
    // apps/example/app/reconnect-test/page.tsx:11.
    expect(resumeReq.url()).toContain("resumeId=test-resume-id-123");
  });

  test("resume protocol body is consumed: real SSE response renders on mount, with no duplication and no spurious POST", async ({
    page,
  }) => {
    // The prior test proves the auto-GET fires with the right query string.
    // This test goes further: when the resume endpoint returns a full SSE
    // body (as a real resumable server would), the AI SDK's useChat must
    //   1. consume the frames and surface them in the message tree
    //   2. produce exactly ONE assistant bubble (no duplication)
    //   3. consume the resume response exactly once (no retry storm)
    //   4. NOT fire a fresh POST to /api/chat/stream (resume is a separate
    //      protocol; if the hook treated the resume body as a hint to
    //      kick off a new request, that's a bug)
    let resumeHits = 0;
    let chatPosts = 0;

    await page.route("**/api/chat/stream/resume**", async (route) => {
      resumeHits++;
      await route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: [
          'data: {"type":"start","messageId":"resumed-msg-1"}',
          'data: {"type":"text-start","id":"rt1"}',
          'data: {"type":"text-delta","id":"rt1","delta":"resumed assistant text from server"}',
          'data: {"type":"text-end","id":"rt1"}',
          'data: {"type":"finish","finishReason":"stop"}',
          "",
          "",
        ].join("\n\n"),
      });
    });
    // POST chat stream — counted so we can prove resume didn't trigger one.
    // We never click send in this test, so the count must stay at 0.
    await page.route("**/api/chat/stream", async (route) => {
      chatPosts++;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/reconnect-test");

    // (1) The resumed assistant text must appear in the DOM purely from the
    // mount-time resume fetch — no user input, no send button click.
    await expect(
      page.locator("text=resumed assistant text from server")
    ).toBeVisible({ timeout: 10_000 });

    // The hook must end in a terminal state (the resume body included a
    // finish frame), not stuck in "streaming".
    await expect
      .poll(
        async () =>
          (await page.locator('[data-testid="status"]').textContent()) ?? "",
        { timeout: 10_000 }
      )
      .toMatch(/^(idle|error)$/);

    // (2) Exactly one assistant message — a bug where the AI SDK duplicates
    // the resumed message (e.g., once via the resume body + once via a
    // synthetic fresh stream) would push this to 2+.
    // The reconnect-test page emits one [data-testid="message"] per entry
    // (apps/example/app/reconnect-test/page.tsx:20). Scoped to the
    // [data-testid="messages"] list root to avoid false counts from any
    // page-wide rendering that incidentally echoes the same content.
    const messageEls = page
      .getByTestId("messages")
      .locator('[data-testid="message"]');
    const count = await messageEls.count();
    let assistantWithResumedText = 0;
    for (let i = 0; i < count; i++) {
      const t = (await messageEls.nth(i).textContent()) ?? "";
      if (t.includes("resumed assistant text from server")) {
        assistantWithResumedText++;
      }
    }
    expect(
      assistantWithResumedText,
      "exactly one message must contain the resumed text (no duplication)"
    ).toBe(1);

    // (3) The resume endpoint was hit exactly once. A retry storm or a
    // re-mount loop would push this above 1.
    expect(
      resumeHits,
      "resume endpoint must be fetched exactly once on mount"
    ).toBe(1);

    // (4) No fresh POST to /api/chat/stream. Resume is the only network the
    // hook should do on mount when enableReconnect+resumeId are set and the
    // user has not sent anything.
    expect(
      chatPosts,
      "resume body must NOT cause a fresh POST to /api/chat/stream"
    ).toBe(0);
  });

  test("real mid-stream socket abort: hook leaves streaming state, then retry against healthy server recovers without duplicating partial content", async ({
    page,
  }) => {
    // Spin up a Node HTTP server that streams a partial SSE body then destroys
    // the socket — this is a real, observable interruption, unlike route.fulfill
    // which delivers the whole body synchronously.
    let abortRequestCount = 0;
    const server = http.createServer((req, res) => {
      // Always set CORS headers — the page origin (localhost:3000) differs from
      // the server origin (localhost:<random>).
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type, x-resume-id"
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Resume GET — return 204 so the resume auto-fire doesn't interfere.
      if (req.method === "GET") {
        res.writeHead(204);
        res.end();
        return;
      }

      abortRequestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "Cache-Control": "no-cache",
      });

      if (abortRequestCount === 1) {
        // First request: stream the start + a single delta, then yank the
        // socket. The browser observes a half-finished stream — no text-end,
        // no finish, the body is just truncated.
        //
        // DELAY RATIONALE — the abort must NOT race the browser's parse:
        //   1. write() returns when bytes hit the kernel send buffer
        //   2. kernel transmits to loopback (~µs)
        //   3. browser fetch's ReadableStream surfaces the chunk
        //   4. AI SDK's SSE decoder parses the JSON frame
        //   5. hook updates state → React commits a render
        // If we destroy before step 5, the AI SDK may catch the stream error
        // BEFORE dispatching the parsed frame to the hook, leaving the partial
        // text completely absent from the DOM (verified — process.nextTick
        // destroy reproducibly produces an empty assistant bubble).
        // 200ms is comfortably above the worst-case localhost path on slow CI
        // workers and is bounded by the test's 10s visibility timeout below.
        res.write('data: {"type":"text-start","id":"t1"}\n\n');
        res.write(
          'data: {"type":"text-delta","id":"t1","delta":"partial chunk"}\n\n'
        );
        setTimeout(() => res.socket?.destroy(), 200);
      } else {
        // Retry: full clean response.
        res.write('data: {"type":"text-start","id":"t1"}\n\n');
        res.write(
          'data: {"type":"text-delta","id":"t1","delta":"partial chunk"}\n\n'
        );
        res.write(
          'data: {"type":"text-delta","id":"t1","delta":" then recovery"}\n\n'
        );
        res.write('data: {"type":"text-end","id":"t1"}\n\n');
        res.write('data: {"type":"finish","finishReason":"stop"}\n\n');
        res.end();
      }
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const port = (server.address() as AddressInfo).port;
    const upstream = `http://127.0.0.1:${port}`;

    try {
      // Route both endpoints to the local server.
      await page.route("**/api/chat/stream", async (route) => {
        await route.continue({ url: `${upstream}/stream` });
      });
      await page.route("**/api/chat/stream/resume**", async (route) => {
        await route.continue({ url: `${upstream}/resume` });
      });

      await page.goto("/reconnect-test");
      await page.waitForLoadState("networkidle");

      await page.locator('[data-testid="input"]').fill("hello");
      await page.locator('[data-testid="send"]').click();

      // Partial content appears before the abort.
      await expect(page.locator("text=partial chunk")).toBeVisible({
        timeout: 10_000,
      });

      // After the socket dies the hook must reach a terminal state — either
      // "error" (AI SDK surfaces a network failure) or "idle" (it finalises
      // the partial message). Asserting positively (toMatch) instead of
      // negatively (not.toMatch streaming|submitted) prevents a bug that
      // leaves the hook in an unexpected/empty state from quietly passing.
      await expect
        .poll(
          async () =>
            (await page.locator('[data-testid="status"]').textContent()) ?? "",
          { timeout: 15_000 }
        )
        .toMatch(/^(idle|error)$/);

      // Retry against the now-healthy server.
      await page.locator('[data-testid="retry"]').click();

      await expect(page.locator("text=then recovery")).toBeVisible({
        timeout: 15_000,
      });

      // The partial content from the first attempt must NOT have duplicated:
      // exactly one message bubble should contain "partial chunk". Scoped
      // to the [data-testid="messages"] list root for the same reasons as
      // the earlier dedup test — page-wide matches would mask bugs.
      const messageEls = page
        .getByTestId("messages")
        .locator('[data-testid="message"]');
      const count = await messageEls.count();
      let partialCount = 0;
      for (let i = 0; i < count; i++) {
        const text = await messageEls.nth(i).textContent();
        if (text && text.includes("partial chunk")) partialCount++;
      }
      expect(partialCount).toBe(1);

      // Proves the server actually saw two requests — the first was the
      // aborted one, the second is the recovery.
      expect(abortRequestCount).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
