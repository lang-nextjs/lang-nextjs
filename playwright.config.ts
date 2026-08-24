import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for E2E tests against real DeepAgents backends.
 *
 * Two independent base URLs — keep them straight, because conflating them is
 * exactly how the open-swe projects silently drifted onto the example app:
 *
 * PLAYWRIGHT_BASE_URL: override default base URL for the example-app projects
 * (used by CI jobs to target compose-started frontend containers on ports
 * 3001 or 3002). Defaults to http://localhost:3000 for local dev.
 *
 * PLAYWRIGHT_OPENSWE_URL: override base URL for the projects that target the
 * *open-swe* app — `open-swe`, `open-swe-dashboard`, `chromium-sandbox`.
 * Defaults to http://localhost:3001, matching apps/open-swe's own dev/start
 * default and the port allocation in .github/workflows/e2e.yml.
 *
 * The two apps overlap on `/` and `/api/open-swe/runs*`, so pointing an
 * open-swe project at :3000 does NOT fail loudly — the example app answers
 * and the mocks attach to the wrong server. Do not "simplify" these to one
 * variable.
 *
 * Browser matrix — engine-compatibility coverage on the user-facing
 * specs. Chromium runs the full suite; webkit/firefox/mobile-chrome
 * run the cross-browser subset below. Per-test `test.skip` annotations
 * inside the specs (search for `browserName ===`) carve out engine-
 * specific known limitations with documented justifications:
 *
 *   - WebKit multi-interrupt (hitl.spec.ts): the SECOND mid-stream data-*
 *     part does not surface until the stream ends, under WebKit only.
 *     Measured, not inferred: raw fetch (no AI SDK, no React) delivers
 *     the frame at 4.02s on BOTH chromium and webkit, so the network
 *     layer is not buffering — the gap is between bytes reaching JS and
 *     React rendering. Firefox passes in 8.9s, so this is WebKit-specific
 *     rather than non-chromium. NO upstream issue has ever been filed;
 *     an earlier comment cited a vercel/ai/issues/TBD URL that never
 *     existed. Do not add a link until there is a real one.
 *   - Mobile-Chrome adapter swap (e2e/matrix/adapter-selection.spec.ts):
 *     the multi-iteration adapter-swap test exceeds the 60s timeout on
 *     Pixel 7's throttled CPU. Skipped there via test.skip() inside the
 *     spec; covered by chromium-matrix instead. (Was E2E-04 in
 *     nextjs.spec.ts before the #14 split.)
 */
const CROSS_BROWSER_TESTMATCH = [
  /shared\/nextjs\.spec\.ts/,
  /shared\/reconnect\.spec\.ts/,
  /shared\/deepagents-cards\.spec\.ts/,
  /shared\/shared-cards\.spec\.ts/,
  /hitl\.spec\.ts/,
];

/**
 * TREE LAYOUT — the directory a spec lives in declares its eject semantics
 * (#14). Classification is by BEHAVIOUR, not by whether the filename or body
 * happens to name a rung:
 *
 *   e2e/rungs/<rung>/   exercises that rung's own surfaces. Travels with the
 *                       rung and is deleted by `pnpm eject <other>`.
 *   e2e/matrix/         drives the rung/topology selectors and needs >= 2
 *                       rungs present. CANNOT survive any single-rung eject.
 *   e2e/shared/         SDK, transport and app-shell coverage. Passes with any
 *                       one rung installed, or none.
 *
 * Note that `remix.spec.ts` and `sveltekit.spec.ts` are SHARED despite naming
 * "deepagents" repeatedly — those hits are the `@deepagents-nextjs/*` package
 * scope (the SDK), not the DeepAgents rung. Both mock the stream end-to-end
 * and exercise no rung at all.
 *
 * `e2e/accessibility.spec.ts` and `e2e/hitl.spec.ts` are still at the root:
 * they were in flight in another branch during the split and move to
 * e2e/shared/ in a follow-up. The patterns below match them at either path.
 *
 * `chromium-matrix` is deliberately its own project rather than folded into
 * `chromium`: after `pnpm eject <rung>` the whole e2e/matrix/ tree is
 * gone, and a project that then matches zero files must be REMOVED from this
 * config, not left silently empty. Keeping it separate makes that a visible
 * config deletion instead of a no-op.
 */

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      // Rung-agnostic: SDK, transport, app shell.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: [
        /shared\/nextjs\.spec\.ts/,
        /shared\/nextjs-extra\.spec\.ts/,
        /shared\/reconnect\.spec\.ts/,
        /shared\/chat\.spec\.ts/,
        /shared\/deepagents-cards\.spec\.ts/,
        /shared\/shared-cards\.spec\.ts/,
        /shared\/library-cards\.spec\.ts/,
        /accessibility\.spec\.ts/,
        /hitl\.spec\.ts/,
      ],
    },
    {
      // Cross-rung: needs >= 2 rungs installed. Delete this project on eject.
      name: "chromium-matrix",
      use: { ...devices["Desktop Chrome"] },
      testMatch: [/matrix\//],
    },
    {
      // WebKit (Safari engine) — cross-browser subset, to catch engine
      // differences in EventSource, fetch streaming, and layout.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
    {
      // Mobile Chrome (Pixel 7) — viewport + touch sanity on the composer
      // and cards.
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testMatch: [
        /shared\/nextjs\.spec\.ts/,
        /shared\/deepagents-cards\.spec\.ts/,
        /shared\/shared-cards\.spec\.ts/,
      ],
    },
    {
      name: "open-swe-dashboard",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /rungs\/open-swe\/open-swe-dashboard\.spec\.ts/,
    },
    {
      name: "remix",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_REMIX_URL ?? "http://localhost:5173",
      },
      testMatch: /shared\/remix\.spec\.ts/,
    },
    {
      name: "sveltekit",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_SVELTEKIT_URL ?? "http://localhost:5174",
      },
      testMatch: /shared\/sveltekit\.spec\.ts/,
    },
    {
      name: "open-swe",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /rungs\/open-swe\/open-swe(-narrative)?\.spec\.ts/,
    },
    {
      // Real Docker sandbox E2E — exercises /api/open-swe/sandbox/* against a
      // live Docker daemon. Tests skip themselves when no daemon is reachable.
      name: "chromium-sandbox",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /rungs\/open-swe\/open-swe-sandbox\.spec\.ts/,
    },
    {
      name: "chromium-llm",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /shared\/llm\.spec\.ts/,
    },
    {
      // Visual regression — pinned to a single engine (chromium) since
      // screenshot baselines are engine-specific. CI runs it as its own job.
      name: "visual",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /shared\/visual\.spec\.ts/,
    },
  ],
});
