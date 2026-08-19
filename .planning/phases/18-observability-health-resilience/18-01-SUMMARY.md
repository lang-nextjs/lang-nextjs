---
phase: 18-observability-health-resilience
plan: 01
subsystem: observability
tags: [observability, hooks, edge-safe-timing, sse, copy-not-import]
requires: []
provides:
  - ObservabilityHooks interface (server + sveltekit + remix + edge)
  - getSafeCurrentTime() edge-safe timing util
  - handler lifecycle hook firing with try-catch containment
affects:
  - packages/server/src/handler.ts
  - packages/server/src/index.ts
  - packages/{sveltekit,remix,edge}/src/index.ts
tech-stack:
  added: []
  patterns:
    - vendor-neutral callback hooks (no APM SDK dependency)
    - copy-not-import type distribution (mirrors SseFrameAccumulator)
    - fail-open callback containment (throwing hook never aborts stream)
    - edge-safe time source (performance.now -> Date.now fallback)
key-files:
  created:
    - packages/server/src/timing.ts
    - packages/server/src/timing.test.ts
    - packages/server/src/observability.ts
    - packages/server/src/observability.test.ts
    - packages/server/src/handler.observability.test.ts
    - packages/sveltekit/src/observability.ts
    - packages/remix/src/observability.ts
    - packages/edge/src/observability.ts
  modified:
    - packages/server/src/handler.ts
    - packages/server/src/index.ts
    - packages/sveltekit/src/index.ts
    - packages/remix/src/index.ts
    - packages/edge/src/index.ts
decisions:
  - "bytesReceived is 0 in onFetchEnd (count unavailable pre-read); total byteCount reported via onStreamEnd."
  - "Framework copies are types-only; getSafeCurrentTime stays in server (handler-level firing in framework packages deferred per plan scope)."
metrics:
  duration: ~10 min
  completed: 2026-06-06
  tasks: 3
  files: 13
requirements: [OBS-01, OBS-02, OBS-03, OBS-04, OBS-05]
---

# Phase 18 Plan 01: Observability Hooks Summary

Vendor-neutral lifecycle observability hooks fire on the handler with timing/frame/byte metadata, fully contained in try-catch so a throwing consumer hook never aborts the SSE stream; edge-safe timing falls back from `performance.now()` to `Date.now()`; secret-free context types are exported from server and copy-distributed to sveltekit/remix/edge.

## What Was Built

- **`getSafeCurrentTime()`** (`timing.ts`): guards `performance.now()` availability and a throwing `performance.now()`, falling back to `Date.now()`. Tested across three platform scenarios (OBS-04).
- **`ObservabilityHooks`** (`observability.ts`): 8 lifecycle hooks (`onRequest`, `onFetchStart`, `onFetchEnd`, `onStreamStart`, `onTransformBegin`, `onTransformEnd`, `onError`, `onStreamEnd`) with per-hook context types carrying only safe scalars (OBS-01, OBS-03).
- **Handler integration** (`handler.ts`): `fireHook(name, fn)` wrapper routes every invocation through try-catch (OBS-02). Hooks fire at request accept, before fetch, after fetch (success + failure paths), stream start, mid-stream error, and stream end. `frameCount`/`byteCount` accumulators track enqueued frames and report via `onStreamEnd`.
- **Exports**: `ObservabilityHooks` (+ context types) and `getSafeCurrentTime` from server index; `ObservabilityHooks` from each framework index.
- **Copy-not-import distribution** (`sveltekit/remix/edge/src/observability.ts`): verbatim type copies with provenance comment; edge copy is Web-API-only (OBS-05).

## Verification Results

- `pnpm --filter @deepagents-nextjs/server test`: **23 files, 397 tests passing** (no regressions). New: 3 timing tests, 2 observability contract tests, 5 handler integration tests.
- `pnpm --filter @deepagents-nextjs/server typecheck`: clean.
- Throwing-hook + async-rejecting-hook integration tests prove the stream still delivers all frames and closes cleanly with no `upstream_disconnect` injection (OBS-02 CRITICAL gate).
- Runtime secret-safety test: handler given `authorization`/`cookie` headers and a body; no callback arg contains a forbidden field or leaks the secret values (OBS-03).
- `getSafeCurrentTime` returns finite numbers when `performance` is `undefined` and when `performance.now()` throws (OBS-04).
- sveltekit + remix + edge build with DTS; edge `observability.ts` has no `next/server`, `require(`, or `node:` imports (OBS-05).

## Deviations from Plan

None of substance. Two clarifications worth recording:
- **Test runner invocation**: package `test` script is `vitest run`, so file filters are passed via `pnpm test -- <files>` (the bare `--run` in the plan's verify snippet is already implied by the script).
- **Framework copies are types-only**: per the plan's own Task 3 note, only `ObservabilityHooks` types are distributed; `getSafeCurrentTime` and handler-level firing in framework packages are out of scope here.

## Must-Haves Satisfied

- Consumer registers lifecycle hooks; they fire with timing/frame/byte metadata observed in a test sink — YES (handler integration test).
- A hook that throws on every invocation does not abort/corrupt the stream; all frames delivered — YES (OBS-02 gate, sync + async variants).
- No raw auth headers/tokens/bodies reach any callback; context types contain only safe scalars — YES (static contract + runtime tests, grep guard).
- Timing resolves without crashing when `performance.now()` is absent (falls back to `Date.now()`) — YES.
- Hook types exported from server and copied into sveltekit/remix/edge — YES (build + grep verified).

## Commits

- `0eff582` feat(18-01): edge-safe timing util + observability hook types
- `ced1b79` feat(18-01): wire observability hooks into handler with try-catch containment
- `611853b` feat(18-01): copy observability types to sveltekit/remix/edge (OBS-05)

## Self-Check: PASSED
