---
phase: 17-canary-blue-green
plan: '02'
type: summary
subsystem: CI/CD
tags:
  - vercel
  - smoke-test
  - github-actions
  - deployment
  - ci
tech-stack:
  added:
    - Vercel CLI (npx vercel deploy)
    - GitHub Actions pull_request trigger
    - curl-based health validation
  patterns:
    - Preview URL extraction from .vercel/README.json
    - smoke-test as PR merge gate
    - multi-job workflow with dependency chain
key-files:
  created:
    - .github/workflows/smoke-test-staging.yml
dependency-graph:
  requires: []
  provides:
    - SMOKE-01: Automated smoke test CI workflow that runs against Vercel preview deployments
  affects: []
decisions:
  - Trigger is pull_request targeting main — automated on every PR
  - Uses --environment=preview for preview URL (not production)
  - Health check uses /health endpoint (proper liveness probe)
  - exit 1 on any failed check — fails PR check and blocks merge
  - Secrets required: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID
metrics:
  duration: ~1 min
  completed: 2026-05-18
  tasks: 1/1
---

# Phase 17 Plan 02: Smoke Test Staging Workflow — Summary

**One-liner:** GitHub Actions smoke test workflow that deploys open-swe to Vercel preview and runs /health checks as a PR merge gate.

## What

Created `.github/workflows/smoke-test-staging.yml` — an automated GitHub Actions workflow that:
1. Triggers on every pull request targeting `main`
2. Deploys open-swe to a Vercel preview URL using Vercel CLI
3. Runs smoke tests against the preview URL (GET /health, JSON validation, API runs check)
4. Fails the PR check if any smoke test fails (blocking merge)

## Verification

- `grep -c "pull_request" .github/workflows/smoke-test-staging.yml` — 1 (trigger)
- `grep -c "VERCEL_TOKEN" .github/workflows/smoke-test-staging.yml` — 2 (env + secret reference)
- `grep -c "OPENSWE_HEALTH_URL" .github/workflows/smoke-test-staging.yml` — 4 (env var + usages)

## Commits

| Hash | Message |
|------|---------|
| `73372ec` | feat(ci): add smoke-test-staging workflow for PR merge gate |

## Deviations from Plan

None — workflow created exactly as specified in plan.

## Auth Gates

None — this task did not require any authentication.

## Deferred Issues

None.

## Self-Check

- [FOUND] `.github/workflows/smoke-test-staging.yml` exists
- [FOUND] Commit `73372ec` in git history
- [VERIFIED] Workflow has `pull_request` trigger
- [VERIFIED] Workflow uses Vercel CLI with --environment=preview
- [VERIFIED] Smoke test checks OPENSWE_HEALTH_URL (preview URL + /health path)
- [VERIFIED] Failed checks cause `exit 1` which fails the PR check

**Self-Check: PASSED**