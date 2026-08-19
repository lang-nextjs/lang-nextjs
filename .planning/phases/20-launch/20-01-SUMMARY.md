---
phase: 20-launch
plan: 01
subsystem: observability
tags: [docs, example, observability, error-reporting, OPS-02]
requires:
  - "packages/server/src/observability.ts (OnErrorContext, onError hook — Phase 18)"
provides:
  - "docs/ERROR-REPORTING.md — Sentry/Datadog onError wiring guide"
  - "packages/server/README.md — Error Reporting & Observability section"
  - "apps/example stream-observed route — runnable SDK-free onError reference"
affects:
  - "consumers wiring APM/error-reporting through the observability hook"
tech-stack:
  added: []
  patterns:
    - "Vendor-neutral onError hook → consumer-owned APM SDK (BYO SDK, never bundled)"
key-files:
  created:
    - docs/ERROR-REPORTING.md
    - apps/example/app/api/chat/stream-observed/route.ts
  modified:
    - packages/server/README.md
decisions:
  - "Console-based reporter in the example (zero new runtime deps) with Sentry/Datadog shown as documented snippets only"
metrics:
  duration: ~6m
  completed: 2026-06-06
---

# Phase 20 Plan 01: Error-Reporting Docs & Example (OPS-02) Summary

Documented and demonstrated how a consumer wires error reporting through the existing observability `onError` hook to Sentry/Datadog — with zero vendor SDK bundled in any package. No source changes to `@deepagents-nextjs/server` (the `onError` hook and `OnErrorContext` shipped in Phase 18).

## What Was Built

- **docs/ERROR-REPORTING.md** (142 lines): Overview (BYO SDK, none bundled), an `OnErrorContext` field/safety table mapped to vendor calls (`sessionId` flagged as potentially user-identifying), Sentry (`Sentry.captureException`) and Datadog (`datadogRum.addError`) examples adapted from 20-RESEARCH.md, the read-only-telemetry caveat (throwing never aborts the stream), the fast-hook caveat, and the consumer-supplied env-var note.
- **packages/server/README.md**: New `## Error Reporting & Observability` section between API Reference and Approval Gating, with a minimal `onError` snippet and a link to `docs/ERROR-REPORTING.md`. States no vendor SDK is bundled.
- **apps/example/app/api/chat/stream-observed/route.ts**: Runnable reference route importing `createDeepAgentsHandler` + `type OnErrorContext`, defining a SDK-free `reportError(ctx)` console reporter, resolving `BACKEND_URL` and falling through to the existing mock when unset, and wiring `observability: { onError: reportError }`.

## Field mapping (source of truth)

Docs use exactly the `OnErrorContext` fields from `packages/server/src/observability.ts`: `type`, `error`, `durationMs`, `frameIndex?`, `sessionId`, `timestamp`. No fields invented.

## Verification

| Check | Result |
| ----- | ------ |
| `grep -c onError docs/ERROR-REPORTING.md` >= 2 | 12 |
| `Sentry.captureException` in docs | match |
| `datadogRum.addError` in docs | match |
| `OnErrorContext` in docs | match |
| read-only/never-aborts caveat in docs | match |
| docs >= 60 lines | 142 |
| README has error-reporting/onError + ERROR-REPORTING link | match |
| route has onError/OnErrorContext | match |
| no `@sentry`/`@datadog` in any package.json | no matches (guard passed) |
| `pnpm --filter example typecheck` | PASS (exit 0, no errors) |

## OPS-02 must_haves

- Documented Sentry example wiring `onError` → `Sentry.captureException`, no SDK bundled — satisfied.
- Documented Datadog example wiring `onError` → Datadog error API, no SDK bundled — satisfied.
- Docs map secret-safe `OnErrorContext` fields to vendor calls and warn `onError` is read-only telemetry — satisfied.
- No `@sentry/*` or `@datadog/*` in any package.json — satisfied (grep guard green).

## Deviations from Plan

None — plan executed exactly as written.

## Commits

- 39b7acd: docs(20-01): add error-reporting guide for onError → Sentry/Datadog
- 2674f20: feat(20-01): add error-reporting README section + SDK-free example route

## Self-Check: PASSED

All created/modified files exist on disk; both task commits present in git history.
