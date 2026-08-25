import type { Page } from "@playwright/test";

/**
 * Mock for `GET /api/open-swe/runs/[runId]/state` — the endpoint that decides
 * whether the run page streams at all.
 *
 * WHY THIS EXISTS (#22 RC-2). The run page computes:
 *
 *   const isLive = threadStatus === "running" || threadStatus === "pending";
 *   useRunStream({ runId, threadId, enabled: isLive });
 *
 * `threadStatus` comes from `useThreadState`, which fetches `/state`. Specs
 * that mocked only `/stream` left `/state` hitting the real route, which
 * without a backend fails — so `threadStatus` stayed null, `isLive` stayed
 * false, and NO EventSource was ever constructed. Every streaming assertion
 * downstream then failed for a reason that had nothing to do with its subject:
 * the page reported "Status: completed" and rendered no tokens and no tool
 * cards, because it had correctly decided there was nothing live to stream.
 *
 * That is the trap worth naming: those specs were not testing streaming, they
 * were failing before reaching it. Mocking `/state` is what puts the subject
 * back under test.
 *
 * NOTE ON THE MAGIC STRING: `status: "busy"` is deliberate and is NOT a typo
 * for "running". `mapThreadStatus` (apps/open-swe/lib/thread-state.ts) maps the
 * WIRE vocabulary to the UI vocabulary — "busy" -> "running", "idle" ->
 * "completed", and anything unrecognised -> "completed" via the default branch.
 * So mocking the obvious-looking `status: "running"` silently maps to
 * "completed", leaves `isLive` false, and reproduces the exact bug this helper
 * exists to fix. Send what the wire sends.
 */

/** Wire-level payload that makes the page treat the run as live. */
export const BUSY_THREAD_STATE = {
  status: "busy",
  messages: [],
  files: {},
  interrupts: [],
} as const;

/** Wire-level payload for a run that has already finished. */
export const IDLE_THREAD_STATE = {
  status: "idle",
  messages: [],
  files: {},
  interrupts: [],
} as const;

/**
 * Route `/state` to a fixed payload. Defaults to a live ("busy") run, which is
 * what every streaming spec needs in order to reach its own subject.
 */
export async function mockThreadState(
  page: Page,
  body: Record<string, unknown> = BUSY_THREAD_STATE
): Promise<void> {
  await page.route("**/api/open-swe/runs/*/state**", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}
