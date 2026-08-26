import { test, expect, type Page } from "@playwright/test";
import { stageReady } from "./readiness-mock";

/**
 * The RUN DETAIL surface — the page a person opens when they want to know what
 * a run is doing, and the one place a wrong answer is acted on immediately.
 *
 * The existing specs cover streaming text, tool cards and cancel's happy path.
 * These cover the states AROUND those: a run with no thread, a stream that
 * errors, a status that must not read as success, and cancel's effect on what
 * the page then claims.
 *
 * #176 ("a run shows Completed on its detail page and Running on the kanban")
 * is the reason this surface gets its own file: the detail page and the board
 * derive status independently, so agreeing is a property, not a given.
 */

const SSE = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } as const;

async function mockRun(page: Page, over: Record<string, unknown> = {}) {
  const body = {
    run_id: "run-1",
    thread_id: "th-1",
    status: "running",
    task: "detail task",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
  await page.route("**/api/open-swe/runs/run-1", (route) =>
    void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  );
  await page.route("**/api/open-swe/runs", (route) =>
    route.request().method() === "GET"
      ? void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([body]) })
      : void route.fallback()
  );
}

async function mockStream(page: Page, events: string[]) {
  await page.route("**/api/open-swe/runs/*/stream**", (route) =>
    void route.fulfill({ status: 200, headers: SSE, body: events.join("\n\n") + "\n\n" })
  );
}

/**
 * Thread state — the endpoint that decides whether the page renders LIVE.
 *
 * `isLive` comes from /runs/<id>/state, NOT from the run-list entry, and the
 * cancel button lives inside the live branch. Mocking only the run list left
 * this fetch unmocked, so the page never went live and the button never
 * existed. Both cancel cases then took their existence guard and passed
 * having clicked nothing. Stubbing this is what makes them real tests.
 *
 * THE STATUS WORD IS "busy", NOT "running". The two surfaces do not share a
 * vocabulary: the run LIST reports running/pending/completed/failed, while
 * the thread STATE reports LangGraph's busy/idle/error, and mapThreadStatus
 * deliberately answers "unknown" for anything outside that set rather than
 * guessing (#176). Sending the list's word to the state endpoint produced
 * `unknown`, which is not live — so the page rendered its non-live branch
 * and the button stayed absent. The refusal to guess is correct; the mock
 * was wrong, and a mock speaking the wrong dialect is invisible until
 * something downstream insists on the real one.
 */
async function mockThreadState(page: Page, status = "busy") {
  await page.route("**/api/open-swe/runs/*/state**", (route) =>
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status, messages: [], files: {}, interrupts: [] }),
    })
  );
}

/**
 * A stream that never responds.
 *
 * The cancel button exists only while `canCancel` — that is, while the stream
 * status is "connecting" or "streaming". A mock that fulfils immediately closes
 * the stream, the status goes to "done", and the button unmounts. The first
 * version of the two cancel cases handled that by testing for the button and
 * skipping the body when it was gone: a test that passes green having clicked
 * nothing, which is worse than no test because it occupies the slot.
 *
 * Leaving the route unfulfilled holds the status at "connecting", so the button
 * is reliably present and the assertions can be unconditional.
 */
async function mockStreamHanging(page: Page) {
  await page.route("**/api/open-swe/runs/*/stream**", () => {
    /* deliberately never fulfilled — the request stays open */
  });
}

