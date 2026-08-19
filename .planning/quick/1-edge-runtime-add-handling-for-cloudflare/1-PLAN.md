---
phase: quick-1-edge-runtime-cloudflare-limits
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/edge/src/types.ts
  - packages/edge/src/cloudflare-handler.ts
  - packages/edge/src/cloudflare-handler.test.ts
  - packages/edge/README.md
autonomous: true
requirements: [INTENT-01]
formal_artifacts: none

must_haves:
  truths:
    - "A consumer can configure a maximum stream duration for the Cloudflare handler via a streamTimeoutMs option"
    - "When the backend fetch or the SSE stream exceeds the configured timeout, the handler aborts cleanly instead of hanging until Cloudflare kills the Worker"
    - "A pre-stream timeout (backend never responds) returns a 504 Response, not a thrown rejection that crashes the Worker"
    - "A mid-stream timeout terminates the ReadableStream with an error rather than leaking an open reader"
    - "Cloudflare Worker tier requirements (128MB memory, 30s CPU on free tier, 10s TTFB) are documented in the edge package README"
    - "All existing cloudflare-handler tests continue to pass — timeout handling is additive and opt-in"
  artifacts:
    - path: "packages/edge/src/types.ts"
      provides: "streamTimeoutMs field on CloudflareHandlerOptions"
      contains: "streamTimeoutMs"
    - path: "packages/edge/src/cloudflare-handler.ts"
      provides: "AbortController-based timeout for backend fetch and stream loop, 504 on pre-stream timeout"
      contains: "streamTimeoutMs"
      min_lines: 200
    - path: "packages/edge/src/cloudflare-handler.test.ts"
      provides: "Tests for pre-stream timeout (504), mid-stream timeout (stream error), and no-timeout default"
      contains: "streamTimeoutMs"
    - path: "packages/edge/README.md"
      provides: "Worker tier requirements section and streamTimeoutMs option documentation"
      contains: "streamTimeoutMs"
  key_links:
    - from: "packages/edge/src/cloudflare-handler.ts"
      to: "CloudflareHandlerOptions.streamTimeoutMs"
      via: "options.streamTimeoutMs read in handler body"
      pattern: "options\\.streamTimeoutMs"
    - from: "packages/edge/src/cloudflare-handler.ts"
      to: "fetch backend call"
      via: "AbortController signal passed to fetch and ReadableStream loop"
      pattern: "AbortController|signal"
    - from: "packages/edge/src/cloudflare-handler.test.ts"
      to: "packages/edge/src/cloudflare-handler.ts"
      via: "import createCloudflareHandler"
      pattern: "createCloudflareHandler"
---

<objective>
Add Cloudflare Worker limit handling to `createCloudflareHandler`: a configurable
`streamTimeoutMs` option that bounds total stream execution, clean timeout error
responses (504 pre-stream, stream error mid-stream), and README documentation of
Cloudflare Worker tier constraints.

Purpose: Long-running agent streams currently hit Cloudflare Worker limits (30s CPU
on free tier, 10s TTFB) and fail silently or with cryptic errors. The handler has
no timeout mechanism — it relies entirely on Cloudflare killing the Worker, which
produces no usable error for the consumer. This adds explicit, opt-in mitigation.

Output: Updated `cloudflare-handler.ts` with timeout handling, a new
`streamTimeoutMs` option on `CloudflareHandlerOptions`, new tests, and a README
section documenting Worker tier requirements.

Scope guard: This stays entirely within `packages/edge`. The Deno handler, the
accumulator, the server package, and the SseTransform pipeline are NOT modified.
The polling-endpoint fallback mentioned in issue #11 is explicitly OUT OF SCOPE.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

@packages/edge/src/cloudflare-handler.ts
@packages/edge/src/cloudflare-handler.test.ts
@packages/edge/src/types.ts
@packages/edge/src/deno-handler.ts
@packages/edge/src/accumulator.ts
@packages/edge/README.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add streamTimeoutMs option and timeout handling to the Cloudflare handler</name>
  <files>packages/edge/src/types.ts, packages/edge/src/cloudflare-handler.ts</files>
  <action>
Add an optional `streamTimeoutMs` field to `CloudflareHandlerOptions` in
`packages/edge/src/types.ts`:
- Add the field ONLY to `CloudflareHandlerOptions` (NOT to `EdgeHandlerOptions`
  or `DenoHandlerOptions` — this is a Cloudflare-specific mitigation and the Deno
  handler is explicitly out of scope).
- JSDoc: "Maximum total stream duration in milliseconds. When exceeded, the handler
  aborts the backend connection and returns 504 (pre-stream) or errors the stream
  (mid-stream). Defaults to undefined (no timeout). Recommended: keep below the
  Cloudflare Worker CPU limit — 30s on the free tier."
- Type: `streamTimeoutMs?: number`.

In `packages/edge/src/cloudflare-handler.ts`, wire timeout handling using a single
`AbortController` per request:

