import type { Page } from "@playwright/test";

/**
 * Stage a READY queue surface, so a spec can exercise submission at all.
 *
 * WHY THIS EXISTS. #124 (PR #196) made the Start-run button honest:
 *
 *     disabled={submitting || !task.trim() || !canSend(readiness)}
 *     // canSend() requires `ready` — `unknown` does not qualify, which is
 *     // deliberate: submitting into an unverified environment is how the
 *     // PO's 429s became invisible in the first place.
 *
 * Before that, the button was always enabled and the queue rendered a hardcoded
 * `local · langgraph dev` — a status-shaped element reporting a verdict nothing
 * computed. Specs written against that shape assumed the button was live without
 * establishing why, and after #196 they fail with `expected enabled, received
 * disabled`. The app is MORE correct; the specs encoded the old behaviour.
 *
 * So this is not a workaround for a gate — it is the setup that gate always
 * needed and never had. A spec about submission failures must first arrange for
 * submission to be possible, and say so.
 *
 * DELIBERATELY NOT A GLOBAL FIXTURE. Staging readiness everywhere would make
 * `unknown` unreachable in tests, which is the state #124 exists to distinguish —
 * open-swe-chat-settings.spec.ts keeps its own granular stubs precisely so it can
 * stage NOT-ready cases (stalled probe, absent key, dead sandbox). Opt in per
 * spec that needs a live queue; never by default.
 */
export async function stageReady(page: Page): Promise<void> {
  // `ready` requires llmConfigured === true AND (sandboxRequired -> available).
  // Anything null leaves readiness `unknown`, which does not enable the button.
  await page.route(
    // `config*`, NOT `config` — the trailing star matches the query string (#333).
    //
    // /chat asks `/api/config?runtime=<django|fastapi>` so the answer can name the runtime it
    // is about. Playwright's glob is matched against the FULL url including the search, so
    // `**/api/config` stopped intercepting the moment that parameter appeared — and the specs
    // did not go red locally, because the page fell through to the REAL route and a backend
    // happened to be listening on :8001. In CI, where nothing is, 59 open-swe specs failed
    // with a disabled composer.
    //
    // The star also matches the bare URL, so this stays correct if the parameter is ever
    // removed. Prefer it for any endpoint that might grow one.
    "**/api/config*",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          activeLlm: "nvidia",
          backends: { django: true, fastapi: true },
        }),
      })
  );
  await page.route(
    "**/api/open-swe/sandbox/health",
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: true, provider: "docker" }),
      })
  );
}
