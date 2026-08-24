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
 *   - WebKit multi-interrupt (hitl.spec.ts): two-card-in-a-row drain
 *     races AI SDK v6's UIMessageStream parser under WebKit's chunked
 *     fetch buffering; investigated but the AI SDK upstream needs a
 *     fix (https://github.com/vercel/ai/issues/TBD). Tracked as v2 work.
 *   - Mobile-Chrome E2E-04 (nextjs.spec.ts): multi-iteration
 *     adapter-swap test exceeds the 60s test timeout on Pixel 7
 *     throttled CPU. Mobile users wouldn't actually swap adapters
 *     this rapidly, so the scenario isn't representative — skipped
 *     on mobile-chrome and covered by chromium instead.
 */
const CROSS_BROWSER_TESTMATCH = [
  /nextjs\.spec\.ts/,
  /reconnect\.spec\.ts/,
  /deepagents-cards\.spec\.ts/,
  /hitl\.spec\.ts/,
];

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
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: [
        /nextjs\.spec\.ts/,
        /nextjs-extra\.spec\.ts/,
        /reconnect\.spec\.ts/,
        /chat\.spec\.ts/,
        /topology\.spec\.ts/,
        /matrix\.spec\.ts/,
        /hitl\.spec\.ts/,
        /deepagents-cards\.spec\.ts/,
        /library-cards\.spec\.ts/,
        /accessibility\.spec\.ts/,
      ],
    },
    {
      // WebKit (Safari engine) — runs the cross-browser subset to catch
      // engine-specific issues (EventSource quirks, fetch streaming
      // differences, layout/CSS rendering).
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
    {
      // Firefox — same cross-browser subset.
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
    {
      // Mobile Chrome (Pixel 7 viewport) — viewport + touch sanity for
      // the chat composer + cards. The single mobile-incompatible test
      // (nextjs E2E-04 adapter-swap, multi-iteration on throttled CPU)
      // is skipped via test.skip() inside the spec with documentation.
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testMatch: [/nextjs\.spec\.ts/, /deepagents-cards\.spec\.ts/],
    },
    {
      name: "open-swe-dashboard",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /open-swe-dashboard\.spec\.ts/,
    },
    {
      name: "remix",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_REMIX_URL ?? "http://localhost:5173",
      },
      testMatch: /remix\.spec\.ts/,
    },
    {
      name: "sveltekit",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_SVELTEKIT_URL ?? "http://localhost:5174",
      },
      testMatch: /sveltekit\.spec\.ts/,
    },
    {
      name: "open-swe",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /open-swe(-narrative)?\.spec\.ts/,
    },
    {
      // Real Docker sandbox E2E — exercises /api/open-swe/sandbox/* against a
      // live Docker daemon. Tests skip themselves when no daemon is reachable.
      name: "chromium-sandbox",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /open-swe-sandbox\.spec\.ts/,
    },
    {
      name: "chromium-llm",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /llm\.spec\.ts/,
    },
    {
      // Visual regression — pinned to a single engine (chromium) since
      // screenshot baselines are engine-specific. Toggle via env to skip
      // locally; CI runs it via a dedicated job.
      name: "visual",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /visual\.spec\.ts/,
    },
  ],
});