1. Inside the `handler` function, after the `backendUrl` guard, create the
   controller and a timer ONLY when `options.streamTimeoutMs` is a positive number:
   ```
   const controller = new AbortController();
   let timedOut = false;
   const timeoutMs = options.streamTimeoutMs;
   let timer: ReturnType<typeof setTimeout> | undefined;
   if (typeof timeoutMs === 'number' && timeoutMs > 0) {
     timer = setTimeout(() => {
       timedOut = true;
       controller.abort();
     }, timeoutMs);
   }
   ```
   Keep all timeout logic guarded by this `timer !== undefined` / `timeoutMs`
   check so behavior is byte-for-byte unchanged when the option is absent.

2. Pass `signal: controller.signal` to the backend `fetch(options.backendUrl, {...})`
   call.

3. Wrap the existing backend-fetch try/catch so a timeout abort is distinguished
   from a generic fetch failure. In the `catch (err)`, if `timedOut` is true return
   `new Response('Gateway Timeout: stream exceeded streamTimeoutMs', { status: 504 })`;
   otherwise keep the existing `502` behavior. Clear the timer (`clearTimeout(timer)`)
   before returning in BOTH branches.

4. For the mid-stream case: inside the `ReadableStream` `start(controller)` callback
   (note: rename the inner param to avoid shadowing — call it `streamController`),
   register an abort listener on `controller.signal` that, when fired, calls
   `reader.cancel()` and `streamController.error(new Error('stream timeout: exceeded streamTimeoutMs'))`.
   Use `controller.signal.addEventListener('abort', ..., { once: true })`. Ensure
   the reader loop also exits — checking `controller.signal.aborted` at the top of
   the `while` loop and breaking is sufficient since the listener already errored
   the stream.

5. Clear the timer when the stream completes normally (in the `done` branch, right
   before `streamController.close()`) and in the stream's `catch` block, so the
   timer never fires after the stream is finished.

6. Preserve the existing module-level JSDoc comment block about NOT wrapping the
   Response — the timeout logic must live inside the existing `start()` callback
   and the existing fetch call, not in a new wrapper function.

Update the module-level JSDoc usage example to show `streamTimeoutMs: 25000` as an
optional field with a one-line comment ("// abort before the 30s free-tier limit").

Do NOT touch `deno-handler.ts`, `accumulator.ts`, or `index.ts` (the
`CloudflareHandlerOptions` type is already re-exported from index.ts).
  </action>
  <verify>
Run `cd packages/edge && npx tsc --noEmit` — must pass with no errors.
Run `cd packages/edge && npx vitest run cloudflare-handler` — all existing 20 tests
must still pass (timeout handling is additive/opt-in).
Run `grep -n 'streamTimeoutMs' packages/edge/src/types.ts packages/edge/src/cloudflare-handler.ts`
— must show the field declared in types.ts and read in the handler.
Run `grep -n 'AbortController' packages/edge/src/cloudflare-handler.ts` — must show
the controller is created.
Run `grep -n 'streamTimeoutMs\|AbortController' packages/edge/src/deno-handler.ts`
— must return NOTHING (Deno handler untouched).
  </verify>
  <done>
`CloudflareHandlerOptions` has an optional `streamTimeoutMs?: number` field.
The Cloudflare handler creates an `AbortController` only when `streamTimeoutMs > 0`,
passes its signal to the backend fetch, returns 504 on a pre-stream timeout, and
errors the ReadableStream on a mid-stream timeout. The timer is always cleared on
every exit path. When `streamTimeoutMs` is absent the handler behaves identically
to before. `tsc --noEmit` passes and all existing cloudflare-handler tests pass.
The Deno handler, accumulator, and server package are unchanged.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add timeout tests and document Cloudflare Worker tier requirements</name>
  <files>packages/edge/src/cloudflare-handler.test.ts, packages/edge/README.md</files>
  <action>
Add tests to `packages/edge/src/cloudflare-handler.test.ts` inside the existing
`describe('createCloudflareHandler', ...)` block. Reuse the existing helpers
(`makeStream`, `readResponseText`, `makeFetch`, `makeRequest`). Use Vitest fake
timers where a deterministic timeout is needed (`vi.useFakeTimers()` in the test
body, restore with `vi.useRealTimers()`); the existing `beforeEach`/`afterEach`
already stub/unstub globals — do not remove them.

Add at least these tests:

1. "no timeout by default — handler streams to completion when streamTimeoutMs is
   omitted": construct a handler with NO `streamTimeoutMs`, mock fetch with a normal
   `makeStream(['data: hello\n\n'])` response, assert the response body contains
   `data: hello` and status is 200. This pins the additive/opt-in guarantee.

2. "returns 504 when the backend does not respond before streamTimeoutMs": mock
   `fetch` with an implementation that returns a Promise which rejects with an
   `AbortError`-shaped error (`new DOMException('aborted', 'AbortError')`) — OR,
   simpler and deterministic: mock fetch as a `vi.fn()` whose implementation reads
   the passed `init.signal`, and when the signal aborts, rejects. Then advance fake
   timers past `streamTimeoutMs`. Assert the returned `response.status` is 504.
   The key assertion is: the handler returns a Response (does NOT throw / reject),
   and that Response has status 504.

