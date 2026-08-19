---
phase: 19-graceful-shutdown-deploy-docs
plan: 02
subsystem: docs-ops
tags: [deployment, runbook, graceful-shutdown, health-gated-rollout, canary, k8s, ops]
requirements: [OPS-03, OPS-04]
dependency-graph:
  requires:
    - "packages/server/src/health.ts createReadinessProbe (Phase 18-02)"
    - "packages/server/src/shutdown.ts createGracefulShutdown (Phase 19-01)"
    - "apps/open-swe Phase 17 canary infra (vercel.json + smoke-test-staging.yml)"
  provides:
    - "docs/DEPLOYMENT-RUNBOOK.md: canary/blue-green + K8s probe wiring + serverless limits + health-gated rollout"
    - "docs/GRACEFUL-SHUTDOWN.md: createGracefulShutdown API + integration + serverless limits"
    - "apps/open-swe /api/ready route wired to createReadinessProbe (the rollout health-gate)"
  affects:
    - "apps/open-swe public route surface (+/api/ready)"
    - ".github/workflows/smoke-test-staging.yml (readiness gate step)"
    - "apps/open-swe/vercel.json (traffic split + retained automatic rollback)"
tech-stack:
  added:
    - "apps/open-swe -> @deepagents-nextjs/server (workspace dep, internal package; zero new runtime deps)"
  patterns:
    - "Readiness probe as the single bidirectional rollout gate (promote via smoke-test, de-promote via vercel rollback)"
    - "Workflow gate steps degrade cleanly (skip on empty BASE_URL) — manual-only posture preserved"
key-files:
  created:
    - "docs/DEPLOYMENT-RUNBOOK.md"
    - "docs/GRACEFUL-SHUTDOWN.md"
    - "apps/open-swe/app/api/ready/route.ts"
  modified:
    - "apps/open-swe/vercel.json"
    - "apps/open-swe/package.json"
    - ".github/workflows/smoke-test-staging.yml"
    - "pnpm-lock.yaml"
decisions:
  - "Chose planner option (a): added a REAL /api/ready route wired to createReadinessProbe rather than gating on /health — makes the health-gate genuinely exercise the Phase 18 API and avoids a dangling route reference."
  - "Used /api/ready (the actual Next.js app-dir path) in vercel.json + workflow rather than a bare /ready, so the gate hits a route that resolves (the pre-existing bare /health references are Phase 17 / out of scope)."
  - "Added @deepagents-nextjs/server as a workspace dep to open-swe — internal package, not a new third-party runtime dependency, so the zero-new-runtime-deps constraint holds."
metrics:
  duration: ~7 min
  completed: 2026-06-06
  tasks: 3
  files: 7
  tests-total: 170 (open-swe; all green)
---

# Phase 19 Plan 02: Deployment Runbook + Graceful-Shutdown Docs + Health-Gated Rollout Summary

Documented the production deploy story (canary/blue-green, Kubernetes
liveness/readiness probe wiring with preStop→SIGTERM drain ordering, serverless
shutdown limits) and the `createGracefulShutdown` API shipped in 19-01, then
formalized the Phase 17 open-swe canary infra as a health-gated rollout by adding
a real `/api/ready` route (backed by `createReadinessProbe`), a readiness gate
step in the smoke-test workflow, and a `/api/ready` entry in the vercel.json
traffic split — closing OPS-03 and OPS-04.

## What Was Built

- **docs/GRACEFUL-SHUTDOWN.md** (150 lines) — documents the EXACT shipped
  `createGracefulShutdown` API (`isDraining`, `trackStream`, `releaseStream`,
  `activeCount`, `dispose`, `installSignalHandlers`; `ShutdownConfig` =
  `drainTimeoutMs`/`onExit`/`logger`), a full TS integration example wiring
  `isDraining()` into `createReadinessProbe` and track/release via the handler
  `onRequest`/`onStreamEnd` hooks, the MaxListeners (install-once) pitfall, drain
  timeout guidance, and Vercel ~500ms / Cloudflare no-SIGTERM limits with
  client-reconnection mitigation.
- **docs/DEPLOYMENT-RUNBOOK.md** (154 lines) — Canary, Blue-Green, Kubernetes
  Probe Wiring (Deployment YAML with liveness/readiness + preStop +
  `terminationGracePeriodSeconds` aligned to `drainTimeoutMs`, and the explicit
  ordering: preStop → readiness flips 503 first → SIGTERM drain → exit),
  Serverless Graceful-Shutdown Limits, and a Health-Gated Rollout section tying
  promotion (smoke-test readiness gate) and de-promotion (vercel automatic
  rollback) to `createReadinessProbe`.
- **apps/open-swe/app/api/ready/route.ts** — new readiness route calling
  `createReadinessProbe()`, returning 200 when ready and 503 when draining; this
  is the real rollout health-gate.
- **vercel.json** — `/api/ready` added to the traffic split alongside `/health`;
  `rollback.automatic: true` + `errorThreshold` retained (health-driven rollback).
