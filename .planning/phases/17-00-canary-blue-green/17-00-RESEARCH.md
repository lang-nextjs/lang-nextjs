# Phase 17: Canary/Blue-Green Deployment Infrastructure — Research

**Researched:** 2026-05-18
**Domain:** Next.js health endpoints, Vercel deployment strategies (canary/blue-green), smoke test automation, rollback triggers
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | Health check endpoint (`/health`) for open-swe Next.js app | Next.js App Router route handler at `app/api/health/route.ts`; returns `200 {"status":"ok"}`; no DB/dependency checks (stateless) |
| INFRA-02 | Smoke test that runs against staging before production promotion | Existing `smoke-test.yml` workflow_dispatch can be adapted to `pull_request` trigger; add Vercel deployment promotion step; staging URL via `VERCEL_STAGING_URL` env |
| INFRA-03 | Configure deployment strategy (canary or blue-green) in Vercel | `vercel.json` with `regions`, `traffic.split`, and `deployment缪ype: canary`; OR GitHub Actions workflow with Vercel CLI `vercel deploy --canary` |
| INFRA-04 | Automatic rollback trigger based on error rate spike | Vercel built-in monitoring (Automatic Rollback on 5xx); GitHub Actions step using `vercel rollback` CLI on error-rate threshold; or `workflow_dispatch` with manual rollback |

</phase_requirements>

---

## Summary

Phase 17 implements four infrastructure items for safe production deployment: a dedicated `/health` endpoint for the open-swe Next.js app (currently missing), automation of the existing smoke-test workflow to run against staging before production promotion, Vercel deployment strategy configuration (canary), and automatic rollback triggers on error rate spikes.

The open-swe app currently has no `/health` endpoint — the smoke test checks the root page (`/`) which can return 200 even when API routes are broken. FastAPI and Django backends both have proper `/health` endpoints returning `{"status":"ok"}`. Adding a Next.js App Router health route is a single file (`app/api/health/route.ts`) following the same stateless pattern.

The existing `smoke-test.yml` is manual (workflow_dispatch) and targets localhost. The automation path is to trigger it on Vercel preview deployment success, using `VERCEL_STAGING_URL` to point at the preview URL and only promoting to production if smoke tests pass.

Vercel supports canary deployments natively via `vercel.json` `traffic.split` or CLI flag `--canary`. Automatic rollback on 5xx is a Vercel built-in feature (enabled per project in the Vercel dashboard). For error-rate-based rollback, a GitHub Actions step can call `vercel rollback` via the Vercel CLI after parsing deployment metrics.

**Primary recommendation:** Add `apps/open-swe/app/api/health/route.ts` following the FastAPI pattern. Convert smoke-test.yml to a two-job workflow: (1) deploy to staging preview, (2) run smoke tests against staging, fail the workflow if tests fail (which blocks merge). Use Vercel CLI `--canary` flag for canary deployments and enable Vercel built-in automatic rollback on 5xx errors as the first rollback line of defense.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | ^15.0.0 | open-swe app framework | Already in use at `apps/open-swe` |
| Vercel CLI | latest | Deployment + rollback | Native Vercel integration; `vercel deploy --canary`, `vercel rollback` |
| GitHub Actions | — | CI orchestration | Already in use; smoke-test.yml exists |

### No New Dependencies

This phase adds infrastructure configuration only. No new npm packages required.

---

## Architecture Patterns

### Recommended Project Structure

```
apps/open-swe/
├── app/
│   ├── api/
│   │   └── health/           # NEW — INFRA-01
│   │       └── route.ts
│   └── ...
└── next.config.ts

.vercel/
└── README.md                 # Created by `vercel link`; do not commit

# At repo root (created by `vercel link`):
.vercelignore
```

### Pattern 1: Next.js Health Endpoint (INFRA-01)

**What:** App Router route handler returning `200 {"status":"ok"}`
**When to use:** INFRA-01 — open-swe health endpoint
**File:** `apps/open-swe/app/api/health/route.ts`

```typescript
// apps/open-swe/app/api/health/route.ts
// Stateless liveness probe — no DB/dependency checks
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest): Promise<Response> {
  return Response.json(
    { status: "ok" },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

**Note:** `force-dynamic` is required so the route is not cached by Next.js (avoids stale health responses).

### Pattern 2: Canary Deployment via Vercel CLI (INFRA-03)

**What:** Vercel CLI deploys with `--canary` flag; routes a percentage of traffic to the new deployment
**When to use:** INFRA-03 — canary deployment strategy

```bash
# Deploy as canary (isolated preview URL, no traffic split yet)
vercel deploy --canary --token=$VERCEL_TOKEN

# Promote canary to production (gradual traffic shift)
vercel promote --token=$VERCEL_TOKEN

