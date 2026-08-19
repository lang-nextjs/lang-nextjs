---
phase: 19-graceful-shutdown-deploy-docs
plan: 01
subsystem: server
tags: [graceful-shutdown, ops, lifecycle, readiness, node-only]
requirements: [OPS-01]
dependency-graph:
  requires:
    - "packages/server/src/health.ts createReadinessProbe (Phase 18-02 isDraining callback)"
  provides:
    - "createGracefulShutdown() factory: isDraining/trackStream/releaseStream/activeCount/dispose/installSignalHandlers"
    - "ShutdownConfig + GracefulShutdown types"
  affects:
    - "packages/server/src/index.ts public export surface"
tech-stack:
  added: []
  patterns:
    - "Per-instance factory (no module-scope mutable state)"
    - "Injectable onExit for testable process termination"
    - "process.once signal registration (MaxListeners-safe), opt-in"
    - "setTimeout-driven poll loop (fake-timer testable)"
key-files:
  created:
    - "packages/server/src/shutdown.ts"
    - "packages/server/src/shutdown.test.ts"
  modified:
    - "packages/server/src/index.ts"
decisions:
  - "Exit is injectable (onExit, default process.exit) — unit tests pass a spy, real process.exit never runs in tests."
  - "Signal handlers are opt-in via installSignalHandlers() using process.once; importing shutdown.ts registers zero listeners."
  - "Drain uses a setTimeout-driven poll (50ms interval) bounded by a safety deadline so fake timers can drive it and a hung stream can never block exit."
metrics:
  duration: ~6 min
  completed: 2026-06-06
  tasks: 3
  files: 3
  tests-added: 15
  tests-total: 454
---

# Phase 19 Plan 01: createGracefulShutdown Factory Summary

Node-only, opt-in graceful-shutdown orchestrator that flips a per-instance draining flag (wired into Phase 18 `createReadinessProbe` for SIGTERM→503), drains in-flight SSE streams up to a configurable `drainTimeoutMs`, and guarantees exit via a safety timeout — with fully injectable, testable exit.

## What Was Built

- `createGracefulShutdown(config?)` factory returning `{ isDraining, trackStream, releaseStream, activeCount, dispose, installSignalHandlers }`.
- Per-instance state only: `draining`/`disposed` booleans + `activeStreams` Set live inside the factory closure — no module-scope mutable state.
- `dispose()`: idempotent, flips `draining=true` first (readiness returns 503 immediately), polls `activeStreams.size` every 50ms against a `drainTimeoutMs` deadline; clean drain → `onExit(0)`, safety timeout with streams still active → `onExit(1)`.
- `installSignalHandlers()`: registers `process.once('SIGTERM'|'SIGINT')` → `dispose()`, returns an uninstall fn; importing the module alone registers nothing.
- Exported additively from `index.ts` (`createGracefulShutdown` + `ShutdownConfig`/`GracefulShutdown` types); all Phase 18 exports preserved.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 (RED) | Failing graceful-shutdown tests | `3e7fcea` | packages/server/src/shutdown.test.ts |
| 2 (GREEN) | Implement createGracefulShutdown factory | `6458dbe` | packages/server/src/shutdown.ts |
| 3 | Additive export from server index | `e216bd3` | packages/server/src/index.ts |

## Verification

- `pnpm --filter @deepagents-nextjs/server test` → 29 files, **454 passed** (439 baseline + 15 new shutdown tests; no Phase 18 regressions).
- RED confirmed: test failed with "Cannot find module './shutdown'" before implementation.
- Drain wait + safety timeout proven with fake timers: `onExit(0)` on clean drain, `onExit(1)` on hung stream; configurable `drainTimeoutMs` respected (300ms < 500 no exit, then exit).
- Readiness integration: `createReadinessProbe({ isDraining: () => s.isDraining() })` → `{ready:true,status:"ok"}` before dispose, `{ready:false,status:"draining"}` after.
- Opt-in proven: factory creation registers no SIGTERM/SIGINT listener; `installSignalHandlers()` increments listener count by 1 each, uninstall fn returns count to prior.
- `grep` confirmed no module-scope `let`/`Set`/`Map` mutable state in shutdown.ts.
- `pnpm --filter @deepagents-nextjs/server build` → tsup CJS+ESM+DTS success (typecheck green).

## must_haves (OPS-01) — Satisfied

- SIGTERM flips readiness to 503 via `isDraining()` → `createReadinessProbe` — covered by readiness-integration test.
- In-flight streams drained: `dispose()` waits while `activeCount() > 0` up to `drainTimeoutMs` — covered by drain-then-exit-0 test.
- Safety timeout guarantees exit even if a stream never closes — covered by hung-stream `onExit(1)` test.
- Opt-in, consumer-installed: factory returns tracker + handler, no auto SIGTERM listener on import — covered by no-listener-on-creation test.
- Per-instance tracking via trackStream/releaseStream, no module-scope singleton — covered by two-instance isolation test + grep.

## Deviations from Plan

None — plan executed exactly as written. REFACTOR step skipped (drain loop already minimal and clean; tests green).

## Self-Check: PASSED

- FOUND: packages/server/src/shutdown.ts
- FOUND: packages/server/src/shutdown.test.ts
- FOUND: createGracefulShutdown export in packages/server/src/index.ts
- FOUND commits: 3e7fcea, 6458dbe, e216bd3
