import { test, expect, type Page } from "@playwright/test";

/**
 * THE TOOL-CALL STATE MACHINE, DRIVEN BY ADVERSARIAL FRAME ORDERS.
 *
 * Existing coverage renders tool calls the way a well-behaved backend emits
 * them: input-start, input-available, output-available, in that order. What is
 * not covered is what `useToolState` was actually WRITTEN for — its own comment
 * says "use two passes to handle out-of-order events" — and every branch of that
 * reconciliation is reachable only by sending frames in an order no happy-path
 * test produces.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A tool card is how a person knows what
 * the agent did to their repository. The failure modes here are not blank
 * screens: they are a card stuck on "pending" for a tool that finished, a
 * completed card whose output belongs to a different call, or two calls
 * collapsing into one. Each renders a confident, plausible, wrong account of
 * what happened — and none of them looks broken.
 *
 * These drive the REAL render path (SSE -> hook -> ToolCard) rather than calling
 * the reducer directly, because the reconciliation only matters if it survives
 * the round trip to the DOM.
 */

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

const f = {
  start: (id: string, name: string) =>
    `data: {"type":"tool-input-start","toolCallId":"${id}","toolName":"${name}"}`,
  input: (id: string, name: string, input: unknown) =>
    `data: {"type":"tool-input-available","toolCallId":"${id}","toolName":"${name}","input":${JSON.stringify(
      input
    )}}`,
  output: (id: string, output: unknown) =>
    `data: {"type":"tool-output-available","toolCallId":"${id}","output":${JSON.stringify(
      output
    )}}`,
  finish: () => `data: {"type":"finish","finishReason":"stop"}`,
};

async function mockThreadState(page: Page, status = "busy"): Promise<void> {
  await page.route(
    "**/api/open-swe/runs/*/state**",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status,
          messages: [],
          files: {},
          interrupts: [],
        }),
      })
  );
}

/** Serve exactly these frames, in exactly this order, then close. */
async function streamFrames(page: Page, frames: string[]): Promise<void> {
  await page.route(
    "**/api/open-swe/runs/*/stream**",
    (route) =>
      void route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: frames.join("\n\n") + "\n\n",
      })
  );
}

async function openRun(page: Page): Promise<void> {
  await page.goto("/runs/run-tools?threadId=t1");
  await expect(page.getByTestId("agent-narrative")).toBeVisible({
    timeout: 15_000,
  });
}

const cards = (page: Page) => page.getByTestId("tool-card");