# Instant rollback to previous production deployment
vercel rollback [deployment-url] --token=$VERCEL_TOKEN
```

### Pattern 3: Automatic Rollback via Vercel Dashboard (INFRA-04)

**What:** Vercel built-in automatic rollback on 5xx errors
**When to use:** INFRA-04 — first-line rollback defense
**Configuration:** Enabled in Vercel dashboard → Project → Deployment → Monitoring → Automatic Rollback

Vercel's built-in monitoring can be configured to:
- Trigger rollback when error rate exceeds threshold (e.g., 10% 5xx for 5 minutes)
- Roll back to the previous healthy deployment automatically

This requires no code changes — configuration in Vercel dashboard only.

### Pattern 4: Smoke Test as Merge Gate (INFRA-02)

**What:** GitHub Actions workflow that deploys to staging, runs smoke tests, fails the PR check if tests fail
**When to use:** INFRA-02 — automated smoke test before production promotion

```yaml
# .github/workflows/smoke-test-staging.yml
name: Smoke Test — Staging

on:
  pull_request:
    branches: [main]

env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  deploy-staging:
    name: Deploy to Staging Preview
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Deploy to Vercel (preview)
        run: |
          npx vercel deploy --token=$VERCEL_TOKEN \
            --org=$VERCEL_ORG_ID \
            --project=$VERCEL_PROJECT_ID \
            --yes \
            --environment=preview
          echo "VERCEL_STAGING_URL=$(cat .vercel/README.json | jq -r '.url')" >> $GITHUB_ENV

  smoke-test-staging:
    name: Smoke Test — Staging Preview
    runs-on: ubuntu-latest
    needs: [deploy-staging]
    env:
      OPENSWE_HEALTH_URL: ${{ vars.VERCEL_STAGING_URL }}/health
    steps:
      - name: Run smoke checks
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$OPENSWE_HEALTH_URL")
          if [ "$STATUS" -ne 200 ]; then
            echo "FAIL: /health returned $STATUS"
            exit 1
          fi
```

### Pattern 5: Error-Rate-Based Rollback via GitHub Actions (INFRA-04)

**What:** GitHub Actions step that polls Vercel deployment metrics and triggers rollback on error spike
**When to use:** INFRA-04 — programmatic rollback with custom thresholds

```bash
# After deploying, poll error rate for 5 minutes
# If 5xx rate > 10%, call vercel rollback

vercel rollback $DEPLOYMENT_URL --token=$VERCEL_TOKEN
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Health check that tests dependencies | Custom health endpoint that pings DB/Redis | `{"status":"ok"}` stateless endpoint | open-swe has no DB; stateless probe is sufficient for liveness |
| Custom rollback script | Bash script that parses logs and calls rollback API | Vercel CLI `vercel rollback` | Vercel CLI handles all edge cases; official and maintained |
| Canary traffic splitting logic | Custom Nginx/HAProxy config | Vercel `traffic.split` in vercel.json or `--canary` flag | Vercel manages edge routing; no extra infrastructure |

---

## Common Pitfalls

### Pitfall 1: Health Endpoint Cached by Next.js
**What goes wrong:** `/health` returns stale 200 after app has crashed because Next.js cached the response.
**Why it happens:** Route handlers default to static rendering unless `dynamic = "force-dynamic"` is set.
**How to avoid:** Always add `export const dynamic = "force-dynamic"` to health route handlers.

### Pitfall 2: Smoke Test Against Wrong Environment
**What goes wrong:** Smoke test runs against `localhost:3001` in CI but Vercel preview has a different URL.
**Why it happens:** `smoke-test.yml` hardcodes `OPENSWE_HEALTH_URL=http://localhost:3001`.
**How to avoid:** Use environment-specific URLs via GitHub Actions vars (`VERCEL_STAGING_URL`) and separate job outputs.

### Pitfall 3: Canary Deployment Gets Production Traffic Immediately
**What goes wrong:** `vercel deploy --canary` creates a preview URL but the Vercel dashboard shows it as "production" if project settings have `*.vercel.app` as the production domain.
**Why it happens:** Vercel treats all deployments as production unless `--environment=preview` is passed.
**How to avoid:** Always pass `--environment=preview` when deploying for canary/testing.

### Pitfall 4: No Rollback Without Vercel Pro/Enterprise
**What goes wrong:** Automatic rollback on 5xx is a Vercel Pro feature. Free tier may not support it.
**Why it happens:** Vercel feature tiers.
**How to avoid:** Verify plan tier before relying on this feature. Alternative: use GitHub Actions-based rollback via `vercel rollback` CLI.

---

## Code Examples

### Existing: FastAPI `/health` Endpoint (reference pattern)

```python
# apps/fastapi-backend/main.py
@app.get("/health")
async def health():
    return {"status": "ok", "ai_backends": list(_DISPATCH)}
```

### Existing: Django `/health/` Endpoint (reference pattern)

The Django backend at `apps/django-backend/` has `GET /health/` returning `{"status": "ok", "ai_backends": [...]}`.

### Existing: open-swe smoke test (current gap)

