/**
 * E2E spec for the HITL (human-in-the-loop) approval demo.
 *
 * Walks the full client⇄server flow through the example app:
 *   1. Visit /hitl-demo
 *   2. Click "Start demo run" → useDeepAgentsChat POSTs /api/hitl-demo
 *   3. The proxy (createDeepAgentsHandler + approvalGating) fetches
 *      /api/hitl-demo/backend and intercepts tool-input-start
 *   4. data-approval-required arrives at the client; the page renders ApprovalCard
 *   5. Click approve / reject / edit / respond → POST /api/approval/[id]
 *   6. Proxy drains buffered frames or emits data-error / data-human-response
 *   7. Assert the visible result
 *
 * Notes
 *   - Approve/edit assertions verify the post-approval continuation text
 *     ("Done. Two files in /tmp.") arrives. This proves the gate released
 *     and the stream proceeded — it does NOT rely on AI SDK v6's tool-call
 *     assembly (which uses a strictObject schema that rejects tool-input-start
 *     frames carrying an `input` field — an orthogonal compatibility concern).
 *   - Each test creates a fresh in-memory approval (random UUID server-side),
 *     so tests are independent even though the registry is a process singleton.
 */

import { test, expect } from "@playwright/test";

test.describe("HITL demo — LangGraph HumanInterrupt parity", () => {
  test("approve: card dismisses; no error-msg appears (drain succeeded)", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await expect(page.getByTestId("hitl-demo-page")).toBeVisible();

    await page.getByTestId("start-button").click();

    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "bash_execute"
    );
    await expect(page.getByTestId("approval-status")).toHaveText("waiting");
    // The approval's `arguments` echo shows the unmodified command.
    await expect(page.getByTestId("approval-arguments")).toContainText(
      "ls -la /tmp"
    );

    await page.getByTestId("approve-button").click();

    // The POST resolves with 200 → card dismisses. A failed POST would leave
    // status="error" on the controller and the card visible.
    await expect(card).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );

    // Approve does NOT emit a data-error frame, so no error message appears.
    // (Reject and timeout DO surface error-msg — see those tests.)
    await expect(page.getByTestId("error-msg")).toHaveCount(0);

    // After approval, the gate drains the buffered tool-output-available and
    // forwards the trailing text-delta frames. Asserting the continuation
    // text appeared proves the drain actually worked — the previous version
    // only checked that the card hid (which a 200 POST achieves on its own,
    // even if the buffered frames were dropped).
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("reject: data-error surfaces, the tool does not execute, unrelated trailing frames still pass through", async ({
    page,
  }) => {
    // The old title claimed "agent's closing text does NOT appear". It never
    // asserted that, and the claim is false: on reject the gate drops only the
    // buffered TOOL frames and still drains globalBufferedFrames, which hold
    // the backend's trailing text-deltas. That pass-through is the documented
    // contract (see the round-7 revert note on the timeout test) — the title
    // was the wrong half. Both halves are now asserted so the file cannot
    // drift back into describing behaviour it does not check.
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("reject-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // The rejection emits a data-error frame which useDeepAgentsChat surfaces
    // as an ErrorMessage in the message union.
    await expect(page.getByTestId("error-msg")).toContainText(/rejected/i, {
      timeout: 30_000,
    });

    // The real invariant: the rejected tool never executed, so no tool call
    // and no tool result may reach the client. This is what "rejected" has to
    // mean; without it the test would pass on a gate that forwarded the tool
    // frames and merely also emitted an error.
    await expect(page.getByTestId("tool-call-msg")).toHaveCount(0);
    await expect(page.getByTestId("tool-result")).toHaveCount(0);

    // The documented pass-through, pinned so it is a decision rather than an
    // accident: frames unrelated to the gated tool still reach the client.
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("edit: textarea fill + submit → 200 → card dismisses", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("show-edit-button").click();
    const editInput = page.getByTestId("edit-input");
    await editInput.fill('{"command":"ls"}');
    await page.getByTestId("submit-edit-button").click();

    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });
    // Successful POST → controller status is "success".
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );
  });

  test("respond: human-response frame is rendered; error-msg is NOT", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("show-respond-button").click();
    await page
      .getByTestId("respond-input")
      .fill("Use grep -r 'pattern' instead — safer.");
    await page.getByTestId("submit-respond-button").click();

    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // data-human-response reaches the client.
    await expect(page.getByTestId("human-response")).toContainText(
      "Use grep -r 'pattern' instead — safer.",
      { timeout: 30_000 }
    );
    // No data-error (respond is a successful resolution, not rejection).
    await expect(page.getByTestId("error-msg")).toHaveCount(0);
  });

  test("edit: invalid JSON in the textarea is rejected client-side without POSTing", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("show-edit-button").click();
    await page.getByTestId("edit-input").fill("not valid json {");
    await page.getByTestId("submit-edit-button").click();

    await expect(page.getByTestId("edit-error")).toBeVisible();
    await expect(page.getByTestId("approval-card")).toBeVisible();
  });

  // NOTE: the next test is pure ApprovalCard form-validation (does not
  // exercise the HITL drain/respond flow) — it lives here because it shares
  // the page setup, but the assertion is a button-disabled UI check. If
  // ApprovalCard moves into a shared component package, this test should
  // migrate to that package's component tests.
  test("ApprovalCard form: respond submit is disabled until text is entered (UI-only, no flow)", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("show-respond-button").click();
    await expect(page.getByTestId("submit-respond-button")).toBeDisabled();

    await page.getByTestId("respond-input").fill("a");
    await expect(page.getByTestId("submit-respond-button")).toBeEnabled();
  });

  test("timeout: /api/hitl-demo-timeout emits a data-error SSE frame with code='approval_timeout'", async ({
    request,
  }) => {
    // HTTP-LEVEL TIMEOUT COVERAGE.
    //
    // The previous UI-level test (test.skip below) suffered from a real but
    // orthogonal AI SDK ↔ React rendering issue: "No tool invocation found
    // for tool call ID 'tc-hitl-1'" surfaced before the data-error frame
    // could be processed when run AFTER any other HITL test. The proxy
    // itself emits the correct stream; the leak is upstream of the gate.
    //
    // This test bypasses the AI SDK and asserts the contract that actually
    // matters at the E2E layer: POSTing to the timeout-configured proxy
    // produces an SSE response containing a data-error frame with
    // code="approval_timeout". The backend mock sleeps 8s before sending
    // tool-output-available; the proxy is mounted with timeoutMs:1_000,
    // so by the time the upstream output arrives the lazy TTL check has
    // marked the approval as timed-out and drainRejectOrTimeout fires.
    test.setTimeout(30_000);

    const response = await request.post("/api/hitl-demo-timeout", {
      data: { messages: [{ role: "user", content: "List the files in /tmp" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 20_000,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/event-stream");

    const body = await response.text();
    const frames = body
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{
      type: string;
      data?: { code?: string; message?: string };
    }>;

    // Must see the approval envelope before the timeout fires.
    const approvalRequired = frames.find(
      (f) => f.type === "data-approval-required"
    );
    expect(
      approvalRequired,
      "proxy must emit data-approval-required before timeout"
    ).toBeTruthy();

    // The contract under test: a data-error frame with code=approval_timeout.
    // (When the grace-protected GC in approval-registry.ts was racing this
    // path, the proxy leaked the raw tool-output-available instead — that's
    // the bug this test now guards against.)
    const errorFrame = frames.find(
      (f) => f.type === "data-error" && f.data?.code === "approval_timeout"
    );
    expect(
      errorFrame,
      "proxy must emit data-error code=approval_timeout when timeoutMs elapses without resolution"
    ).toBeTruthy();
    expect(errorFrame!.data!.message).toMatch(/timeout|expired/i);

    // tool-output-available must NOT leak through raw — the gate must drop it
    // when the approval timed out. Catching this directly prevents regression
    // of the cleanup-race bug.
    const leakedToolOutput = frames.find(
      (f) => f.type === "tool-output-available"
    );
    expect(
      leakedToolOutput,
      "proxy must NOT forward the upstream tool-output-available raw after a timeout — it should be dropped by the gate"
    ).toBeUndefined();

    // NOTE: A "no frames after data-error" invariant was attempted and
    // reverted (round 7) — by design the gate drops ONLY the buffered
    // tool frames on timeout. The backend mock's subsequent unrelated
    // frames (closing text-deltas + finish) legitimately pass through,
    // mirroring the contract documented on the cross-tab reject test.
    // The leakedToolOutput check above is the correct invariant for the
    // gate's timeout behavior; a no-frames-after-error check would
    // overreach and assert behavior the gate doesn't promise.
  });

  test("multi-interrupt: two gated tool calls in a row each render an approval card", async ({
    page,
    browserName,
  }) => {
    // WebKit skip. #39 did NOT fix this one; re-verified after it landed and
    // the test still fails 3/3 on WebKit. Measurements below are from the
    // #25 spike, all against the same machine and browser build.
    //
    // The bytes are not the problem. Reading /api/hitl-demo-multi with RAW
    // fetch (no AI SDK, no React) from the page's own origin, the second
    // data-approval-required frame arrives at 4.02s under WebKit and 4.02s
    // under chromium — identical. So there is no WebKit network-level
    // chunk buffering here, and an SSE heartbeat would not help.
    //
    // The gap is between "bytes reached JS" and "React rendered the card",
    // and it is specific to the SECOND data-* part mid-stream: the FIRST
    // approval card renders in 0.03s on WebKit in every scenario. Card 2
    // does not render until the stream ends. That points at the AI SDK v6
    // UIMessageStream/useChat pipeline under WebKit, which is what the
    // original skip comment said — that part of it was right, and the #25
    // spike's initial "WebKit chunked-fetch buffering" reading was wrong.
    //
    // What the original comment got wrong, and why it is not restored
    // verbatim: it claimed a 60s test timeout (the real failure is an
    // assertion failure at ~39s), and it cited "both attempts in CI" for a
    // run that cannot have existed — the first CI job ever to execute WebKit
    // skipped this very test.
    //
    // #39 made the symptom worse rather than better, which is expected and
    // is not an argument against #39. The proxy now holds its response open
    // waiting for the human, so the stream no longer closes at ~8.5s — and
    // stream close was the only thing that flushed the pending part. Card 2
    // therefore appears at 38.59s (upstream close + the 30s drainGraceMs)
    // instead of 9.02s. Measured both ways on the same box. #39 still does
    // its job here: at grace expiry the buffered frames are released with an
    // approval_pending_at_close error rather than dropped.
    //
    // Un-skip when the client-side pipeline surfaces a mid-stream second
    // data-* part on WebKit without waiting for stream end. No upstream
    // issue is filed yet — do not add a URL here until one exists.
    test.skip(
      browserName === "webkit",
      "WebKit renders a second mid-stream data-* part only at stream end; bytes arrive on time (raw fetch: 4.02s, same as chromium), so this is the client pipeline, not the network. Not fixed by #39."
    );
    // The N-output SseMultiTransform contract eliminates the structural
    // limitation that previously made multi-interrupt fail: the gate no
    // longer juggles a readyQueue across calls — each transform call returns
    // its full drain array in one shot, so subsequent input frames (including
    // a second gated tool-input-start) reach the gate normally.
    await page.goto("/hitl-demo?proxy=multi");
    await page.getByTestId("start-button").click();

    // Card 1: bash_execute
    await expect(page.getByTestId("approval-card")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "bash_execute"
    );
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // Card 2: write_file (the second tool-input-start in the multi scenario)
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "write_file",
      { timeout: 30_000 }
    );
    await expect(page.getByTestId("approval-card")).toBeVisible();
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // Both approvals resolved cleanly; no error frame surfaced.
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );
    await expect(page.getByTestId("error-msg")).toHaveCount(0);

    // Verify the trailing closing-summary text-delta from the backend
    // actually reached the client. This proves the second drain after the
    // write_file approval released the readyQueue end-to-end — without this
    // assertion, the previous coverage only proved both POSTs returned 200.
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("auth-deny: POST to /api/approval-protected without a token returns 401", async ({
    request,
  }) => {
    // No approvalId in the registry — but the 401 must come BEFORE the
    // route looks up the registry. We don't need a real approval to test this.
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        // No Authorization header → authorize callback returns false → 401.
      }
    );
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  test("auth-deny: POST with a wrong Bearer token also returns 401", async ({
    request,
  }) => {
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer wrong-token" },
      }
    );
    expect(response.status()).toBe(401);
  });

  test("auth-allow: POST with the correct Bearer reaches the registry (404, not 401)", async ({
    request,
  }) => {
    // Auth passes → handler progresses to the registry lookup → 404 since
    // no such approvalId exists. Proves the auth callback isn't blocking the
    // happy path.
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer test-secret-token" },
      }
    );
    expect(response.status()).toBe(404);
  });

  test("auth-allow happy path: valid Bearer resolves a real approval end-to-end and the gate drains", async ({
    request,
    baseURL,
  }) => {
    // The previous auth-allow test only proves the token authorises far enough
    // to hit the registry lookup (404). This test exercises the FULL round-trip:
    //   1. Start a streaming /api/hitl-demo POST (unprotected approval route
    //      will be the natural producer of the approval envelope).
    //   2. Read frames until data-approval-required arrives; capture approvalId.
    //   3. POST decision=approve to /api/approval-protected/<approvalId> with
    //      the valid Bearer — the protected route shares the global approval
    //      registry, so resolving via the protected route should release the gate.
    //   4. Continue reading the stream; expect the trailing "Done. Two files in
    //      /tmp." text-delta to arrive, proving the drain actually fired.
    test.setTimeout(30_000);

    // Use the native fetch (Node 18+) so we can stream the body incrementally.
    // Playwright's `request` fixture returns the body in one shot, which would
    // block until the gate releases — and we're the ones who release it.
    const streamRes = await fetch(`${baseURL}/api/hitl-demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "List the files in /tmp" }],
      }),
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let approvalId: string | undefined;

    // Drain incoming chunks until we extract approvalId from a
    // data-approval-required frame. Bound by test.setTimeout above.
    while (!approvalId) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const segments = buffer.split("\n\n");
      // Keep the last (possibly partial) segment in the buffer.
      buffer = segments.pop() ?? "";
      for (const seg of segments) {
        if (!seg.startsWith("data: ")) continue;
        try {
          const frame = JSON.parse(seg.slice("data: ".length)) as {
            type?: string;
            data?: { id?: string };
          };
          if (frame.type === "data-approval-required" && frame.data?.id) {
            approvalId = frame.data.id;
            break;
          }
        } catch {
          // Non-JSON or partial; ignore and keep reading.
        }
      }
    }
    expect(
      approvalId,
      "approval envelope must arrive before timeout"
    ).toBeTruthy();

    // Resolve via the PROTECTED route with a valid Bearer. This is the
    // assertion under test — auth-allow happy path.
    const resolve = await request.post(
      `/api/approval-protected/${approvalId}`,
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer test-secret-token" },
      }
    );
    expect(resolve.status()).toBe(200);

    // Continue reading the stream. The gate must drain the buffered tool
    // frames and forward the trailing text-delta. Without the drain, we'd
    // hit the test timeout instead.
    let sawDrainText = false;
    while (!sawDrainText) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("Done. Two files in /tmp.")) {
        sawDrainText = true;
      }
    }
    // Releasing the reader so the underlying socket can close cleanly.
    await reader.cancel().catch(() => {});

    expect(
      sawDrainText,
      "after auth-allowed approval resolves, the gate must drain and emit the trailing text"
    ).toBe(true);
  });

  test("cross-tab: an approval created in tab A can be resolved from tab B via the shared global registry", async ({
    browser,
  }) => {
    // The approval registry (packages/server/src/approval-registry.ts) is a
    // process-level singleton — any client with the approvalId can resolve it
    // via the API, regardless of which browser tab/context created it. This
    // test makes that contract explicit:
    //   1. Tab A: open /hitl-demo, click start, wait for the approval card,
    //      capture approvalId from the card's data-approval-id attribute.
    //   2. Tab B: open a *separate* browser context (independent cookies,
    //      independent React tree) and POST decision=approve to /api/approval/<id>.
    //   3. Tab A: assert the card dismisses and the drain completion text
    //      "Done. Two files in /tmp." appears — proving the registry
    //      resolution from B was observed by A's in-flight stream.
    test.setTimeout(30_000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const tabA = await contextA.newPage();
    const tabB = await contextB.newPage();

    try {
      await tabA.goto("/hitl-demo");
      await tabA.getByTestId("start-button").click();

      const cardA = tabA.getByTestId("approval-card");
      await expect(cardA).toBeVisible({ timeout: 15_000 });

      // The approval id is exposed as data-approval-id on the card itself
      // (see packages/react/src/ApprovalCard.tsx:102).
      const approvalId = await cardA.getAttribute("data-approval-id");
      expect(
        approvalId,
        "approval card must expose data-approval-id"
      ).toBeTruthy();

      // Tab B does NOT call any HITL setup. It just POSTs the decision via
      // the API. The shared global registry should accept the resolution.
      const resolveFromB = await tabB.request.post(
        `/api/approval/${approvalId}`,
        {
          data: { decision: "approve" },
        }
      );
      expect(resolveFromB.status()).toBe(200);

      // Tab A's *stream* observes the resolution and drains: the trailing
      // text-delta after the gated tool reaches A's React tree.
      await expect(tabA.getByTestId("ai-msg").last()).toContainText(
        "Done. Two files in /tmp.",
        { timeout: 30_000 }
      );

      // NOTE on tab A's card visibility: today's hitl-demo only dismisses the
      // card when its own ApprovalCard buttons fire (see hitl-demo/page.tsx
      // dismiss handlers). A cross-tab resolution doesn't sync the local
      // card UI — that's a known UX limitation. This test deliberately does
      // NOT assert on cardA's final visibility so a future UX fix (e.g.
      // dismissing the card when the stream observes the resolution) won't
      // be a regression.

      // The respond-status controller in tab A was NOT used to resolve this
      // approval (tab B did it via raw API), so it stays at its initial value
      // — proving the resolution path went through the registry, not tab A's
      // ApprovalCard controller.
      await expect(tabA.getByTestId("respond-status")).toHaveText(
        /Respond status: idle/i
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Cross-tab parity for the OTHER three decision modes. Each tests the same
  // contract (B resolves via API → A's stream observes the drain) but with
  // a different decision and a different drain effect.
  // -------------------------------------------------------------------------
  for (const scenario of [
    {
      decision: "reject" as const,
      payload: undefined,
      // Reject emits a data-error frame; the hitl-demo page surfaces it via
      // the error-msg testid. Note that the backend mock's text-delta frames
      // AFTER the tool stage still pass through (the gate only drops the
      // buffered tool frames, not subsequent unrelated text) — so we
      // intentionally don't assert their absence here.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("error-msg")).toContainText(/rejected/i, {
          timeout: 30_000,
        });
      },
    },
    {
      decision: "edit" as const,
      payload: { editedInput: { command: "ls -la /var" } },
      // Edit drains like approve — the trailing text-delta arrives.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("ai-msg").last()).toContainText(
          "Done. Two files in /tmp.",
          { timeout: 30_000 }
        );
      },
    },
    {
      decision: "respond" as const,
      payload: { response: "use grep -r instead — safer" },
      // Respond emits a data-human-response carrying the user's reply; the
      // hitl-demo page surfaces it via the human-response testid.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("human-response")).toContainText(
          "use grep -r instead — safer",
          { timeout: 30_000 }
        );
      },
    },
  ]) {
    test(`cross-tab: ${scenario.decision} from tab B is observed by tab A's stream`, async ({
      browser,
    }) => {
      // Budget = setup (≤15s for the card to appear) + assertOnA's own 30s
      // wait for the cross-tab frame. The old 30s cap couldn't fit both, so
      // WebKit's slower cold-start fetch streaming tripped the ceiling even
      // though the single-tab equivalents pass in ~6s. Use the 60s global.
      test.setTimeout(60_000);
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const tabA = await contextA.newPage();
      const tabB = await contextB.newPage();

      try {
        await tabA.goto("/hitl-demo");
        await tabA.getByTestId("start-button").click();
        const cardA = tabA.getByTestId("approval-card");
        await expect(cardA).toBeVisible({ timeout: 15_000 });

        const approvalId = await cardA.getAttribute("data-approval-id");
        expect(approvalId).toBeTruthy();

        const resolve = await tabB.request.post(`/api/approval/${approvalId}`, {
          data: { decision: scenario.decision, ...scenario.payload },
        });
        expect(
          resolve.status(),
          `cross-tab ${scenario.decision} must return 200`
        ).toBe(200);

        await scenario.assertOnA(tabA);
      } finally {
        await contextA.close();
        await contextB.close();
      }
    });
  }

  test("cross-tab isolation: two tabs of /hitl-demo create independent sessions and approvals", async ({
    browser,
  }) => {
    // Each /hitl-demo page mounts a fresh sessionId per useState init
    // (apps/example/app/hitl-demo/page.tsx:47). Two tabs must therefore
    // produce two *different* approval entries in the registry — neither
    // tab should see the other tab's card.
    // Two back-to-back 15s card waits sit right at a 30s ceiling; WebKit
    // cold-start can tip it over. Use the 60s global budget for headroom.
    test.setTimeout(60_000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const tabA = await contextA.newPage();
    const tabB = await contextB.newPage();

    try {
      await Promise.all([tabA.goto("/hitl-demo"), tabB.goto("/hitl-demo")]);
      await Promise.all([
        tabA.getByTestId("start-button").click(),
        tabB.getByTestId("start-button").click(),
      ]);

      await expect(tabA.getByTestId("approval-card")).toBeVisible({
        timeout: 15_000,
      });
      await expect(tabB.getByTestId("approval-card")).toBeVisible({
        timeout: 15_000,
      });

      const idA = await tabA
        .getByTestId("approval-card")
        .getAttribute("data-approval-id");
      const idB = await tabB
        .getByTestId("approval-card")
        .getAttribute("data-approval-id");

      expect(idA).toBeTruthy();
      expect(idB).toBeTruthy();
      expect(idA).not.toBe(idB);

      // Approve in A — must NOT affect B's card.
      await tabA.getByTestId("approve-button").click();
      await expect(tabA.getByTestId("approval-card")).toBeHidden({
        timeout: 10_000,
      });
      // B's card stays visible — its own approval is still waiting.
      await expect(tabB.getByTestId("approval-card")).toBeVisible();
      await expect(tabB.getByTestId("approval-status")).toHaveText("waiting");

      // Clean up B by approving it too.
      await tabB.getByTestId("approve-button").click();
      await expect(tabB.getByTestId("approval-card")).toBeHidden({
        timeout: 10_000,
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Route-handler behavior with an `Origin` header. SCOPE NOTE — these are
  // NOT real CSRF tests. Playwright's `request.post` doesn't trigger a
  // browser's CORS preflight or same-origin policy, so what we're proving
  // is that the Next.js route handler itself does not gate on the `Origin`
  // request header. The unprotected route is documented as fail-open
  // ("production deployments should wire authorize against their
  // session/API-key system"). The protected variant gates on Bearer
  // presence only, regardless of origin. Pinning both contracts here so a
  // future silent change to either (e.g. an origin-allowlist) gets caught
  // as a deliberate decision rather than a regression. A real browser-CSRF
  // test would need to load evil.example.com in another browser context
  // and observe whether the browser blocks the request — out of scope.
  // -------------------------------------------------------------------------
  test("route handler: unprotected /api/approval/[id] accepts a POST with Origin: evil.example.com (documented fail-open contract — NOT a browser CSRF test)", async ({
    request,
  }) => {
    // We don't need a real approval — the open route's lookup-then-resolve
    // path returns 404 for an unknown id. The point is that the request
    // wasn't rejected upstream of the registry on the basis of Origin.
    const response = await request.post(
      "/api/approval/nonexistent-cross-origin-id",
      {
        data: { decision: "approve" },
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://evil.example.com/exploit",
        },
      }
    );
    // 404 (registry miss) — NOT 403 or 401, which would indicate an
    // unannounced origin/CSRF rejection layer that production code might
    // rely on. If this assertion ever fails as 403, the demo route changed
    // its security model and dependent consumers need to know.
    expect(
      response.status(),
      "unprotected route is documented as fail-open — a 403 would indicate a silent security tightening"
    ).toBe(404);
  });

  test("route handler: protected /api/approval-protected/[id] rejects POST without Bearer (401) — gate is auth-based, not origin-based", async ({
    request,
  }) => {
    // The protected route's authorize callback gates on Bearer presence
    // — not on origin. A missing Bearer is 401 whether the request came
    // from the app's own origin or evil.com. This pins that the protection
    // mechanism is auth-based, not origin-based, so a future origin-based
    // check would be a deliberate change (caught here).
    const response = await request.post(
      "/api/approval-protected/nonexistent-cross-origin-id",
      {
        data: { decision: "approve" },
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://evil.example.com/exploit",
        },
        // Deliberately NO Authorization header.
      }
    );
    expect(response.status()).toBe(401);
  });
});
