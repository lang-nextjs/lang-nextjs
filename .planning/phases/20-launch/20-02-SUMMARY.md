---
phase: 20-launch
plan: 02
subsystem: testing
tags: [e2e, observability, resilience, graceful-shutdown, vitest, fake-timers]

# Dependency graph
requires:
  - phase: 18-observability-health-resilience
    provides: observability onError hook, readiness probe, rate-limit/circuit-breaker stores
  - phase: 19-graceful-shutdown-deploy-docs
    provides: createGracefulShutdown with injectable onExit + isDraining wiring
provides:
  - End-to-end proof of the three v1.6 production flows (observability sink, resilience 429/503 fallback, SIGTERM stream drain)
  - Bounded resource-stability no-leak proxy replacing the deferred 1000-abort lsof FD check
affects: [20-03 v1.6.0 release, OPS-05 sign-off]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-contained E2E test files copy the vi.mock + helper blocks (no sibling-test imports)"
    - "Node-only fake-timer integration test for SIGTERM (not Playwright) with injectable onExit"
    - "Bounded in-process no-leak proxy (clearTimeout-per-iteration + controller-aborted) instead of real lsof FD counting"

key-files:
  created:
    - packages/server/src/handler.observability-e2e.test.ts
    - packages/server/src/handler.resilience-e2e.test.ts
    - packages/server/src/graceful-shutdown-e2e.test.ts
    - packages/server/src/resource-stability.test.ts
  modified: []

key-decisions:
  - "Flow 3 is a Node-only Vitest fake-timer test using injectable onExit — SIGTERM does not fire in a browser, so Playwright is the wrong tool"
  - "resource-stability uses real timers + tiny timeoutMs:5 stalling-fetch (mirrors handler.resource-cleanup.test.ts) rather than fake timers — the abort-event interplay is reliable under real timers"
  - "True 1000-abort lsof FD stress check intentionally NOT in CI (flaky, OS/runtime-dependent); deferred to manual/v1.6.x stress run"

patterns-established:
  - "E2E test self-containment: each file copies vi.mock('./stream-registry'/'./reconnect') + makeRequest/makeFetchResponse + test stores"
  - "Readiness-flip-during-drain assertion ties Phase 18 readiness + Phase 19 shutdown end-to-end"

requirements-completed: [OPS-05]

# Metrics
duration: 6min
completed: 2026-06-06
---

# Phase 20 Plan 02: OPS-05 E2E for the Three Production Flows + Bounded Resource-Stability Summary

**Four new self-contained tests prove the v1.6 production-readiness story end-to-end — an observability event reaching a sink, resilience trips returning 429/503 before any backend fetch, and a SIGTERM-driven graceful drain of an in-flight stream — plus a bounded ~50-abort no-leak proxy that replaces the deferred flaky 1000-abort lsof FD check.**

## Performance

- **Duration:** ~6 min
- **Tasks:** 3 completed
- **Files created:** 4 (all in packages/server/src/)
- **Tests added:** 7 (server suite 454 → 461)

## Accomplishments

### Task 1 — Flow 1 + Flow 2 E2E (commit b9a... see below)
- `handler.observability-e2e.test.ts` (2 tests): drives the fetch-failure error path, asserts `onError` reaches an in-memory `OnErrorContext[]` sink with the documented shape (`type:"fetch"`, `error instanceof Error`, numeric `durationMs`, string `sessionId`, numeric `timestamp`); second test asserts the sink event carries ONLY the five safe scalar fields — no `headers`/`authorization`/`cookie`/`body`/`request` (OBS-03 end-to-end).
- `handler.resilience-e2e.test.ts` (2 tests): rate-limit over-limit second request → 429 with fetch spy call count unchanged; circuit-breaker OPEN → 503 with fetch never called. Both prove the fallback fires BEFORE any backend fetch.

### Task 2 — Flow 3 E2E (graceful shutdown)
- `graceful-shutdown-e2e.test.ts` (2 tests): Node-only Vitest fake-timer integration test wiring `createGracefulShutdown` + `createReadinessProbe`. Clean-drain test asserts readiness flips `ok → draining` the moment `dispose()` begins, the tracked in-flight stream drains, and the injected `onExit` is called with `0`. Hung-stream test (never released) force-exits `1` past the safety deadline. No real `process.exit` (grep guard = 0).

### Task 3 — Bounded resource-stability
- `resource-stability.test.ts` (1 test): runs ~50 abort/timeout iterations through the per-request timeout path (tiny `timeoutMs:5` against a stalling fetch). Asserts every iteration's AbortController was aborted (no leaked socket) and `clearTimeout` was called ≥ once per iteration (no dangling timer). Top-of-file rationale documents why the true 1000-abort lsof FD check is intentionally not in CI. No `child_process`/`lsof` shell-out (grep guard = 0).

## Verification

- `pnpm --filter @deepagents-nextjs/server test` → **33 files, 461 tests passed** (was 29/454; +4 files, +7 tests), zero regressions to Phase 18/19 tests.
- All plan grep guards green: sink/onError present; 429 & 503 present; no-fetch assertions present; createGracefulShutdown + isDraining present; onExit(0)/onExit(1) present; zero process.exit; rationale (1000-abort/lsof/deferred/bounded) present; abort/timeout present; zero forbidden shell-outs.

## Deviations from Plan

### Adjustments (no behavior/scope change)

**1. resource-stability test uses real timers, not fake timers.**
- **Found during:** Task 3.
- **Plan suggestion:** "use fake timers to fast-forward the timeout aborts" with optional `vi.getTimerCount()===0`.
- **What was done:** Mirrored the already-proven `handler.resource-cleanup.test.ts` no-leak proxy (real timers + `timeoutMs:5` + stalling fetch that rejects on abort). The abort-event/stream-error interplay is reliable under real timers; the no-leak invariant is asserted via the `clearTimeout`-per-iteration spy + every-controller-aborted check (an in-process proxy, exactly as the plan's "concrete proxy MUST be observable in-process" requirement allows). Test runs in <1s.
- **Why:** The plan explicitly offered the spy-on-cleanup proxy as an acceptable alternative; fake timers add no determinism benefit here and complicate the AbortSignal `addEventListener('abort')` resolution. No change to coverage or assertions' intent.

No other deviations — Rules 1-4 not triggered; no auth gates.

## must_haves Satisfied (OPS-05)

- [x] Observability event (onError) reaches a consumer sink on an error path, OnErrorContext shape asserted.
- [x] Rate-limit trip → 429 and circuit-breaker-OPEN → 503, both BEFORE any backend fetch (fetch spy zero/unchanged).
- [x] SIGTERM-style dispose flips readiness to draining, drains an in-flight tracked stream, exits 0; hung stream force-exits 1; driven by fake timers + injectable onExit.
- [x] Bounded ~50-abort resource-stability test asserts no unbounded resource growth (no-leak proxy) with documented rationale that the 1000-abort lsof FD check is intentionally NOT in CI.

## Self-Check: PASSED

- FOUND: packages/server/src/handler.observability-e2e.test.ts
- FOUND: packages/server/src/handler.resilience-e2e.test.ts
- FOUND: packages/server/src/graceful-shutdown-e2e.test.ts
- FOUND: packages/server/src/resource-stability.test.ts
- Commits verified present (see completion output below).
