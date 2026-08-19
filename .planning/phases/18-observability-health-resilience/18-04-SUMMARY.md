---
phase: 18-observability-health-resilience
plan: 04
subsystem: resilience
tags: [timeout, abort, backpressure, web-streams, sse, edge, cleanup]

requires:
  - phase: 18-01
    provides: ObservabilityHooks onError/onFetchStart (timeout fires onError; timeoutMs surfaced to onFetchStart)
  - phase: 18-03
    provides: ResilienceConfig.timeoutMs (declared in 18-03, consumed here)
provides:
  - per-request timeout that aborts the upstream fetch, function-local (no module-scope state)
  - comprehensive timer cleanup on every exit path (clearTimeoutHandle helper)
  - pull-based Web-Streams backpressure (bounded in-flight gap under a slow client)
  - one-time finalize() teardown shared by done/error/cancel paths
affects: [phase-19, phase-20]

tech-stack:
  added: []
  patterns:
    - "Function-local per-request timeout handle aborts the AbortController; cleared via an idempotent clearTimeoutHandle on every exit path (no dangling timer/socket)"
    - "pull(controller)-driven ReadableStream: read one backend chunk per pull and return, so the runtime throttles upstream reads to consumer demand (Web-Streams backpressure)"
    - "One-time finalize() teardown guarded by a finished flag, run from the done-path, error-path, and cancel() — ordered BEFORE controller.close() so consumers observing done are guaranteed end-of-stream side effects"
    - "Edge-safe streaming: only Web Streams APIs, no Node stream.pipeline"

key-files:
  created:
    - packages/server/src/handler.resource-cleanup.test.ts
    - packages/server/src/handler.backpressure.test.ts
  modified:
    - packages/server/src/handler.ts
    - packages/server/src/handler.test.ts

key-decisions:
  - "Timeout timer handle is per-request function-local; aborts abortController on fire; cleared idempotently on fetch-throw, no-body, clean finish, mid-stream error, truncation, and after firing"
  - "Timeout abort surfaces through the existing mid-stream catch → onError type:stream + in-band upstream_disconnect frame + clean close (no new error channel)"
  - "Refactored the eager start() loop to pull(controller): one backend read per pull bounds the in-flight gap to ~2 frames under a slow consumer (measured), never proportional to stream length"
  - "Teardown (finalize) runs BEFORE controller.close() so onStreamEnd + breaker outcome are recorded before a consumer observes done — fixes a post-drain timing race the pull refactor exposed"
  - "Added cancel() to run finalize when the client disconnects, releasing timer/socket even with no done/error path"

patterns-established:
  - "clearTimeoutHandle idempotent helper as the single timer-clear point"
  - "finalize() one-time teardown guard across multiple pull invocations"
  - "Backpressure proven by a bounded in-flight-gap assertion (proxy for Pitfall 5)"
  - "Resource cleanup proven by an N-invocation repeated-abort no-leak proxy (proxy for Pitfall 6 / lsof FD gate)"

requirements-completed: [RESIL-01, RESIL-04]

duration: 5min
completed: 2026-06-06
---

# Phase 18 Plan 04: Resilience stream lifecycle (per-request timeout + Web-Streams backpressure) Summary

**A function-local per-request timeout aborts the upstream fetch and clears the timer + aborts the controller on every exit path (no dangling timer/socket, firing onError), and the SSE proxy is refactored to a pull-driven ReadableStream so a slow client throttles upstream reads — bounding the in-flight gap to ~2 frames with no unbounded buffering, all edge-safe.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-06T18:43Z
- **Completed:** 2026-06-06T18:49Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- **RESIL-01:** Per-request timeout from `resilience.timeoutMs` arms a function-local `setTimeout(() => abortController.abort(), timeoutMs)`. An idempotent `clearTimeoutHandle()` clears it on EVERY exit path: fetch throws, no body, clean finish, mid-stream error, truncation, and after the timeout fires. The timeout abort flows through the existing mid-stream catch → fires `onError` (type `stream`) → emits the in-band `upstream_disconnect` frame → closes cleanly. `timeoutMs` is now passed into the `onFetchStart` hook context (was `undefined`).
- **RESIL-04:** The SSE proxy was converted from an eager `start()` loop to a `pull(controller)` source. Each pull reads exactly one backend chunk, enqueues its frames, and returns — the Web Streams runtime then only re-invokes pull once the consumer has drained the queue. A slow client therefore throttles how fast the upstream is read; the in-flight gap stays bounded (measured ~2 frames), never proportional to stream length. Uses only Web Streams APIs (no Node `stream.pipeline`) so the path stays edge-compatible.
- All existing framing/terminal/error/cleanup behavior preserved via shared `emitFrames()` and a one-time `finalize()` teardown (timer clear + abort + registry/approval cleanup + `onStreamEnd` + breaker outcome) invoked from the done-path, error-path, and a new `cancel()` handler.
- Server suite: **431 → 439 passing** (+8: 5 resource-cleanup, 3 backpressure), no regressions to 18-01/18-02/18-03. Typecheck clean, package build succeeds.