- **smoke-test-staging.yml** — added a "Readiness gate (/api/ready 200)" step that
  skips with a clear message when `BASE_URL` is empty, fails on non-200, and stays
  manual-trigger (`workflow_dispatch`) only; references the runbook.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | docs/GRACEFUL-SHUTDOWN.md (OPS-03) | `e83815a` | docs/GRACEFUL-SHUTDOWN.md |
| 2 | docs/DEPLOYMENT-RUNBOOK.md (OPS-03) | `c565a22` | docs/DEPLOYMENT-RUNBOOK.md |
| 3 | Health-gated rollout: /api/ready route + vercel.json + workflow (OPS-04) | `6cc39f1` | apps/open-swe/app/api/ready/route.ts, apps/open-swe/vercel.json, apps/open-swe/package.json, .github/workflows/smoke-test-staging.yml, pnpm-lock.yaml, docs/DEPLOYMENT-RUNBOOK.md |

## Verification

- Doc grep gates pass: GRACEFUL-SHUTDOWN.md has `createGracefulShutdown`, `500ms`,
  `Cloudflare`, `createReadinessProbe`; RUNBOOK has `Canary`, `Blue-Green`,
  `readinessProbe`, `preStop`, `500ms`, `Cloudflare`, `createReadinessProbe`,
  `health-gated`.
- `vercel.json` is valid JSON; contains `rollback` + the `/api/ready` split entry.
- Workflow: contains `readiness`, has `workflow_dispatch`, no real `pull_request`
  trigger (only the pre-existing re-enable comment, kept intact per constraints);
  YAML parses cleanly.
- `pnpm --filter open-swe typecheck` → clean (new route typechecks against
  `@deepagents-nextjs/server`).
- `pnpm --filter open-swe test` → 17 files, **170 passed**.
- `pnpm --filter open-swe build` → compiled successfully; `/api/ready` registered
  as a dynamic route.
- `pnpm --filter @deepagents-nextjs/server build` → CJS+ESM+DTS success
  (route consumes built dist).
- Artifact min_lines satisfied: RUNBOOK 154 (>=90), SHUTDOWN 150 (>=50).

## must_haves (OPS-03, OPS-04) — Satisfied

- OPS-03: runbook documents canary + blue-green with concrete steps; K8s
  liveness/readiness YAML tied to createHealthProbe/createReadinessProbe with
  preStop/SIGTERM ordering; serverless limits (Vercel ~500ms, Cloudflare
  no-SIGTERM) with client-resilience recommendation; createGracefulShutdown
  documented with a working consumer integration wiring isDraining() into
  createReadinessProbe.
- OPS-04: Phase 17 canary infra formalized as a health-gated rollout —
  smoke-test readiness gate + vercel.json health-driven rollback both reference
  the Phase 18 readiness probe, and a real /api/ready route makes the gate live.

## Deviations from Plan

**1. [Rule 3 - Blocking] open-swe did not depend on @deepagents-nextjs/server**
- **Found during:** Task 3
- **Issue:** The planner preferred a real `/ready` route wired to
  `createReadinessProbe`, but open-swe had no dependency on the server package.
- **Fix:** Added `@deepagents-nextjs/server: "workspace:*"` to open-swe
  dependencies and ran `pnpm install` (workspace/internal package — not a new
  third-party runtime dep, so the zero-new-runtime-deps constraint holds).
- **Files modified:** apps/open-swe/package.json, pnpm-lock.yaml
- **Commit:** `6cc39f1`

**2. [Decision] Route path is /api/ready, not bare /ready**
- **Found during:** Task 3 verification
- **Issue:** The plan's verify command referenced `/ready`, but open-swe's
  Next.js app-dir places the route at `/api/ready` (matching the existing
  `/api/health`). The pre-existing vercel.json/workflow `/health` references are a
  Phase 17 artifact and out of scope.
- **Fix:** Used the real `/api/ready` path in vercel.json, the workflow gate, and
  the runbook health-gate reference so the gate hits a route that actually
  resolves — honoring the planner's "no dangling route reference" instruction.
- **Files modified:** vercel.json, smoke-test-staging.yml, DEPLOYMENT-RUNBOOK.md
- **Commit:** `6cc39f1`

**3. [Housekeeping] Reverted auto-generated next-env.d.ts**
- **Found during:** Task 3 (after `next build`)
- **Issue:** `next build` rewrote `apps/open-swe/next-env.d.ts` (a Next-managed,
  "do not edit" file) to a Next 16 format change unrelated to this plan.
- **Fix:** Reverted it to keep the commit scoped to plan work; it regenerates on
  any build.

**Verify-command note:** Task 3's literal verify includes `! grep -q
"pull_request"`, which fails only because the workflow header keeps a comment
explaining how to re-enable a `pull_request` trigger (constraints explicitly
require keeping that note intact). Confirmed via a comment-stripped parse that no
real `pull_request` trigger exists — the intent (manual-only) is satisfied.

## Self-Check: PASSED

- FOUND: docs/DEPLOYMENT-RUNBOOK.md
- FOUND: docs/GRACEFUL-SHUTDOWN.md
- FOUND: apps/open-swe/app/api/ready/route.ts
- FOUND: /api/ready in apps/open-swe/vercel.json
- FOUND: Readiness gate in .github/workflows/smoke-test-staging.yml
- FOUND commits: e83815a, c565a22, 6cc39f1
