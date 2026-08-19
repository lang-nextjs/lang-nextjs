---
phase: quick-17
plan: '01'
type: execute
wave: '1'
depends_on: []
files_modified:
  - .github/workflows/smoke-test.yml
  - apps/django-backend/deploy/canary-check.sh
  - apps/fastapi-backend/deploy/canary-check.sh
  - apps/open-swe/deploy/canary-check.sh
autonomous: true
requirements: []
user_setup: []
formal_artifacts: none

must_haves:
  truths:
    - "Staging deployment passes health/smoke checks before traffic shift"
    - "Canary validation script returns exit code 0 only when all metrics pass"
    - "Rollback can be triggered manually or automatically on smoke test failure"
  artifacts:
    - path: .github/workflows/smoke-test.yml
      provides: "GitHub Actions smoke test workflow for staging validation"
      min_lines: 40
    - path: apps/django-backend/deploy/canary-check.sh
      provides: "Canary validation script for Django backend"
      exports: ["HEALTH_URL", "API_URL", "CHECKS"]
    - path: apps/fastapi-backend/deploy/canary-check.sh
      provides: "Canary validation script for FastAPI backend"
      exports: ["HEALTH_URL", "API_URL", "CHECKS"]
    - path: apps/open-swe/deploy/canary-check.sh
      provides: "Canary validation script for open-swe dashboard"
      exports: ["HEALTH_URL", "API_URL", "CHECKS"]
  key_links:
    - from: .github/workflows/smoke-test.yml
      to: apps/django-backend/deploy/canary-check.sh
      via: docker compose run django-backend smoke
    - from: .github/workflows/smoke-test.yml
      to: apps/fastapi-backend/deploy/canary-check.sh
      via: docker compose run fastapi-backend smoke
---

<objective>
Add health check endpoint smoke tests, canary validation scripts, and GitHub Actions workflow to enable canary/blue-green deployment validation before full production rollout.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@apps/django-backend/docker-compose.yml
@apps/fastapi-backend/docker-compose.yml
@.github/workflows/ci.yml
@.github/workflows/e2e.yml
</context>

<tasks>

<task type="auto">
  <name>Create GitHub Actions smoke test workflow</name>
  <files>.github/workflows/smoke-test.yml</files>
  <action>
Create `.github/workflows/smoke-test.yml` — a GitHub Actions workflow that:

1. Triggers on workflow_dispatch (manual) and can be called by deployment workflows
2. Runs after staging deployment completes
3. For each backend (Django on port 8002, FastAPI on port 8001):
   - Waits up to 60s for the health endpoint to return 200
   - Calls the smoke check script (via docker compose run) that validates:
     - Health endpoint returns 200
     - Returns valid JSON
     - Has expected fields (e.g., status: "healthy")
4. For open-swe (port 3001):
   - Waits for the Next.js dev server to respond on /
   - Smoke check script validates the page loads without 5xx
5. If any check fails, workflow exits with non-zero status (deployment should rollback)
6. Outputs deployment validation summary as step summary

The workflow should use `curl --fail` for HTTP checks (fail-fast on non-2xx).
Do NOT run full E2E suite here — this is a lightweight smoke test only.