test.describe("tool calls — reconciliation under out-of-order frames", () => {
  test("THE OUT-OF-ORDER CASE: output before input still completes, with the output", async ({
    page,
  }) => {
    // The branch `pendingOutputs` exists for. A hook that simply ignored an
    // output with no matching input would render a card stuck on pending — a
    // tool that finished, shown as still running, forever.
    await mockThreadState(page);
    await streamFrames(page, [
      f.output("tc-1", { counter: 7 }),
      f.start("tc-1", "increment"),
      f.finish(),
    ]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId("tool-status")).toContainText(/complete/i);
  });

  test("out-of-order via input-AVAILABLE (not input-start) also completes", async ({
    page,
  }) => {
    // The same reconciliation on the other entry point. `tool-input-available`
    // has its own create-if-missing branch, and it is the one a backend that
    // never emits input-start would take.
    await mockThreadState(page);
    await streamFrames(page, [
      f.output("tc-1", { ok: true }),
      f.input("tc-1", "read_file", { path: "/a" }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId("tool-status")).toContainText(/complete/i);
  });

  test("the reconciled card carries the OUTPUT, not just the completed status", async ({
    page,
  }) => {
    // Status and payload are separate claims. A card can say "completed" while
    // having dropped the output it is completing with, and the status alone
    // would still read as correct.
    await mockThreadState(page);
    await streamFrames(page, [
      f.output("tc-1", { counter: 99 }),
      f.input("tc-1", "increment", { amount: 1 }),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-output")).toContainText("99");
  });

  test("and the reconciled card carries the INPUT that arrived late", async ({
    page,
  }) => {
    await mockThreadState(page);
    await streamFrames(page, [
      f.output("tc-1", { ok: true }),
      f.input("tc-1", "read_file", { path: "/etc/hosts" }),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-input")).toContainText("/etc/hosts");
  });

  test("a tool that never produces output stays PENDING, not completed", async ({
    page,
  }) => {
    // The direction that matters. Rendering an unfinished tool as completed
    // tells a person the agent finished touching their files when it did not.
    await mockThreadState(page);
    await streamFrames(page, [f.start("tc-1", "write_file"), f.finish()]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId("tool-status")).not.toContainText(
      /complete/i
    );
  });

  test("a DUPLICATE output does not overwrite the completed call", async ({
    page,
  }) => {
    // The hook ignores a second output-available on purpose. A retrying backend
    // that re-sends a stale output would otherwise rewrite history — the card
    // would show an older result than the one already displayed.
    await mockThreadState(page);
    await streamFrames(page, [
      f.start("tc-1", "increment"),
      f.output("tc-1", { counter: 7 }),
      f.output("tc-1", { counter: 1 }),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-output")).toContainText("7");
    await expect(page.getByTestId("tool-output")).not.toContainText("1}");
  });

  test("input-available UPDATES the input without losing the output", async ({
    page,
  }) => {
    // The spread-and-override branch. Overwriting the whole entry here would
    // silently drop a result that had already arrived.
    await mockThreadState(page);
    await streamFrames(page, [
      f.start("tc-1", "increment"),
      f.output("tc-1", { counter: 5 }),
      f.input("tc-1", "increment", { amount: 3 }),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-input")).toContainText("3");
    await expect(page.getByTestId("tool-output")).toContainText("5");
  });
});

test.describe("tool calls — identity and isolation", () => {
  test("two tool calls render as TWO cards, not one", async ({ page }) => {
    // Keyed by toolCallId. Collapsing two calls into one card would hide an
    // entire action the agent took.
    await mockThreadState(page);
    await streamFrames(page, [
      f.start("tc-1", "read_file"),
      f.start("tc-2", "write_file"),
      f.output("tc-1", { ok: 1 }),
      f.output("tc-2", { ok: 2 }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(2);
  });

  test("INTERLEAVED calls each get their own output", async ({ page }) => {
    // The case that a single shared "last output" variable passes for one call
    // and gets wrong for two. Both cards say completed either way; only the
    // payloads distinguish a correct implementation from a lucky one.
    await mockThreadState(page);
    await streamFrames(page, [
      f.start("tc-1", "read_file"),
      f.start("tc-2", "write_file"),
      f.output("tc-2", { wrote: "second" }),
      f.output("tc-1", { read: "first" }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(2);
    for (const toggle of await page.getByTestId("expand-toggle").all()) {
      await toggle.click();
    }
    const byName = (n: string) =>
      cards(page).filter({ has: page.getByTestId("tool-name").getByText(n) });
    await expect(byName("read_file").getByTestId("tool-output")).toContainText(
      "first"
    );
    await expect(byName("write_file").getByTestId("tool-output")).toContainText(
      "second"
    );
  });

  test("each card is labelled with its OWN tool name", async ({ page }) => {
    await mockThreadState(page);
    await streamFrames(page, [
      f.start("tc-1", "read_file"),
      f.start("tc-2", "write_file"),
      f.finish(),
    ]);
    await openRun(page);
    const names = await page.getByTestId("tool-name").allInnerTexts();
    expect(names.sort()).toEqual(["read_file", "write_file"]);
  });

  test("a repeated tool NAME under different ids stays two calls", async ({
    page,
  }) => {
    // An agent reading two files calls read_file twice. Keying by name rather
    // than id would merge them and lose one of the reads.
    await mockThreadState(page);
    await streamFrames(page, [
      f.input("tc-1", "read_file", { path: "/a" }),
      f.input("tc-2", "read_file", { path: "/b" }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(cards(page)).toHaveCount(2);
  });

  test("an output for an id that NEVER gets an input renders no card", async ({
    page,
  }) => {
    // It stays parked in pendingOutputs. Inventing a card for it would show a
    // tool call with no name and no input — an action attributed to nothing.
    //
    // NOT anchored on `agent-narrative` like its neighbours: with nothing but an
    // orphan output there is nothing to narrate, so that element never appears.
    // Waiting for it here would fail on the app behaving correctly. The stream
    // status is the right settle signal — it is rendered either way, so "no
    // cards" is measured on a page that has finished rather than one that has
    // not started, which is the difference between this case and a vacuous one.
    await mockThreadState(page);
    await streamFrames(page, [f.output("ghost", { x: 1 }), f.finish()]);
    await page.goto("/runs/run-tools?threadId=t1");
    await expect(page.getByTestId("stream-status")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("stream-status")).not.toContainText(
      /connecting/i
    );
    await expect(cards(page)).toHaveCount(0);
  });
});

test.describe("tool calls — payload rendering", () => {
  test("the payload is COLLAPSED until asked for", async ({ page }) => {
    await mockThreadState(page);
    await streamFrames(page, [
      f.input("tc-1", "read_file", { path: "/a" }),
      f.output("tc-1", { ok: true }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(page.getByTestId("tool-payload")).toHaveCount(0);
  });

  test("an EMPTY input object still renders a card with its name", async ({
    page,
  }) => {
    // `get_counter` takes no arguments. An implementation that treated a falsy
    // input as "no tool call" would drop every zero-argument tool.
    await mockThreadState(page);
    await streamFrames(page, [
      f.input("tc-1", "get_counter", {}),
      f.output("tc-1", { counter: 3 }),
      f.finish(),
    ]);
    await openRun(page);
    await expect(page.getByTestId("tool-name")).toContainText("get_counter");
  });

  test("a NESTED input payload survives to the DOM intact", async ({
    page,
  }) => {
    // Shallow serialisation is the failure this catches: a card that shows
    // [object Object] where the arguments were.
    await mockThreadState(page);
    await streamFrames(page, [
      f.input("tc-1", "apply_patch", {
        edits: [{ path: "/src/a.ts", replace: "deep-value" }],
      }),
      f.output("tc-1", { ok: true }),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-input")).toContainText("deep-value");
    await expect(page.getByTestId("tool-input")).not.toContainText(
      "[object Object]"
    );
  });

  test("a STRING output renders as itself, not as JSON noise", async ({
    page,
  }) => {
    await mockThreadState(page);
    await streamFrames(page, [
      f.input("tc-1", "read_file", { path: "/a" }),
      f.output("tc-1", "plain text result"),
      f.finish(),
    ]);
    await openRun(page);
    await page.getByTestId("expand-toggle").first().click();
    await expect(page.getByTestId("tool-output")).toContainText(
      "plain text result"
    );
  });
});