## Task Commits

1. **Task 1: per-request timeout with comprehensive cleanup (RESIL-01)** - `58ee457` (feat)
2. **Task 2: pull-based Web-Streams backpressure (RESIL-04)** - `3cb15cf` (feat)

## Files Created/Modified
- `packages/server/src/handler.ts` - Added per-request timeout (arm + idempotent `clearTimeoutHandle`), `timeoutMs` → `onFetchStart`, and the eager→pull stream refactor with `emitFrames`/`finalize`/`cancel`.
- `packages/server/src/handler.resource-cleanup.test.ts` (261 lines) - Clean-finish clears timer + aborts; no-timer when `timeoutMs` unset; timeout-fires → abort + onError + in-band error frame + close; fetch-throws clears timer; 200x repeated-abort no-leak proxy for the lsof FD-stability gate.
- `packages/server/src/handler.backpressure.test.ts` (176 lines) - Slow-consumer bounded-gap proof (`maxGap < TOTAL/4`, real value ~2); in-order fast-consumer correctness with terminal frame; truncation still emits the in-band `upstream_disconnect` error.
- `packages/server/src/handler.test.ts` - Updated one approvalGating test to drain its response (pull streams do work only as the client consumes).

## Decisions Made
See frontmatter key-decisions. Notably: timeout abort reuses the existing mid-stream error channel; `finalize()` runs before `controller.close()` to eliminate a post-drain timing race the pull refactor exposed; `cancel()` added so client disconnect releases the timer/socket.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pull refactor exposed a post-drain timing race in end-of-stream side effects**
- **Found during:** Task 2
- **Issue:** With the pull-driven stream, calling `controller.close()` before `await finalize()` let the consumer's `read()` resolve with `done:true` (so `drain()` returned) before `onStreamEnd`/`recordBreakerOutcome` had run — breaking a 18-03 breaker test that asserts `store.events` immediately after draining.
- **Fix:** Reordered both the done-path and error-path to run `finalize()` BEFORE `controller.close()`, guaranteeing end-of-stream side effects complete before a consumer observes `done`.
- **Files modified:** packages/server/src/handler.ts
- **Verification:** Full 439-test suite green incl. the 18-03 resilience suite.
- **Committed in:** `3cb15cf` (Task 2)

**2. [Rule 3 - Blocking] One existing approvalGating test never drained its response**
- **Found during:** Task 2
- **Issue:** A test asserted a per-tool callback fired after `await handler(makeRequest())` without consuming the stream. The old eager `start()` did the work regardless; a pull-based stream correctly does no work until consumed, so the assertion failed.
- **Fix:** Updated the test to drain its response (models a real client). No production behavior change — the new semantics are correct for a backpressure-aware stream.
- **Files modified:** packages/server/src/handler.test.ts
- **Verification:** Test passes; all other handler tests already drained and were unaffected.
- **Committed in:** `3cb15cf` (Task 2)

**3. [Rule 3 - Blocking] Test command syntax for this package (same as 18-03)**
- **Found during:** Task 1
- **Issue:** Plan's `pnpm test --run` is rejected — the package `test` script is already `vitest run`.
- **Fix:** Ran `pnpm vitest run [path]` from the package dir. No source change.
- **Files modified:** none

---

**Total deviations:** 3 (1 race bug surfaced by the planned refactor, 2 blocking test/tooling). No scope creep; all production changes are within the planned timeout + backpressure wiring.

## Must-Haves Confirmation
- **RESIL-01 SATISFIED:** Per-request timeout aborts the upstream fetch; timer cleared + controller aborted on every exit path (`clearTimeoutHandle` at fetch-throw, no-body, and in `finalize`); the 200x repeated-abort test proves no dangling timer/controller (unit proxy for the lsof FD gate, real stress test deferred to Phase 20 OPS-05); timeout fires `onError`.
- **RESIL-04 SATISFIED:** Handler applies Web-Streams backpressure via `pull(controller)`; slow-consumer test proves the in-flight gap stays bounded (~2, asserted `< TOTAL/4`), not growing with stream length; existing framing/terminal/error/cleanup behavior preserved; edge-safe (no Node streams).

## Issues Encountered
None beyond the deviations above.

## User Setup Required
None - `timeoutMs` is an optional consumer config value; no external service configuration required.

## Next Phase Readiness
- All of Phase 18's resilience surface (RESIL-01..06) plus observability (OBS-01..05) and health probes (PROBE-01..05) are now implemented — **Phase 18 implementation complete (16/16 requirements)**.
- Server suite at 439 passing (+8), no regressions.
- The pull-based finalize() + cancel() teardown and the readiness probe (18-02) are the integration points for the Phase 19 SIGTERM→drain flow; the deferred lsof FD-stability stress test is the Phase 20 OPS-05 E2E.

## Self-Check: PASSED

---
*Phase: 18-observability-health-resilience*
*Completed: 2026-06-06*