3. "errors the stream when streamTimeoutMs elapses mid-stream": create a backend
   `ReadableStream` whose `pull`/`start` enqueues one frame then never closes (a
   hanging stream). Build a handler with a small `streamTimeoutMs`. Get the response
   reader, advance fake timers past the timeout, and assert that reading the stream
   eventually throws an `Error` (mirror the pattern of the existing
   "handles mid-stream error" test at lines 271-309). The handler must not hang.

4. "streamTimeoutMs is Cloudflare-only — passing it does not affect a normal fast
   stream": handler with a generous `streamTimeoutMs` (e.g. 60000) and a normal
   completed stream; assert the body is delivered intact and status 200, proving
   the timer does not interfere with sub-timeout streams.

Keep each test self-contained and deterministic. If fake timers make the async
ReadableStream interaction awkward, it is acceptable to use a very small real
`streamTimeoutMs` (e.g. 10-20ms) with real timers for tests 2 and 3 instead —
choose whichever is reliable, but the tests MUST be deterministic (no flakiness).

Then update `packages/edge/README.md`:

a. Add a new H2 section "## Cloudflare Worker Tier Requirements" (place it
   immediately after the "## Cloudflare SSE Buffering Caveat" section). Document:
   - Memory limit: 128MB per Worker invocation.
   - CPU time limit: 30 seconds on the free tier (longer on paid plans — link to
     Cloudflare's limits doc generically as "Cloudflare Workers limits").
   - TTFB: ~10s buffering caveat (cross-reference the existing Buffering Caveat
     section).
   - Recommendation: set `streamTimeoutMs` below your tier's CPU limit (e.g.
     `25000` for the free tier) so the handler returns a clean 504 instead of the
     Worker being terminated with a cryptic error.

b. In the `### createCloudflareHandler(options)` API Reference table, add a new row:
   `| streamTimeoutMs | number | No | Max total stream duration (ms). Returns 504 on pre-stream timeout, errors the stream mid-stream. Recommended below the Worker CPU limit (30s free tier). |`

c. In the "## Troubleshooting" section, add an entry:
   "**Stream cut off / Worker terminated unexpectedly** — Your stream likely
   exceeded the Cloudflare Worker CPU limit. Set `streamTimeoutMs` to get a clean
   504 instead, and see [Cloudflare Worker Tier Requirements](#cloudflare-worker-tier-requirements)."

Do NOT modify the Deno sections of the README.
  </action>
  <verify>
Run `cd packages/edge && npx vitest run cloudflare-handler` — all tests pass,
including the 4 new timeout tests (total >= 24 tests).
Run `cd packages/edge && npx tsc --noEmit` — passes.
Run `grep -n 'streamTimeoutMs' packages/edge/src/cloudflare-handler.test.ts` —
shows the new tests reference the option.
Run `grep -n 'Cloudflare Worker Tier Requirements\|streamTimeoutMs' packages/edge/README.md`
— shows the new section heading and the option documented in the API table.
Run `grep -c '128MB\|30 second\|30s' packages/edge/README.md` — returns a non-zero
count proving the tier limits are documented.
  </verify>
  <done>
The cloudflare-handler test file has 4+ new deterministic tests covering: no
timeout by default, 504 on pre-stream timeout, stream error on mid-stream timeout,
and no interference for sub-timeout streams. All cloudflare-handler tests pass and
`tsc --noEmit` is clean. The edge README has a "Cloudflare Worker Tier
Requirements" section documenting the 128MB memory limit, 30s free-tier CPU limit,
and TTFB caveat, plus a `streamTimeoutMs` row in the API table and a troubleshooting
entry. The Deno handler and Deno README sections are unchanged.
  </done>
</task>

</tasks>

<verification>
- `cd packages/edge && npx vitest run` — entire edge package test suite passes
  (accumulator + deno-handler + cloudflare-handler), confirming no regressions.
- `cd packages/edge && npx tsc --noEmit` — typecheck passes.
- `git diff --name-only` shows ONLY these files changed: `packages/edge/src/types.ts`,
  `packages/edge/src/cloudflare-handler.ts`, `packages/edge/src/cloudflare-handler.test.ts`,
  `packages/edge/README.md`. No files outside `packages/edge` are touched.
- `git diff packages/edge/src/deno-handler.ts packages/edge/src/accumulator.ts`
  produces NO output (sibling files untouched).
</verification>

<success_criteria>
- `createCloudflareHandler` accepts an optional `streamTimeoutMs` option.
- A pre-stream timeout returns HTTP 504 without throwing.
- A mid-stream timeout errors the ReadableStream and cancels the upstream reader.
- The timeout timer is cleared on every exit path (success, error, both timeout
  cases) — no dangling timers.
- With `streamTimeoutMs` absent, handler behavior is byte-for-byte unchanged and
  all 20 pre-existing tests still pass.
- The edge README documents Cloudflare Worker tier requirements (128MB, 30s CPU,
  TTFB) and the new option.
- Scope confined to `packages/edge`; no polling fallback implemented.
</success_criteria>

<output>
After completion, create `.planning/quick/1-edge-runtime-add-handling-for-cloudflare/1-SUMMARY.md`
</output>
