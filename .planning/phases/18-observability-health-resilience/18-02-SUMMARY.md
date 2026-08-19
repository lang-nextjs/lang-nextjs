---
phase: 18-observability-health-resilience
plan: 02
subsystem: infra
tags: [health, readiness, kubernetes, probes, edge, stateless]

# Dependency graph
requires:
  - phase: 18-01
    provides: additive index.ts exports + copy-not-import distribution pattern (observability hooks)
provides:
  - createHealthProbe (liveness) + createReadinessProbe (readiness) factories in server
  - Stateless draining signal (draining flag / isDraining callback) forward-compatible with Phase 19 shutdown
  - Cheap-by-default readiness with optional, opt-in, consumer-supplied dependency checks (no backend round-trip by default)
  - Minimal info-leak-free probe responses
  - Copy-not-import distribution of probes into sveltekit/remix/edge (edge stays Next.js-free, Web-API-only)
affects: [19-graceful-shutdown, 20-error-reporting-release, health-gated-canary]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Stateless probe factories — draining supplied per-call, no module-scope state"
    - "Cheap readiness by default — dependency checks opt-in only, zero fetch unless supplied"
    - "Minimal probe response shape — no version/backendUrl/env/per-dependency leak"
    - "Copy-not-import distribution (mirrors SseFrameAccumulator) — server is source of truth"

key-files:
  created:
    - packages/server/src/health.ts
    - packages/server/src/health.test.ts
    - packages/sveltekit/src/health.ts
    - packages/remix/src/health.ts
    - packages/edge/src/health.ts
  modified:
    - packages/server/src/index.ts
    - packages/sveltekit/src/index.ts
    - packages/remix/src/index.ts
    - packages/edge/src/index.ts

key-decisions:
  - "Dropped the research draft's mandatory backend fetch in readiness (Pitfall 7) — readiness is local + cheap; dependency checks are opt-in"
  - "Draining accepted as both a static `draining` boolean and a dynamic `isDraining()` callback (sync or async) to stay stateless and Phase-19-ready"
  - "Readiness response intentionally omits per-dependency `checks` detail to avoid internal info leak (PROBE-05)"

patterns-established:
  - "Pattern: probe factories are pure functions of their config — no module-scope mutable state"
  - "Pattern: per-check timeout race resolving to false (never reject), with clearTimeout cleanup"

requirements-completed: [PROBE-01, PROBE-02, PROBE-03, PROBE-04, PROBE-05]

# Metrics
duration: 3min
completed: 2026-06-06
---

# Phase 18 Plan 02: Health & Readiness Probe Helpers Summary

**Stateless Kubernetes-style liveness/readiness probe factories — cheap-by-default readiness with opt-in dependency checks, draining flag, info-leak-free minimal responses, copy-distributed to sveltekit/remix/edge.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-06T18:31:40Z
- **Completed:** 2026-06-06T18:34:22Z
- **Tasks:** 2 (TDD: RED → GREEN)
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments
- `createHealthProbe` liveness factory returning minimal `{ ok, status, checks, timestamp }` (PROBE-01, PROBE-05)
- `createReadinessProbe` flips to `ready:false` / `status:"draining"` when draining and `status:"error"` when an opted-in dependency check fails (PROBE-02)
- Cheap-by-default readiness — proven by a test asserting `fetch` is called 0 times when no checks supplied (PROBE-03)
- Per-check timeout bounded (default 5000ms) resolving to false, never rejecting (PROBE-03)
- Probes copied (copy-not-import) and exported from sveltekit/remix/edge; edge stays Web-API-only and Next.js-free (PROBE-04)

## Task Commits

1. **Task 1 (RED): failing probe tests** - `5cddec8` (test)
2. **Task 1 (GREEN): implement probe factories** - `57865c7` (feat)
3. **Task 2: export from server + copy to frameworks** - `7736c5e` (feat)

_No refactor commit needed — implementation was clean on first GREEN._

## Files Created/Modified
- `packages/server/src/health.ts` - createHealthProbe + createReadinessProbe factories, ProbeCheck/result types, timeout-bounded runCheck (source of truth)
- `packages/server/src/health.test.ts` - 16 tests: liveness, readiness, draining, isDraining (sync+async), no-fetch-by-default, timeout, minimal-response/no-leak
- `packages/sveltekit/src/health.ts` - verbatim copy with provenance header
- `packages/remix/src/health.ts` - verbatim copy with provenance header
- `packages/edge/src/health.ts` - verbatim copy, Web-API-only (no node:/next imports)
- `packages/server/src/index.ts` - additive export of probes + types (preserves 18-01 exports)
- `packages/sveltekit/src/index.ts` - additive probe export
- `packages/remix/src/index.ts` - additive probe export
- `packages/edge/src/index.ts` - additive probe export

## Decisions Made
- Removed the research draft's mandatory backend `fetch` from readiness (Pitfall 7). Readiness is local and cheap; dependency checks are optional and consumer-supplied, matching the same `ProbeCheck` shape used by liveness.
- Accepted draining as both a static `draining: boolean` and a dynamic `isDraining(): boolean | Promise<boolean>` so there is no module-scope state and Phase 19 graceful shutdown can flip a shared signal.
- Readiness response omits per-dependency `checks` to avoid leaking internal dependency detail (PROBE-05); liveness retains `checks` (consumer-named booleans only, no internal info).

## Deviations from Plan
None - plan executed exactly as written. (The "no mandatory backend fetch" design was an explicit instruction in the plan, not a deviation.)

## Issues Encountered
None. RED failed as expected (missing module), GREEN passed 16/16 on first implementation, full server suite stayed green at 413 tests (397 from 18-01 + 16 new).

## User Setup Required
None - no external service configuration required.

## Verification
- `pnpm --filter @deepagents-nextjs/server test`: 24 files, 413 tests passed (no 18-01 regressions)
- Readiness no-fetch-by-default proven by spy asserting 0 fetch calls (PROBE-03)
- Draining flag + isDraining callback flip readiness to `ready:false` (PROBE-02)
- Probe response key-subset assertions confirm no version/backendUrl/env leak (PROBE-05)
- Typecheck + build green across server/sveltekit/remix/edge; edge grep for `next/server|node:|require(` returns clean (PROBE-04)
- Module-scope mutable probe state check: only `DEFAULT_TIMEOUT_MS` const literal — stateless confirmed

## Next Phase Readiness
- `isDraining()` hook is the integration point for Phase 19 SIGTERM→503 drain — readiness already flips to `draining` when the signal returns true.
- Probes are framework-agnostic and ready for health-gated canary (Phase 19) and the v1.6 E2E prod flows (Phase 20).

## Self-Check: PASSED

All 5 created files present, SUMMARY present, all 3 task commits found in git history.

---
*Phase: 18-observability-health-resilience*
*Completed: 2026-06-06*
