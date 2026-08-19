---
phase: 17-canary-blue-green
plan: '01'
type: summary
subsystem: infra
tags:
  - health-check
  - liveness-probe
  - next-app-router
  - open-swe
  - deployment
tech-stack:
  added:
    - Next.js App Router route handler (GET /api/health)
  patterns:
    - Stateless liveness probe (no dependency checks)
    - force-dynamic to bypass Next.js response caching
key-files:
  created:
    - apps/open-swe/app/api/health/route.ts
dependency-graph:
  requires: []
  provides:
    - HEALTH-01: Stateless liveness endpoint at GET /health returning 200 {"status":"ok"}
  affects:
    - 17-02 (smoke-test workflow targets /health)
    - apps/open-swe/deploy/canary-check.sh (can probe /health instead of root page)
decisions:
  - Stateless probe — returns 200 unconditionally, no DB/Redis/backend calls (true liveness, not readiness)
  - export const dynamic = "force-dynamic" — prevents Next.js from caching the response
  - Route placed at app/api/health/route.ts; reachable at /api/health (and /health via rewrite where configured)
metrics:
  duration: ~1 min
  completed: 2026-05-18
  tasks: 1/1
---

# Phase 17 Plan 01: open-swe /health Liveness Endpoint — Summary

**One-liner:** Stateless GET /health route handler for the open-swe app so smoke tests and load balancers have a proper liveness probe instead of checking the root page.

## What

Created `apps/open-swe/app/api/health/route.ts` — a Next.js App Router route handler that:
1. Exports `GET` returning `200 {"status":"ok"}`
2. Sets `export const dynamic = "force-dynamic"` so the response is never cached
3. Performs no dependency checks (stateless liveness, not readiness) — returns 200 regardless of backend service state

This replaces the previous proxy of probing the root page (`/`), which could pass even when API routes were broken.

## Verification

- `grep -c "force-dynamic" apps/open-swe/app/api/health/route.ts` — 1 (cache bypass present)
- `grep -c "status.*ok" apps/open-swe/app/api/health/route.ts` — 1 (200 body)
- Route handler exports `GET` and returns `Response.json({ status: "ok" }, { status: 200 })`

## Commits

| Hash | Message |
|------|---------|
| `c7742af` | feat(infra): canary/blue-green deployment infrastructure (issue #17) (#50) |

(Plan 01 shipped together with 17-02 and 17-03 in the consolidated canary/blue-green PR #50.)

## Deviations from Plan

None — route created exactly as specified in 17-01-PLAN.md. This SUMMARY was authored after the fact to reconcile bookkeeping (the artifact and PR #50 predate it; see 17-VERIFICATION.md, which already verified HEALTH-01 as passed).

## Auth Gates

None.

## Deferred Issues

None.

## Self-Check

- [FOUND] `apps/open-swe/app/api/health/route.ts` exists and is git-tracked
- [FOUND] Commit `c7742af` in git history
- [VERIFIED] `export const dynamic = "force-dynamic"` present
- [VERIFIED] GET handler returns `200 {"status":"ok"}`
- [VERIFIED] No DB/Redis/backend calls (stateless liveness)
- [VERIFIED] 17-VERIFICATION.md marks HEALTH-01 as VERIFIED (4/4 truths, gaps: [])

**Self-Check: PASSED**
