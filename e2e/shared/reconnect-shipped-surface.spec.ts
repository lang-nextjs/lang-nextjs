import { test, expect } from "@playwright/test";

/**
 * RECONNECT ON THE SURFACE PEOPLE ACTUALLY USE (#376).
 *
 * `e2e/shared/reconnect.spec.ts` covers the resume protocol against
 * `/reconnect-test` — a bare harness with raw `status` / `messages` testids,
 * built to be a test target. Until #376 that was the ONLY page in the repo with
 * reconnect enabled, so the reference implementation demonstrated the feature
 * only where nobody copies from.
 *
 * ── WHY THIS FILE DOES NOT STUB THE RESUME ENDPOINT ────────────────────────
 *
 * Because that stub is how the feature stayed broken for its entire life.
 *
 * All four cases in reconnect.spec.ts do `page.route("**\/api/chat/stream/
 * resume**", 204)`, which is defensible there — it runs against several apps and
 * needs isolation. But combined with "the only page with reconnect enabled is a
 * harness", it meant NOTHING HAD EVER TALKED TO THE REAL ROUTE. The hook built
 * `?resumeId=` while the handler read a path segment, and the two disagreed
 * from the day reconnect landed until #372, with no test able to notice.
 *
 * So this file lets the auto-GET reach the real handler. A stub proves the
 * client SENT something; only the real route proves anything ANSWERS.
 *
 * The POST is still stubbed — this is about the resume request, not about a
 * chat turn, and an unstubbed POST would need a live backend.
 */

/** Exactly the construction in packages/react/src/hook.ts:170. */
const urlTheHookBuilds = (endpoint: string, resumeId: string) =>
  `${endpoint}${endpoint.includes("?") ? "&" : "?"}resumeId=${resumeId}`;

test.describe("the example app's SHIPPED surface resumes", () => {
  test("PRECONDITION: the resume route answers the URL the hook builds", async ({
    request,
  }) => {
    const res = await request.get(
      urlTheHookBuilds("/api/chat/stream/resume", "probe-not-a-real-id")
    );

    // 503 is the handler's own "reconnection disabled" answer, so the route was
    // REACHED — the distinction matters and is the reason this asserts both.
    expect(
      res.status(),
      "503: ENABLE_STREAM_RECONNECT is not set on this server, so reconnect is " +
        "wired and inert. The client-side assertion below would still pass, " +
        "because the auto-GET fires whether or not anything answers."
    ).not.toBe(503);
    expect(
      res.status(),
      "404: the route does not answer the shape the hook requests. That is what " +
        "shipped from the day reconnect landed until #372, and every test stubbed " +
        "past it."
    ).not.toBe(404);
    expect([200, 204]).toContain(res.status());
  });

  test("mounting / fires the auto-GET, and the page survives the real answer", async ({
    page,
  }) => {
    const resumeUrls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "GET" && req.url().includes("/api/chat/stream/resume")) {
        resumeUrls.push(req.url());
      }
    });

    // Only the POST. The resume endpoint is deliberately live — see the header.
    await page.route("**/api/chat/stream", (r) => void r.fulfill({ status: 204 }));

    await page.goto("/");

    await expect
      .poll(() => resumeUrls.length, {
        message:
          "no GET to the resume endpoint on mount. The SHIPPED surface is not " +
          "passing enableReconnect/resumeId/resumeEndpoint — which was the state " +
          "#376 was filed about, and the harness would still pass its own specs.",
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const id = new URL(resumeUrls[0]).searchParams.get("resumeId");
    expect(id, "the resume GET carried no resumeId").toBeTruthy();
    // The conversation id this app generates. Asserting the SHAPE rather than a
    // literal, because it is created per session — a hardcoded value could only
    // be kept in step by hand.
    expect(
      id,
      "the resume id is not this app's conversation id, so a resumed stream " +
        "would be matched back to the wrong conversation"
    ).toMatch(/^example/);

    // AND THE PAGE SURVIVED THE REAL RESPONSE. On open-swe the equivalent
    // request 404'd at mount and took 47 specs down with it; nothing stubbed
    // could see that. Reaching the composer proves the surface mounted and
    // stayed usable after a real resume round-trip.
    await expect(
      page.getByRole("textbox"),
      "the surface did not survive its own resume request"
    ).toBeVisible();
  });
});
