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
 *     spec; covered by chromium-matrix instead. (Was SPEC-04 in
 *     nextjs.spec.ts before the #14 split.)
 */

/**
 * ASSERT THAT THE INTERACTION LANDED, BEFORE ASSERTING WHAT IT CAUSED (#346).
 *
 * THE TWO RUNTIMES FAIL DIFFERENTLY, AND THE DIFFERENCE IS MEASURED, not assumed. The same
 * mistake is loud in one and silent in the other:
 *
 *   jsdom / testing-library   `element.click()` on a non-interactive target does NOTHING.
 *                             No error, no warning. This is the dangerous one.
 *   Playwright                actionability checks catch a hidden target: clicking an
 *                             <option> inside a closed <select> TIMES OUT (measured: threw
 *                             after 4008ms). Loud, and it needs no convention.
 *
 * So the rule below is not ceremony for every interaction. It earns its line in two places.
 *
 * 1. VITEST/JSDOM, WHERE A CLICK CAN VANISH. The live instance: a test clicked
 *    `runtime-django` to switch runtimes and asserted a consequence. Green, and genuinely
 *    load-bearing — reverting the code under test turned it red. Then #327 made the three axes
 *    native <select>s, `runtime-django` became an <option>, and a native select changes on the
 *    SELECT and not on its children. The click became a no-op. What saved it was luck about
 *    which assertion the author happened to write: it asserted something the un-switched state
 *    does not produce, so the no-op went red. Written the other way round —
 *
 *        option.click();
 *        expect(somethingThatWasAlreadyTrue).toBe(true);
 *
 *    — it passes forever while exercising nothing.
 *
 * 2. PLAYWRIGHT, WHERE A CLICK CAN LAND SOMEWHERE ELSE. Playwright clicks the CENTRE of the
 *    element, so clicking a WRAPPER hits whatever is topmost at that point. That is worse than
 *    a no-op: it works by geometry rather than by targeting, and it keeps working until a
 *    layout change moves the target. A live one is documented in
 *    e2e/rungs/open-swe/open-swe-tool-failure.spec.ts — `card.click()` on a <div> that wraps a
 *    <details> opened the disclosure only because the collapsed card's centre WAS the summary.
 *
 * THE RULE. After an interaction that is supposed to change state, assert the state changed,
 * and target the control rather than something containing it:
 *
 *     await page.getByTestId("runtime-select").selectOption("django");
 *     await expect(page.getByTestId("runtime-select")).toHaveValue("django");   // it landed
 *     await expect(page.getByTestId("axis-trail")).toContainText("django");     // the effect
 *
 * One line, and it fails at the SETUP — which is where the defect is. That matters more than
 * the extra coverage: the decay is in the setup, and a failing assertion never points at
 * setup, so without it the eventual failure surfaces somewhere else entirely and whoever
 * debugs it starts from the wrong end.
 *
 * `selectOption` and `fill` already fail loudly on a missing option or a readonly field, so
 * they need no companion assertion. `click()` is the one to watch, in both runtimes.
 *
 * WHY THIS IS A CONVENTION AND NOT A CHECK. It needs the rendered DOM, not the source: whether
 * an interaction does anything depends on what element the testid landed on, which lives in a
 * component the spec does not import — and, in Playwright, on layout. A source-level scan over
 * this repo reported 63 hits, then 4, then 0, as the matcher was tightened; every intermediate
 * number was wrong and only the last was true. Zero is the real count today, because #327
 * migrated these call sites when it changed the controls. The scan is not kept: a checker with
 * that error rate is removed within a month, and its green would mean less than nothing.
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
  /*
   * `github` ON CI, AND IT IS THE ONLY THING THAT NAMES A FAILURE (#362).
   *
   * Without it a failing job's check run carries one generic annotation —
   * "Process completed with exit code 1" — with `title`, `summary` and `text`
   * all null. Measured by three independent GraphQL probes, so this is not an
   * inference: the check run reports THAT something failed and nothing about
   * WHAT. Learning which test meant downloading the job log over a rate-limited
   * API, which stalled two investigations in one day and left #114's last
   * failure unidentified.
   *
   * The `github` reporter emits `::error file=…,line=…::`, which GitHub renders
   * as annotations on the check run. Nothing else in this pipeline writes those
   * fields.
   *
   * GATED ON CI, and `list` and `html` are kept rather than replaced: locally
   * those `::error::` lines render as nothing and are noise, and the html
   * report is what anyone debugging a local run actually opens.
   *
   * scripts/check-github-reporter.mjs asserts this line still says so, because
   * dropping it reverts the repo to a state where NOTHING GOES RED — the
   * annotations simply stop, and the next person finds out months later while
   * chasing something else.
   */
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ...(process.env.CI ? [["github"] as const] : []),
  ],
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
        /shared\/reconnect-shipped-surface\.spec\.ts/,
        /shared\/chat\.spec\.ts/,
        /shared\/deepagents-cards\.spec\.ts/,
        /shared\/shared-cards\.spec\.ts/,
        /shared\/library-cards\.spec\.ts/,
        /accessibility\.spec\.ts/,
        /hitl\.spec\.ts/,
        // NEW SURFACES (#new-50): the shape-routed rung page and the API
        // key + approval contracts, none of which had e2e coverage.
        /rungs\/shape-route\.spec\.ts/,
        /api\/keys\.spec\.ts/,
        /api\/approval-contract\.spec\.ts/,
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
      /*
       * OPEN-SWE AT PHONE WIDTH.
       *
       * `mobile-chrome` below has existed for a while and really does run in
       * CI — but its testMatch names three `shared/` specs, so the application
       * this repo is built around had never been rendered at 412px by any
       * test. A coverage audit reported the path as covered twice, because the
       * project exists and the elements are all asserted somewhere; both were
       * true and neither was the same claim.
       *
       * Its own project rather than another entry in `mobile-chrome`: these
       * specs need PLAYWRIGHT_OPENSWE_URL, and mobile-chrome's shared specs
       * run against the example app on a different port.
       */
      name: "open-swe-mobile",
      use: {
        ...devices["Pixel 7"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: [/rungs\/open-swe\/open-swe-mobile\.spec\.ts/],
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
        /rungs\/open-swe\/open-swe-board\.spec\.ts/,
        /rungs\/open-swe\/open-swe-board-card\.spec\.ts/,
        /rungs\/open-swe\/open-swe-run-detail\.spec\.ts/,
        /rungs\/open-swe\/open-swe-run-detail-render\.spec\.ts/,
        /rungs\/open-swe\/open-swe-tool-lifecycle\.spec\.ts/,
        /rungs\/open-swe\/open-swe-queue-polling\.spec\.ts/,
        /rungs\/open-swe\/open-swe-queue-readiness\.spec\.ts/,
        /rungs\/open-swe\/open-swe-run-submission\.spec\.ts/,
        /rungs\/open-swe\/open-swe-submit-failure\.spec\.ts/,
      ],
    },
    {
      /*
       * THE SHELL — the product surface every fork keeps (#373).
       *
       * These specs used to live under e2e/rungs/open-swe/, which rung 4 owns, so
       * `pnpm eject langchain` deleted them along with the queue. #370 promoted the chat
       * shell to `shared` and the coverage did not follow, which meant a fork kept the
       * feature, lost its tests, and went GREEN — because the specs that could have failed
       * were gone. The directory a spec lives in declares its eject semantics, so the specs
       * moved rather than the manifest bending around them.
       *
       * THE BASE URL IS open-swe's, AND THE DIRECTORY DOES NOT SAY SO. e2e/shared/ targets
       * the example app on :3000; these target :3001. The project decides that, not the
       * path — which is exactly why they are a separate project rather than files dropped
       * into e2e/shared/.
       *
       * testIgnore, not an enumeration: the three excluded specs need a DIFFERENT
       * deployment (a live model, both runtimes configured, a production build), and each
       * already has a project that supplies it. Listing 18 filenames here would go stale on
       * the next spec added; naming the four exceptions does not.
       */
      name: "shell",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: /shell\/[a-z0-9-]+\.spec\.ts$/,
      testIgnore: [
        /shell\/live-transport\.spec\.ts/,
        /shell\/matrix-tools-live\.spec\.ts/,
        /shell\/runtime-routing\.spec\.ts/,
        /shell\/mobile\.spec\.ts/,
      ],
    },
    {
      /*
       * The shell at phone width. Separate from `shell` for the same reason
       * `open-swe-mobile` is separate from `open-swe`: a different device, and the
       * viewport is the subject rather than an incidental.
       */
      name: "shell-mobile",
      use: {
        ...devices["Pixel 7"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: [/shell\/mobile\.spec\.ts/],
    },
    {
      /*
       * THE MATRIX, EXECUTED. framework x runtime x mode, driving the real
       * increment / get_counter tools against a live backend and a real model.
       *
       * WIRED INTO e2e-live-transport, AND THAT JOB RUNS AND PASSES TODAY.
       *
       * Said plainly because the first version of this project was registered
       * here and named by no workflow at all — it never executed once, which is
       * the same failure the `visual` project below documents at length. A
       * project nobody runs is not coverage and looks exactly like coverage.
       *
       * Naming a workflow is not the same as running, so this says which is
       * true. This suite needs a real model, and every job that could supply one
       * passes `OPENROUTER_API_KEY`. THE REPOSITORY NOW HAS THAT SECRET: the
       * `llm-key-configured` gate — the subject that owns and announces this —
       * passes, and e2e.yml runs `--project=matrix-tools-live` on both legs of
       * e2e-live-transport.
       *
       * The two sentences above used to read "that job does not run today" and
       * "this repository does not have that secret". Both were true when
       * written and both went false without anything failing, which is the
       * failure this comment block was already about: a project nobody runs is
       * not coverage and looks exactly like coverage — and prose saying the
       * coverage is dead, after it comes alive, is the same defect pointed the
       * other way. Kept rather than deleted because the next reader needs to
       * know the gating is deliberate, not vestigial.
       *
       * It stays behind the key gate rather than in a per-PR job, where it
       * would be a permanently red light nobody reads.
       *
       * To run it by hand:
       *   LIVE_RUNTIME=fastapi PLAYWRIGHT_OPENSWE_URL=http://localhost:3001 \
       *     pnpm e2e --project=matrix-tools-live
       *
       * One worker because the counter is a single shared number. That orders
       * the cells within the file; it does not isolate this project from
       * others touching /api/counter, which is why the workflow runs it as its
       * own step rather than alongside the mocked suite.
       */
      name: "matrix-tools-live",
      workers: 1,
      /*
       * ONE RETRY, AND ONLY BECAUSE THE MODEL IS NON-DETERMINISTIC.
       *
       * Observed on a real run: a cell returned HTTP 200 with an empty stream
       * and no tool call, which is the provider's "service temporarily
       * overloaded" shape. That is not a defect in the app and not something a
       * better assertion can distinguish from a genuine refusal on one sample.
       *
       * One retry, not three: a failure that survives a retry is reported, and
       * the suite must not become a machine for retrying until green. The
       * deterministic half — the counter is read over HTTP, not parsed from
       * prose — is what makes a single retry enough.
       */
      retries: 1,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: [/shell\/matrix-tools-live\.spec\.ts/],
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
      testMatch: [/shell\/live-transport\.spec\.ts/],
    },
    {
      /*
       * open-swe with BOTH runtimes configured — does the selector route (#153).
       *
       * SEPARATE FROM open-swe-live, because it needs a different deployment
       * rather than a different filter. `open-swe-live` runs against an app
       * that has exactly ONE runtime URL set, which is what makes its 502 test
       * meaningful and what makes "django answered" unfalsifiable: there is
       * nothing else it could have reached. This project needs the opposite —
       * both URLs set, so which process answers is a real question.
       *
       * NO MODEL KEY NEEDED, which is why this can run on every pull request
       * while `open-swe-live` cannot. The spec identifies backends by an error
       * envelope each one composes in its own dispatch, so nothing here calls a
       * model.
       */
      name: "open-swe-routing",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.PLAYWRIGHT_OPENSWE_URL ?? "http://localhost:3001",
      },
      testMatch: [/shell\/runtime-routing\.spec\.ts/],
    },
    {
      /*
       * THE ONLY PROJECT THAT REQUIRES A PRODUCTION BUILD (#339).
       *
       * Every other open-swe project runs against `next dev`. This one runs against
       * `next start` and its spec asserts a branch that `next dev` cannot reach: the
       * middleware serves 404 for an unconfigured sandbox surface only when
       * NODE_ENV === "production", and `next dev` takes the open branch by construction.
       *
       * SEPARATE PROJECT RATHER THAN A FILTER, for the same reason open-swe-routing is: it
       * needs a different DEPLOYMENT, not a different subset. Folding this spec into the
       * `open-swe` project would run it against the dev server in e2e-mocked, where it fails
       * correctly and uselessly.
       *
       * It is deliberately absent from `pnpm test:e2e`. That script is the mocked job's run
       * against dev servers, and a reader following it would get a red suite for a spec that
       * is behaving exactly as designed.
       */
      name: "open-swe-production",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_OPENSWE_PROD_URL ?? "http://localhost:3001",
      },
      testMatch: [/rungs\/open-swe\/open-swe-production-failclosed\.spec\.ts/],
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
      // WIRED INTO CI (#76), and the history is worth keeping because the
      // ordering was the lesson. This comment once claimed "CI runs it as its
      // own job" while no such job existed — and it had been false long enough
      // for the baselines to rot to ~99% pixel drift unnoticed. An unwired gate
      // does not merely fail to catch regressions, it silently rots, so wiring
      // it later lands as a wall of red that looks like the wiring broke
      // something.
      //
      // All three pieces are now done: baselines generated on linux/amd64 by
      // .github/workflows/visual-baselines.yml, committed, and `--project=visual`
      // runs as the `visual` job in e2e.yml.
      //
      // THAT JOB MUST MATCH THE GENERATOR'S ENVIRONMENT — bare `ubuntu-latest`
      // with `pnpm --filter example start`. Playwright resolves snapshots per
      // platform and text metrics follow the available font set, so reading them
      // anywhere else compares against a rendering nobody agreed to. Measured:
      // inside the mcr.microsoft.com/playwright container these same specs fail
      // on SIZE — 197x179 expected against 183x179 received, identical heights,
      // narrower widths. A font stack, not a regression.
      //
      // Re-baseline by running that manual workflow, committing the PNGs, and
      // watching this gate pass. Never by relaxing the tolerance.
      name: "visual",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /shared\/visual\.spec\.ts/,
    },
  ],
});
