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

  /*
   * A MISSING SNAPSHOT IS AN ERROR, NOT A REQUEST TO CREATE ONE.
   *
   * Playwright's default is `updateSnapshots: "missing"`, which writes a
   * baseline when none exists. That produces a failure mode with a very short
   * half-life, measured on this repo:
   *
   *   run 1  "A snapshot doesn't exist at ..., writing actual."  x4  -> FAILS
   *          ...and it writes all four files
   *   run 2  4 passed                                                -> GREEN
   *
   * So deletion does fail loudly — ONCE. The file it writes is the developer's
   * own machine's render, and the very next run passes against it. The natural
   * response to a red is to re-run; run 2 is green, and the reasonable reading
   * is "flaky, self-healed". From then on the gate compares that developer's
   * render to itself, forever, on their machine.
   *
   * The second-order risk is worse than the vacuous green: having produced four
   * plausible-looking -darwin PNGs locally, the obvious next move is to commit
   * them — handing every other Mac a cross-platform baseline trap, which is
   * precisely what #102 refused to do on purpose.
   *
   * With "none" a missing baseline is a hard error and NOTHING is written, so
   * run 2 fails identically to run 1. An explained absence stays explained.
   *
   * REGENERATION IS STILL POSSIBLE AND STILL DELIBERATE: the `--update-snapshots`
   * CLI flag overrides this, so `pnpm e2e --project=visual -u` works. What is
   * no longer possible is regenerating by ACCIDENT, which is the only path that
   * was ever a problem.
   *
   * CI was never affected — a fresh checkout means a missing baseline stays red
   * every run and never accumulates the trap. This failure mode was purely
   * local, which is exactly why nothing in CI could have told us about it.
   *
   * Measured and reported by DEV on #125.
   */
  updateSnapshots: "none",
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
      // Explicit filenames, not the whole rungs/open-swe/ directory: the
      // sandbox spec in there needs a live Docker daemon and has its own
      // project (chromium-sandbox), so a directory glob would double-run it
      // and make this project Docker-dependent.
      testMatch: [
        /rungs\/open-swe\/open-swe(-narrative)?\.spec\.ts/,
        /rungs\/open-swe\/rate-limit-poll\.spec\.ts/,
        /rungs\/open-swe\/open-swe-chat-settings\.spec\.ts/,
        /rungs\/open-swe\/open-swe-workspace\.spec\.ts/,
        /rungs\/open-swe\/open-swe-transcript\.spec\.ts/,
        /rungs\/open-swe\/open-swe-approval\.spec\.ts/,
        /rungs\/open-swe\/open-swe-theme\.spec\.ts/,
        /rungs\/open-swe\/open-swe-queue-readiness\.spec\.ts/,
        /rungs\/open-swe\/open-swe-submit-failure\.spec\.ts/,
      ],
    },
    {
      /*
       * open-swe against a LIVE Python backend (#153).
       *
       * Its own project because it is the only open-swe suite that CANNOT run
       * in the mocked job: it needs a real django or fastapi behind
       * DJANGO_URL / FASTAPI_URL. Folding it into `open-swe` would make that
       * whole project backend-dependent, and the mocked job would start
       * failing for a reason unrelated to what it tests.
       *
       * LIVE_RUNTIME tells the spec which backend this job stood up. The spec
       * FAILS rather than skips when it is absent — a silent skip is how a
       * suite reports green having run nothing, which is the exact hole #153
       * was filed about.
       */
      name: "open-swe-live",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: [/rungs\/open-swe\/open-swe-live-transport\.spec\.ts/],
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
      // screenshot baselines are engine-specific.
      //
      // NOT WIRED INTO CI (#76). This comment previously claimed "CI runs it as
      // its own job", which was false — and had been false long enough for the
      // baselines to rot unnoticed. `--project=visual` appears in no workflow,
      // and the committed baselines are `-darwin` while every e2e job is
      // `runs-on: ubuntu-latest`, so a job added today could not resolve them.
      // Run it locally on macOS and it fails outright: the baselines predate
      // the dark/nav redesign and differ by ~99% of pixels.
      //
      // That ordering is the lesson, not the trivia: an unwired gate does not
      // merely fail to catch regressions, it silently rots — so wiring it later
      // lands as a wall of red that looks like the wiring broke something.
      //
      // Wiring it is three pieces of work, and doing only the last produces a
      // job that cannot pass:
      //   1. run `.github/workflows/visual-baselines.yml` (manual) to generate
      //      baselines on linux/amd64, the platform the runner reads them on,
      //   2. commit them and watch the gate pass,
      //   3. then add `--project=visual` to e2e.yml.
      name: "visual",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /shared\/visual\.spec\.ts/,
    },
  ],
});