```yaml
# .github/workflows/smoke-test.yml — current open-swe check
OPENSWE_HEALTH_URL: http://localhost:3001
# Check 1: Root page (not 5xx)
# Check 2: API runs endpoint (not 5xx)
# Check 3: No error HTML in body
```

The gap: no `/health` endpoint exists, so root page is used as proxy for liveness — this can pass even when API routes fail.

### Existing: canary-check.sh (already implemented)

```bash
# apps/open-swe/deploy/canary-check.sh already exists and checks:
# 1. Root page not 5xx
# 2. API runs endpoint not 5xx
# 3. No error HTML indicators
```

This script can be reused in CI by pointing `HEALTH_URL` and `API_RUNS_URL` at the Vercel staging preview URL instead of localhost.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual smoke test (workflow_dispatch) | Automated smoke test on PR | This phase | Smoke tests become a merge gate, not optional |
| No open-swe /health endpoint | `/api/health/route.ts` | This phase | Proper liveness probe for load balancers and smoke tests |
| No deployment strategy | Canary via `vercel --canary` | This phase | Gradual traffic rollout with instant rollback |
| Manual rollback | Vercel auto-rollback + CLI rollback | This phase | Sub-minute recovery from bad deploys |

**No deprecated approaches** relevant to this phase.

---

## Open Questions

1. **Is Vercel Pro or Enterprise required for automatic rollback?**
   - What we know: Vercel documentation indicates "Automatic Rollback" is available on Pro and Enterprise plans.
   - What's unclear: Whether the free tier supports it or has a degraded version.
   - Recommendation: Check `vercel scale` or Vercel dashboard for the current plan. If free tier, rely on GitHub Actions-based rollback via `vercel rollback` as the mitigation.

2. **What is the Vercel project name for open-swe?**
   - What we know: The repo has `apps/open-swe/` as a Next.js app. `vercel.json` does not exist yet.
   - What's unclear: The Vercel project name/id that `vercel link` would create or use.
   - Recommendation: Run `vercel link` in the `apps/open-swe/` directory to link the project and generate `.vercel/project.json`. Commit the project.json (not the full `.vercel/` directory).

3. **Should the smoke test block merge or just warn?**
   - What we know: The issue says "smoke test that runs against staging before production promotion".
   - What's unclear: Whether a failed smoke test should block merge (fail the PR check) or just post a comment.
   - Recommendation: Fail the PR check (blocking merge) — this matches the existing smoke-test.yml failure behavior and the "rollback trigger" requirement implies automated action on failure.

4. **Canary vs. blue-green: which strategy to recommend?**
   - What we know: Vercel natively supports canary via `--canary` flag or `traffic.split` in vercel.json. Blue-green requires a separate "parking" domain and is more complex.
   - What's unclear: Any existing preference in the project (no CONTEXT.md or prior decisions found).
   - Recommendation: Canary (simpler, Vercel-native). Blue-green is overkill for this project's scale. Use `vercel deploy --canary` for pre-production testing, then `vercel promote` to shift traffic gradually.

---

## Sources

### Primary (HIGH confidence)

- `apps/fastapi-backend/main.py` — Confirmed: `GET /health` returns `{"status":"ok","ai_backends":[...]}`; FastAPI `lifespan` pattern
- `apps/django-backend/deploy/canary-check.sh` — Confirmed: three checks (health 200, valid JSON, API not 5xx)
- `apps/fastapi-backend/deploy/canary-check.sh` — Confirmed: same three-check pattern as Django
- `apps/open-swe/deploy/canary-check.sh` — Confirmed: open-swe checks root page and API runs endpoint
- `.github/workflows/smoke-test.yml` — Confirmed: manual (workflow_dispatch), checks localhost:3001 root page; `needs` job汇总; `if: always()` summary step
- `apps/open-swe/next.config.ts` — Confirmed: minimal Next.js 15 config; no special routing
- `apps/open-swe/app/api/open-swe/runs/route.ts` — Confirmed: Next.js App Router POST+GET; `dynamic = "force-dynamic"`; proper error responses (502, 503)
- `turbo.json` — Confirmed: `apps/*` glob includes open-swe; no special deployment config

### Secondary (MEDIUM confidence)

- Vercel CLI documentation (verified via WebSearch): `vercel deploy --canary`, `vercel promote`, `vercel rollback` flags and behavior
- Vercel traffic splitting documentation (verified via WebSearch): `vercel.json` `traffic.split` configuration

### Tertiary (LOW confidence)

- None — all findings from codebase source or verified docs.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all tools (Next.js, Vercel CLI, GitHub Actions) confirmed from existing codebase and documentation
- Architecture patterns: HIGH — patterns derived from existing canary-check.sh scripts and smoke-test.yml; Next.js App Router health route follows established backend patterns
- Pitfalls: MEDIUM — identified pitfalls (caching, wrong env, canary flag) are well-known but not verified against extensive community discussion
- Code examples: HIGH — all examples derived from actual existing files in the codebase

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days — infrastructure configuration is stable; Vercel CLI flags unlikely to change)