Reference: apps/django-backend already has healthcheck in docker-compose.yml (line 41: curl -f http://localhost:8000/health/).
apps/fastapi-backend already has healthcheck in docker-compose.yml (line 10: curl -f http://localhost:8001/health).
</action>
  <verify>cat .github/workflows/smoke-test.yml | grep -E "(workflow_dispatch|health|smoke|8002|8001|3001)" | head -20</verify>
  <done>Smoke test workflow exists at .github/workflows/smoke-test.yml; triggered manually via workflow_dispatch; validates all three services</done>
</task>

<task type="auto">
  <name>Create Django backend canary check script</name>
  <files>apps/django-backend/deploy/canary-check.sh</files>
  <action>
Create `apps/django-backend/deploy/canary-check.sh` — an executable bash script for canary validation:

1. Accepts environment variables:
   - HEALTH_URL (default: http://localhost:8000/health/)
   - API_URL (default: http://localhost:8000/api/chat/stream/)
2. Runs checks:
   - curl --fail -s -o /dev/null -w "%{http_code}" $HEALTH_URL returns 200
   - curl -s $HEALTH_URL returns valid JSON with status field
   - curl --fail -s $API_URL returns 200 or 400 (not 5xx) — verifies API route exists
3. Returns exit code 0 on all pass, 1 on any failure
4. Prints which check failed on failure

Make it executable: chmod +x canary-check.sh
This script is invoked by deployment pipelines to validate a canary deployment before shifting traffic.
</action>
  <verify>head -5 apps/django-backend/deploy/canary-check.sh && test -x apps/django-backend/deploy/canary-check.sh && echo "executable"</verify>
  <done>Django canary check script is executable at apps/django-backend/deploy/canary-check.sh; validates health endpoint and API route</done>
</task>

<task type="auto">
  <name>Create FastAPI backend canary check script</name>
  <files>apps/fastapi-backend/deploy/canary-check.sh</files>
  <action>
Create `apps/fastapi-backend/deploy/canary-check.sh` — an executable bash script for canary validation:

1. Accepts environment variables:
   - HEALTH_URL (default: http://localhost:8001/health)
   - API_URL (default: http://localhost:8001/api/chat/stream)
2. Runs checks:
   - curl --fail -s -o /dev/null -w "%{http_code}" $HEALTH_URL returns 200
   - curl -s $HEALTH_URL returns valid JSON with status field
   - curl --fail -s $API_URL returns 200 or 400 (not 5xx) — verifies API route exists
3. Returns exit code 0 on all pass, 1 on any failure
4. Prints which check failed on failure

Make it executable: chmod +x canary-check.sh
Mirrors the Django script but uses FastAPI port 8001 and /health (no trailing slash).
</action>
  <verify>head -5 apps/fastapi-backend/deploy/canary-check.sh && test -x apps/fastapi-backend/deploy/canary-check.sh && echo "executable"</verify>
  <done>FastAPI canary check script is executable at apps/fastapi-backend/deploy/canary-check.sh; validates health endpoint and API route</done>
</task>

<task type="auto">
  <name>Create open-swe dashboard canary check script</name>
  <files>apps/open-swe/deploy/canary-check.sh</files>
  <action>
Create `apps/open-swe/deploy/canary-check.sh` — an executable bash script for canary validation:

1. Accepts environment variables:
   - HEALTH_URL (default: http://localhost:3001) — root page as health
   - API_RUNS_URL (default: http://localhost:3001/api/open-swe/runs)
2. Runs checks:
   - curl --fail -s -o /dev/null -w "%{http_code}" $HEALTH_URL returns 200
   - curl -s -o /dev/null -w "%{http_code}" $API_RUNS_URL returns 200 (not 5xx) — validates API route
   - curl --fail -s $HEALTH_URL does not contain error HTML / 500 / 502 / 503
3. Returns exit code 0 on all pass, 1 on any failure
4. Prints which check failed on failure

Make it executable: chmod +x canary-check.sh
Validates the open-swe Next.js dashboard responds correctly before production traffic is shifted.
</action>
  <verify>head -5 apps/open-swe/deploy/canary-check.sh && test -x apps/open-swe/deploy/canary-check.sh && echo "executable"</verify>
  <done>open-swe canary check script is executable at apps/open-swe/deploy/canary-check.sh; validates dashboard page and API route</done>
</task>

</tasks>

<verification>
- All three canary check scripts are executable and return 0 on success, 1 on failure
- smoke-test.yml uses workflow_dispatch and runs checks in parallel for Django/FastAPI, then open-swe
- No existing tests or functionality are modified
</verification>

<success_criteria>
1. `.github/workflows/smoke-test.yml` exists and defines a reusable workflow with health check steps for all three services
2. `apps/django-backend/deploy/canary-check.sh` is executable and validates health + API endpoints
3. `apps/fastapi-backend/deploy/canary-check.sh` is executable and validates health + API endpoints
4. `apps/open-swe/deploy/canary-check.sh` is executable and validates page load + API route
5. Scripts return correct exit codes (0 = pass, 1 = fail)
6. No existing files are modified
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-17/1-SUMMARY.md`
</output>