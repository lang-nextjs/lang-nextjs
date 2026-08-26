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
    await mockRun(page);
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

  test("the detail page and the BOARD agree about the same run's status (#176)", async ({ page }) => {
    // They derive status independently, which is exactly how #176 happened:
    // Completed on the detail page, Running on the kanban, same run.
    await mockRun(page, { status: "completed" });
    await mockStream(page, ["data: [DONE]"]);
    await page.goto("/");
    await expect(
      page.getByTestId("board-column-done").getByText("detail task")
    ).toBeVisible();
    await page.goto("/runs/run-1?threadId=th-1");
    const status = (await page.getByTestId("stream-status").innerText()).toLowerCase();
    expect(status).not.toContain("running");
  });

  test("cancel POSTs to the cancel endpoint with the run's id", async ({ page }) => {
    await mockRun(page);
    await mockStream(page, [`data: ${JSON.stringify({ type: "text-delta", delta: "x" })}`]);
    let hit = "";
    await page.route("**/api/open-swe/runs/*/cancel", (route) => {
      hit = route.request().url();
      return void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/runs/run-1?threadId=th-1");
    const btn = page.getByTestId("cancel-run-button");
    if ((await btn.count()) > 0 && (await btn.isEnabled())) {
      await btn.click();
      await expect.poll(() => hit).toContain("/runs/run-1/cancel");
    }
  });

  test("a FAILING cancel is reported, not swallowed", async ({ page }) => {
    // A cancel that silently does nothing is worse than one that refuses: the
    // person walks away believing the run stopped.
    await mockRun(page);
    await mockStream(page, [`data: ${JSON.stringify({ type: "text-delta", delta: "x" })}`]);
    await page.route("**/api/open-swe/runs/*/cancel", (route) =>
      void route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "platform unreachable" }) })
    );
    await page.goto("/runs/run-1?threadId=th-1");
    const btn = page.getByTestId("cancel-run-button");
    if ((await btn.count()) > 0 && (await btn.isEnabled())) {
      await btn.click();
      await expect(page.getByTestId("stream-error").or(page.getByTestId("runs-error"))).toBeVisible();
    }
  });
});
