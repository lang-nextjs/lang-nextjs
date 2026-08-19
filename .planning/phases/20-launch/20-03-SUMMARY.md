---
phase: 20-launch
plan: 03
subsystem: release-engineering
tags: [changeset, release, migration-docs, vercel, health-probe]
requires:
  - "v1.6 additive surface (Phases 18/19): observability, resilience, graceful shutdown, probes"
  - "docs/ERROR-REPORTING.md (20-01)"
  - "OPS-05 E2E coverage (20-02)"
provides:
  - "Staged v1.6 minor-bump changeset (.changeset/v16-observability-resilience-shutdown.md)"
  - "docs/MIGRATION-v1.6.md non-breaking upgrade notes"
  - "Normalized /api/health references for open-swe (vercel.json + staging smoke test)"
affects:
  - "@deepagents-nextjs/server, react, edge, sveltekit, remix (staged for minor bump)"
  - "apps/open-swe deployment health-gate routing"
tech-stack:
  added: []
  patterns:
    - "Stage-only release: changeset markdown + written notes; version/publish deferred to CI"
key-files:
  created:
    - ".changeset/v16-observability-resilience-shutdown.md"
    - "docs/MIGRATION-v1.6.md"
  modified:
    - "apps/open-swe/vercel.json"
    - ".github/workflows/smoke-test-staging.yml"
decisions:
  - "Declared MINOR (not patch) bump despite pre-1.0 (0.1.0) versions, per locked constraint, to signal the v1.6 additive feature set"
  - "Fixed both smoke-test-staging.yml /health probes alongside vercel.json — same open-swe deployment, same bug; left Python backend /health refs untouched (out of scope)"
metrics:
  duration: ~4min
  completed: 2026-06-06
---

# Phase 20 Plan 03: v1.6.0 Release Prep (Staged) Summary

Staged the v1.6.0 release without publishing: a minor-bump changeset declaring the additive observability/resilience/graceful-shutdown surface as non-breaking, plus `docs/MIGRATION-v1.6.md` documenting the drop-in v1.5→v1.6 upgrade, and normalized the bare `/health` reference to `/api/health` for the open-swe deployment.

## What Was Built

### Task 1 — Staged changeset + migration notes (commit 7228d8b)
- `.changeset/v16-observability-resilience-shutdown.md`: `minor` for all five v1.6 packages — `@deepagents-nextjs/server` + `react` (fixed group per config.json), plus `edge`, `sveltekit`, `remix`. Body summarizes the additive surface (observability lifecycle hooks, resilience 429/503/timeout/retry, `createGracefulShutdown`) and states explicitly that all options are opt-in/additive with zero new runtime deps and preserved edge compatibility; links ERROR-REPORTING.md + MIGRATION-v1.6.md.
- `docs/MIGRATION-v1.6.md` (82 lines): "What's New in v1.6" (each feature group with its option/export name, references OPS-05 E2E coverage) + "Upgrade Path (v1.5 → v1.6)" stating the non-breaking, drop-in nature with a before/after showing the same handler call works unchanged plus an opt-in observability+resilience example. Links `./ERROR-REPORTING.md`.

### Task 2 — Normalize /health → /api/health (commit b8a9cec)
- `apps/open-swe/vercel.json`: traffic split `/health` → `/api/health` (matches the real route at `apps/open-swe/app/api/health/route.ts`; sibling `/api/ready` already correct). No other changes; still valid JSON.
- `.github/workflows/smoke-test-staging.yml`: the two `$BASE_URL/health` probes (status + JSON checks) hitting the open-swe Vercel deployment normalized to `/api/health`, matching the same bug.

## Verification Results

| Check | Result |
| ----- | ------ |
| changeset file exists, server+react minor, obs/resil/shutdown present | PASS |
| MIGRATION-v1.6.md: non-breaking/additive/opt-in + ERROR-REPORTING + ≥40 lines (82) | PASS |
| `changeset status` (read-only) | N/A — fails on local `main` divergence (env: baseBranch main not synced); file presence verified, fallback echo per plan |
| vercel.json: `/api/health` present, bare `/health` gone, valid JSON | PASS |
| smoke-test-staging.yml: bare `$BASE_URL/health` gone, `/api/health` present, valid YAML | PASS |
| No `changeset version` / `publish` / `npm publish` run | CONFIRMED |
| Zero new runtime deps | CONFIRMED (no package.json changes) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Fixed matching bare /health in smoke-test-staging.yml**
- **Found during:** Task 2
- **Issue:** The plan's Task 2 targeted only vercel.json, but the context flagged "smoke-test workflow if it has the same bare reference." `.github/workflows/smoke-test-staging.yml` (the open-swe Vercel preview smoke test, `working-directory: apps/open-swe`) had two `$BASE_URL/health` probes hitting the same deployment with the same broken path — its sibling readiness check already correctly used `/api/ready`, identical to the vercel.json pattern.
- **Fix:** Normalized both `$BASE_URL/health` probes (HTTP status + JSON checks) to `/api/health`. Left the Python Django/FastAPI backend `/health` refs in smoke-test.yml and e2e.yml untouched (separate services, out of scope).
- **Files modified:** `.github/workflows/smoke-test-staging.yml`
- **Commit:** b8a9cec

### Environment Note (not a deviation)
- `pnpm changeset status` errors locally with "Failed to find where HEAD diverged from main" because baseBranch is `main` and the local branch (`feat/v1.6-phase-20`) has no synced local `main`. The plan's verify step explicitly allows the `|| echo` fallback ("file presence already verified"); this is the expected read-only outcome in this environment and does not affect the staged deliverable (CI resolves base correctly).

## must_haves Satisfied

- ✅ Staged changeset declares a minor bump for the @deepagents-nextjs packages describing observability/resilience/onShutdown as non-breaking
- ✅ Migration note documents v1.5→v1.6 as drop-in, backward-compatible: existing code unchanged, new options opt-in additive
- ✅ No publish performed — `changeset version` / `npm publish` NOT run; deliverable is staged changeset + written notes only
- ✅ Bare `/health` in vercel.json normalized to `/api/health` (plus the matching staging smoke-test probes)

## Self-Check: PASSED

All created/modified files present; both task commits (7228d8b, b8a9cec) confirmed in git history.
