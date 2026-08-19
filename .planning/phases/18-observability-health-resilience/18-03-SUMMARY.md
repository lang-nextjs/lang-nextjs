---
phase: 18-observability-health-resilience
plan: 03
subsystem: resilience
tags: [rate-limit, circuit-breaker, serverless, stores, sse, retry]

requires:
  - phase: 18-01
    provides: ObservabilityHooks onError (fired on rate-limit / circuit-breaker rejection)
provides:
  - RateLimitStore + CircuitBreakerStore consumer-store interfaces
  - ResilienceConfig handler option
  - pure checkRateLimit/checkCircuit helpers (zero module-scope state)
  - handler early-reject 429 (rate limit) + 503 (breaker open) before fetch
  - post-stream circuit-breaker outcome recording (success/failure), fail-open
affects: [18-04, phase-19, phase-20]

tech-stack:
  added: []
  patterns:
    - "Consumer-provided async store pattern — library holds zero module-scope resilience state (serverless/edge-safe)"
    - "Resilience gate placed after body-size guard but before fetch so rejections avoid the upstream round-trip"
    - "Fail-open store calls — a throwing store is logged but never crashes the SSE stream"

key-files:
  created:
    - packages/server/src/resilience.ts
    - packages/server/src/resilience.test.ts
    - packages/server/src/handler.resilience.test.ts
  modified:
    - packages/server/src/handler.ts
    - packages/server/src/index.ts

key-decisions:
  - "All resilience state delegated to consumer stores; library has no default global store or module-level Map (RESIL-05)"
  - "Breaker key captured at the early check and reused for post-stream recordEvent so OPEN-check and outcome share the same key"
  - "Breaker records success only on clean finish (terminal frame AND no mid-stream error); truncation/mid-stream error → failure"
  - "Rejected requests release any registered resumeId (deleteStream) to avoid permanent 409 lockout"

patterns-established:
  - "Store-parameterized check helpers: no statefulness lives in the library"
  - "Fail-open breaker outcome recording wrapped in try-catch"

requirements-completed: [RESIL-02, RESIL-03, RESIL-05, RESIL-06]

duration: 4min
completed: 2026-06-06
---

# Phase 18 Plan 03: Resilience stores (rate limit + circuit breaker) Summary

**Stateless rate-limit (429) and circuit-breaker (503) gate backed by consumer-provided async stores, rejecting before any backend fetch with zero module-scope state, firing the Plan-01 onError hook, and recording breaker outcomes post-stream.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-06-06T18:36:49Z
- **Completed:** 2026-06-06T18:40:42Z
- **Tasks:** 2
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `RateLimitStore` + `CircuitBreakerStore` interfaces and `ResilienceConfig` with pure `checkRateLimit`/`checkCircuit` helpers — zero module-scope state, proven by independent two-store isolation tests (RESIL-05).
- Handler integration: over-limit → 429 and OPEN-breaker → 503, both BEFORE any backend fetch (verified by 0-call fetch spies), both firing `onError` with the correct type (RESIL-02, RESIL-03).
- Post-stream circuit-breaker outcome recording (success on clean finish, failure on fetch/mid-stream error), wrapped fail-open so a throwing store never crashes the stream.
- Confirmed (no new code) that retry is config-driven and connection-level only; mid-stream reader errors are never retried — single fetch call, surfaced as an in-band data-error frame (RESIL-06).

## Task Commits

1. **Task 1: resilience.ts store interfaces + check helpers (TDD)** - `90e90bd` (feat)
2. **Task 2: wire 429/503 early checks + retry confirmation into handler (TDD)** - `2cf0455` (feat)

_Note: each task followed RED → GREEN; the failing test and passing implementation were committed together per task._

## Files Created/Modified
- `packages/server/src/resilience.ts` - Store interfaces, ResilienceConfig, pure check helpers; zero module-scope state.
- `packages/server/src/resilience.test.ts` - Unit coverage: rate-limit check, breaker state machine (open/half-open/closed transitions driven through the store), isolation.
- `packages/server/src/handler.ts` - Resilience gate (429/503 before fetch), breaker key capture, fail-open post-stream `recordBreakerOutcome`, failure recording on fetch error.
- `packages/server/src/handler.resilience.test.ts` - Integration: 429 over limit, 503 breaker open, no-fetch assertions, onError types, concurrent isolation, retry vs mid-stream.
- `packages/server/src/index.ts` - Additive exports of resilience types + helpers (preserved 18-01/18-02 exports).

## Decisions Made
- See frontmatter key-decisions. Notably: breaker `success` requires `sawTerminalFrame && !streamError`; rejected requests free their resumeId; the breaker key is captured once and reused for post-stream recording.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test command syntax corrected for this package**
- **Found during:** Task 1
- **Issue:** Plan specified `pnpm test --run src/...`, but the package `test` script is already `vitest run`; `--run` is rejected by pnpm as an unknown option.
- **Fix:** Ran `pnpm test src/<file>.test.ts` (path passed straight to vitest). No source change.
- **Files modified:** none
- **Verification:** Tests execute and pass.
- **Committed in:** n/a (tooling only)

**2. [Rule 1 - Bug] Concurrent-isolation test fixture locked a shared ReadableStream**
- **Found during:** Task 2
- **Issue:** `mockFetch.mockResolvedValue(...)` returned one shared response object across 3 concurrent requests; the second `getReader()` threw "ReadableStream is locked". Handler behavior was correct — the fixture was wrong.
- **Fix:** Switched to `mockImplementation(async () => makeFetchResponse(...))` so each call gets a fresh, unlocked stream.
- **Files modified:** packages/server/src/handler.resilience.test.ts
- **Verification:** All 11 integration tests pass.
- **Committed in:** `2cf0455` (Task 2 commit)

---

**Total deviations:** 2 (1 blocking tooling, 1 test-fixture bug)
**Impact on plan:** No scope creep; no production-code change beyond the planned wiring. Both fixes were necessary to run/verify the plan.

## Issues Encountered
None beyond the deviations above.

## User Setup Required
None - no external service configuration required. Stores are consumer-supplied at call time.

## Next Phase Readiness
- `ResilienceConfig.timeoutMs` is declared and accepted (no-op here) — ready for Plan 18-04 to wire request timeouts.
- Server suite at 431 passing (was 413; +18 new resilience tests), no regressions to 18-01/18-02.
- Breaker readiness-state recording integrates cleanly with the Phase 19 SIGTERM→drain flow.

## Self-Check: PASSED

---
*Phase: 18-observability-health-resilience*
*Completed: 2026-06-06*
