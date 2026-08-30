import { test, expect } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * open-swe's resume path, now that it HAS one (#361).
 *
 * Until this landed, `apps/open-swe/app/api/chat/` held `stream/` and `tools/`
 * and no `resume/`, and the page passed none of `enableReconnect`, `resumeId`
 * or `resumeEndpoint`. Three of the four tests in `e2e/shared/reconnect.spec.ts`
 * therefore asserted behaviour this app had never had, and #335 declined to
 * mirror them rather than write specs that pass or fail for unrelated reasons.
 * These are those three, against the feature rather than against a harness.
 *
 * ── WHY THE FIRST TEST IS A PRECONDITION AND NOT A NICETY ──────────────────
 *
 * `createDeepAgentsResumeHandler` answers 503 unless ENABLE_STREAM_RECONNECT is
 * "true" on the server. So the route can be mounted, reachable, and dead — and
 * every test below would still pass, because they assert what the CLIENT sends.
 * The auto-GET fires whether or not anything answers it. A suite that only
 * checked the client would go green over a server that refuses every resume,
 * which is the shape of a fix that changes nothing.
 *
 * So the route is asserted live first, and it is a test rather than a
 * beforeAll so it appears in the report as its own result.
 *
 * ── WHY THE RESUME ID IS NOT A LITERAL ─────────────────────────────────────
 *
 * The shared spec asserts `resumeId=test-resume-id-123`, which the example's
 * harness hardcodes. open-swe's is the CONVERSATION id, generated per session,
 * so there is no constant to compare against. What is asserted instead is
 * stronger: the id on the resume GET is the same id the POST body carries. A
 * hardcoded literal proves the string was plumbed; this proves the two halves
 * agree, which is the property that actually matters when a stream is being
 * matched back to its conversation.
 */

const RESUME = "**/api/chat/stream/resume**";