test.describe("open-swe run detail — the states around the happy path", () => {
  test.beforeEach(async ({ page }) => {
    await stageReady(page);
  });

  test("a run with NO threadId says so rather than streaming nothing", async ({ page }) => {
    // Without a thread there is nothing to subscribe to. A page that renders an
    // empty transcript is indistinguishable from a run that has produced no
    // output yet — one is a defect, the other is normal, and the difference
    // decides whether anybody investigates.
    await mockRun(page, { thread_id: null });
    await page.goto("/runs/run-1?threadId=");
    await expect(page.getByTestId("missing-thread-id")).toBeVisible();
  });

  test("a stream that ERRORS surfaces the error, not a silent stall", async ({ page }) => {
    // THE STATE STUB IS THE POINT OF THIS EDIT. `stream-error` renders off the
    // THREAD STATE fetch, not the stream fetch, and this case used to leave
    // /state unmocked — so it depended on that call failing for a reason the
    // test never stated. In CI, where the mocked job runs no backend, it failed
    // and the test passed. On a machine with the backend up it returns 200,
    // there is no error to render, and the case fails while nothing is wrong.
    //
    // A test whose precondition is "whatever this machine happens to be" is a
    // test that reports on the machine. Stated explicitly, it reports on the app.
    await mockRun(page);
    await page.route("**/api/open-swe/runs/*/state**", (route) =>
      void route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    );
    await page.route("**/api/open-swe/runs/*/stream**", (route) =>
      void route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    );
    await page.goto("/runs/run-1?threadId=th-1");
    await expect(page.getByTestId("stream-error")).toBeVisible();
  });

  test("stream-status is rendered and is NOT blank", async ({ page }) => {
    // The status element is how a person tells "working" from "finished" from
    // "broken". An element that exists and says nothing is the blinking-caret
    // problem one layer up.
    await mockRun(page);
    await mockStream(page, [`data: ${JSON.stringify({ type: "text-delta", delta: "hi" })}`, "data: [DONE]"]);
    await page.goto("/runs/run-1?threadId=th-1");
    await expect(page.getByTestId("stream-status")).toBeVisible();
    expect((await page.getByTestId("stream-status").innerText()).trim().length).toBeGreaterThan(0);
  });

  /*
   * TWO CASES DELIBERATELY NOT WRITTEN HERE, and the reason is a seam limit
   * rather than a gap worth leaving quiet.
   *
   * "text deltas accumulate" and "a malformed frame does not kill the stream"
   * both need `agent-text`, which renders only when `streamText` is truthy. With
   * `route.fulfill()` the whole SSE body arrives instantly, so EventSource
   * processes every event and transitions to error before React renders — the
   * limitation open-swe-dashboard.spec.ts records in its own header:
   *
   *   "cannot be tested with route.fulfill() because it sends the complete body
   *    instantly... That scenario is covered by the component unit tests instead."
   *
   * I wrote both, watched them fail for that reason rather than for the property
   * they name, and removed them. A test that fails because the harness cannot
   * stage the state is not evidence about the app, and one edited until it
   * passes anyway would be asserting whatever the harness DOES produce — which
   * is how a test ends up with a subject nobody chose.
   *
   * Testing them properly needs a chunked SSE mock that yields between frames.
   * Worth doing; not worth faking.
   */

  /**
   * THIS CASE WAS VACUOUS, AND IT WAS REPORTED FROM A RUNNING BOARD.
   *
   * The previous version named agreement and asserted something else. Three
   * defects in eleven lines, each enough on its own:
   *
   *   1. It never mocked /state, so the detail page's status came from an
   *      UNMOCKED endpoint. In CI, where the mocked job runs no backend, that
   *      fetch fails — so the assertion passed because the call failed, not
   *      because the two surfaces agreed.
   *   2. `expect(status).not.toContain("running")` is satisfied by "idle",
   *      "unknown", "error" and a blank string. The exact production failure —
   *      board says Running, detail says idle — PASSED it.
   *   3. It compared nothing. It set the list to "completed" and checked the
   *      detail was not "running". "Agree" and "one of them is not running"
   *      are different claims, and only one of them was tested.
   *
   * The real board showed seventeen runs as Running, some a day old, while
   * every one of their threads reported `idle`. This is now driven by that
   * exact shape rather than by two mocks I chose to agree with each other.
   *
   * EXPECTED TO FAIL — filed as #246. The two surfaces read different sources:
   * the board takes the LATEST RUN's status, the detail page takes the THREAD's.
   * An orphaned run — recorded running, thread gone idle — makes the board
   * claim work is executing that stopped hours ago.
   */
  test("the detail page and the BOARD agree about the same run's status (#176)", async ({ page }) => {
    test.fail();
    // The production shape, not a pair of mocks chosen to match: the run record
    // says running, the thread says idle.
    await mockRun(page, { status: "running" });
    await page.route("**/api/open-swe/runs/*/state**", (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "idle", messages: [], files: {}, interrupts: [] }),
      })
    );
    await mockStream(page, ["data: [DONE]"]);

    await page.goto("/");
    // WAIT, then assert UNCONDITIONALLY. Two mistakes were made here in one
    // sitting and both are worth naming. The first version read the column
    // immediately after goto, measuring first paint, where every column is
    // legitimately empty. The second wrapped the real assertion in
    // `if (onBoard > 0)` — so the empty first paint made the guard false and
    // the assertion never ran at all. A guard around the only assertion in a
    // test is not caution; it is a way for the test to pass having checked
    // nothing, which is the defect this whole file exists to avoid.
    await expect(
      page.getByTestId("board-column-in-progress").getByText("detail task")
    ).toBeVisible();

    await page.goto("/runs/run-1?threadId=th-1");
    // SETTLE BEFORE READING. `stream-status` renders "Status: loading" until the
    // thread state resolves, and a negative assertion is trivially true against
    // a placeholder. Reading it straight after goto measured "loading" and the
    // contradiction check passed on a value that was not an answer yet — the
    // third time in this one test that a too-early read produced a green result
    // about nothing.
    const status = page.getByTestId("stream-status");
    await expect(status).not.toContainText(/loading/i);
    const detail = (await status.innerText()).toLowerCase();

    // The assertion the name promises. The board has filed this run under work
    // in progress; the detail page must not simultaneously report that it
    // stopped.
    expect(
      detail,
      "the board shows this run as in progress, so the detail page must not contradict it"
    ).not.toMatch(/idle|completed|done/);
  });

  test("cancel POSTs to the cancel endpoint with the run's id", async ({ page }) => {
    await mockRun(page);
    await mockThreadState(page);
    await mockStreamHanging(page);
    let hit = "";
    await page.route("**/api/open-swe/runs/*/cancel", (route) => {
      hit = route.request().url();
      return void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/runs/run-1?threadId=th-1");
    const btn = page.getByTestId("cancel-run-button");
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(() => hit).toContain("/runs/run-1/cancel");
  });

  test("a FAILING cancel is reported, not swallowed", async ({ page }) => {
    // FIXED (#236). A cancel the platform REJECTED (502) rendered as "Live
    // stream ended. Load result" beside "Agent is working…", with the status
    // code and message discarded — and, worse, `cancel` closed the EventSource
    // BEFORE the fetch, so the local stream died whatever the platform said.
    // The run carried on executing while the page showed nothing and never
    // reconnected. The person was told it stopped, and it had not.
    //
    // The assertion below is unchanged apart from the locator, which now also
    // accepts `cancel-error`. That is not a weakening: `stream-error` sits on
    // the THREAD-STATE failure, and routing a refused cancel through the same
    // channel is the bug. A separate id is what keeps them distinguishable.
    // A cancel that silently does nothing is worse than one that refuses: the
    // person walks away believing the run stopped.
    await mockRun(page);
    await mockThreadState(page);
    await mockStreamHanging(page);
    await page.route("**/api/open-swe/runs/*/cancel", (route) =>
      void route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "platform unreachable" }) })
    );
    await page.goto("/runs/run-1?threadId=th-1");
    const btn = page.getByTestId("cancel-run-button");
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(
      page
        .getByTestId("cancel-error")
        .or(page.getByTestId("stream-error"))
        .or(page.getByTestId("runs-error"))
    ).toBeVisible();

    // NOT JUST "AN ERROR APPEARED". The reported failure was a message that
    // said the wrong thing, so a test satisfied by any visible error would
    // have passed against it. These pin the two facts a person needs.
    const banner = page.getByTestId("cancel-error");
    await expect(banner).toContainText("502");
    await expect(banner).toContainText("platform unreachable");

    // THE PAGE IS NOT IN A TERMINAL STATE: the button is back, so the run is
    // still presented as live and the person can try again.
    //
    // WHAT THIS DOES NOT PROVE, stated because the first version of this
    // comment claimed it did. The severe half of #236 was the teardown — the
    // EventSource was closed BEFORE the platform answered — and this assertion
    // cannot see that. Measured: reinstating the early `close()` leaves this
    // test green while three unit tests go red. The button returns either way,
    // because the status is restored either way.
    //
    // It is not fixable here with these tools: `route.fulfill` sends a body in
    // one shot, so a mocked SSE stream cannot push an event AFTER the cancel,
    // which is the only way a browser could notice the socket was gone. The
    // teardown ordering is owned by useRunStream.test.ts, which asserts the
    // close spy directly.
    await expect(page.getByTestId("cancel-run-button")).toBeVisible();
  });
});