test.describe("open-swe — resume", () => {
  /**
   * Exactly the construction in packages/react/src/hook.ts:167-171, so this
   * probes the URL the CLIENT builds rather than one typed here.
   *
   * The first version of this test asked for `/api/chat/stream/resume/<id>` —
   * the PATH form — got 204, and reported "the route is live". It was live at
   * an address the hook never requests: the hook appends `?resumeId=`, and the
   * route answered only a path segment, so every real auto-GET 404'd. A
   * precondition that asserts a different URL from the one under test is the
   * defect it was written to prevent.
   */
  const urlTheHookBuilds = (endpoint: string, resumeId: string) =>
    `${endpoint}${endpoint.includes("?") ? "&" : "?"}resumeId=${resumeId}`;

  test("PRECONDITION: the resume route answers the URL the hook builds", async ({
    request,
  }) => {
    const res = await request.get(
      urlTheHookBuilds("/api/chat/stream/resume", "probe-not-a-real-id")
    );

    expect(
      res.status(),
      "503 means ENABLE_STREAM_RECONNECT is not set on this server: reconnect " +
        "is wired and inert, and the client-side assertions below would still " +
        "pass because they only observe what the client sends."
    ).not.toBe(503);
    expect(
      res.status(),
      "404 means the route does not answer the shape the hook requests — which " +
        "is what shipped before #361 and took every page that mounts the chat " +
        "surface down with it."
    ).not.toBe(404);
    // 204 = no such live stream, the healthy answer for an id never registered.
    expect([204, 200]).toContain(res.status());
  });

  test("the auto-GET fires on mount, carrying the same id the POST carries", async ({
    page,
  }) => {
    await stageReady(page);

    const resumeUrls: string[] = [];
    const postBodies: Array<Record<string, unknown>> = [];
    page.on("request", (req) => {
      const u = req.url();
      if (req.method() === "GET" && u.includes("/api/chat/stream/resume")) {
        resumeUrls.push(u);
      }
      if (req.method() === "POST" && u.endsWith("/api/chat/stream")) {
        postBodies.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      }
    });

    /*
     * THE RESUME ENDPOINT IS DELIBERATELY NOT STUBBED HERE.
     *
     * Every reconnect spec in this repo stubs it — four sites in
     * e2e/shared/reconnect.spec.ts — and that is why the hook and the handler
     * disagreed about the URL for as long as they did: the only thing that had
     * ever talked to that route was a mock. A stub proves the client SENT
     * something; only the real route proves anything ANSWERS.
     *
     * So this one test lets the auto-GET reach the real handler, and asserts
     * the page survives whatever comes back. The POST is still stubbed: this is
     * about the resume request, not about a chat turn.
     */
    await page.route(
      "**/api/chat/stream",
      (r) => void r.fulfill({ status: 204 })
    );

    await page.goto("/");
    await expect
      .poll(() => resumeUrls.length, {
        message:
          "no GET to the resume endpoint on mount — enableReconnect/resumeId/" +
          "resumeEndpoint are not reaching useDeepAgentsChat",
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const idOnResume = new URL(resumeUrls[0]).searchParams.get("resumeId");
    expect(idOnResume, "the resume GET carried no resumeId").toBeTruthy();

    // Now make the page send, so a POST body exists to compare against.
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();
    await expect
      .poll(() => postBodies.length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    expect(
      postBodies[0].sessionId,
      "the resume id and the conversation id have diverged — a resumed stream " +
        "would be matched back to the wrong conversation"
    ).toBe(idOnResume);

    // AND THE PAGE SURVIVED THE REAL RESPONSE. This is the assertion the whole
    // surface needed: 47 open-swe specs went red on the first attempt at this
    // feature because the auto-GET 404'd at mount and took the page with it,
    // and no stubbed test could see it. Reaching the composer proves the page
    // mounted and stayed usable after a real resume round-trip.
    await expect(
      page.getByTestId("chat-input"),
      "the page did not survive its own resume request"
    ).toBeVisible();
  });

  test("a resumed stream renders, without duplicating and without a spurious POST", async ({
    page,
  }) => {
    await stageReady(page);

    let posts = 0;
    await page.route("**/api/chat/stream", (r) => {
      posts++;
      return void r.fulfill({ status: 204 });
    });

    // The resume endpoint answers with a real SSE body, which is what the
    // client would receive when picking a live stream back up.
    await page.route(
      RESUME,
      (r) =>
        void r.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
            "Cache-Control": "no-cache",
          },
          body:
            'data: {"type":"text-start","id":"t1"}\n\n' +
            'data: {"type":"text-delta","id":"t1","delta":"resumed reply"}\n\n' +
            'data: {"type":"text-end","id":"t1"}\n\n' +
            'data: {"type":"finish","finishReason":"stop"}\n\n' +
            "data: [DONE]\n\n",
        })
    );

    await page.goto("/");

    // The body was CONSUMED, not merely requested. The previous test proves the
    // GET happens; a client that fired it and discarded the response would pass
    // that one and fail this.
    await expect(page.getByText("resumed reply")).toBeVisible({
      timeout: 20_000,
    });

    // Exactly once. A resume that replays into the transcript as a second copy
    // is the failure this half is about, and it looks fine on a single glance.
    await expect(page.getByText("resumed reply")).toHaveCount(1);

    // And no POST: resuming is not sending. A client that re-submitted the turn
    // would produce a duplicate answer server-side, which no client-side
    // de-duplication can undo.
    expect(posts, "resuming a stream sent a chat POST").toBe(0);
  });

  test("retry() replaces the failed reply instead of appending a second one", async ({
    page,
  }) => {
    await stageReady(page);
    await page.route(RESUME, (r) => void r.fulfill({ status: 204 }));

    let attempt = 0;
    await page.route("**/api/chat/stream", (r) => {
      attempt++;
      if (attempt === 1) {
        // First send fails at the transport, which is what puts the retry
        // control on screen at all.
        return void r.abort("connectionreset");
      }
      return void r.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
        },
        body:
          'data: {"type":"text-start","id":"t1"}\n\n' +
          'data: {"type":"text-delta","id":"t1","delta":"recovered reply"}\n\n' +
          'data: {"type":"text-end","id":"t1"}\n\n' +
          'data: {"type":"finish","finishReason":"stop"}\n\n' +
          "data: [DONE]\n\n",
      });
    });

    await page.goto("/");
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();

    // The banner is the only thing a person sees when the transport dies, and
    // until #361 it offered nothing to do about it.
    const banner = page.getByTestId("chat-stream-error");
    await expect(banner).toBeVisible({ timeout: 20_000 });

    const retry = page.getByTestId("chat-retry");
    await expect(
      retry,
      "the error banner offers no retry — `retry()` is also a no-op unless " +
        "enableReconnect is set, so this control and that option ship together"
    ).toBeVisible();

    await retry.click();

    await expect(page.getByText("recovered reply")).toBeVisible({
      timeout: 20_000,
    });
    // REPLACED, NOT APPENDED. The user asked once; two assistant turns for one
    // question is the defect, and it reads as the agent answering twice.
    await expect(page.getByText("recovered reply")).toHaveCount(1);
  });
});
