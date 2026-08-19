---
phase: quick-issue-13
plan: 1
subsystem: testing
tags: [e2e, playwright, llm, sse, openrouter, ci]

# Dependency graph
requires: []
provides:
  - "Real LLM E2E test suite (e2e/llm.spec.ts) with text streaming, completion, and UI verification"
  - "chromium-llm Playwright project for isolated LLM test execution"
  - "e2e-llm CI job gated to push-to-main with OPENROUTER_API_KEY secret"
affects: [ci, e2e, testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [llm-gated-skip-pattern, sse-real-stream-verification]

key-files:
  created:
    - e2e/llm.spec.ts
  modified:
    - playwright.config.ts
    - .github/workflows/e2e.yml

key-decisions:
  - "LLM tests use same SSE parsing pattern as chat.spec.ts (split on \\n\\n, JSON parse, filter by type)"
  - "e2e-llm CI job mirrors e2e-django structure but restricted to push-to-main only"
  - "Django backend used for LLM tests (most battle-tested backend per plan)"

patterns-established:
  - "LLM skip gate: test.skip(!hasApiKey, ...) pattern for optional secret-gated E2E tests"
  - "chromium-llm project pattern: dedicated Playwright project for isolated LLM test matching"

requirements-completed: [ISSUE-13]

# Metrics
duration: 2min
completed: 2026-05-17
---

# Quick Task 1: Real LLM E2E Test Suite Summary

**Optional E2E test suite with real LLM streaming via OpenRouter, gated behind OPENROUTER_API_KEY, running only on push-to-main**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-17T21:03:37Z
- **Completed:** 2026-05-17T21:06:21Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created e2e/llm.spec.ts with 3 tests validating real LLM output: text-delta streaming, clean finish with no errors, and UI rendering
- Added chromium-llm Playwright project that exclusively matches llm.spec.ts (no overlap with existing projects)
- Added e2e-llm CI job that runs only on push to main branch using Django backend with OPENROUTER_API_KEY secret

## Task Commits

Each task was committed atomically:

1. **Task 1: Create e2e/llm.spec.ts real LLM test suite** - `50a8b2b` (feat)
2. **Task 2: Add chromium-llm project and e2e-llm CI job** - `5b3317a` (feat)

## Files Created/Modified
- `e2e/llm.spec.ts` - Real LLM E2E test suite with 3 tests (text streaming, clean completion, UI rendering)
- `playwright.config.ts` - Added chromium-llm project restricted to llm.spec.ts
- `.github/workflows/e2e.yml` - Added e2e-llm job (push-to-main only, Django backend, OPENROUTER_API_KEY)

## Decisions Made
- LLM tests use same SSE parsing pattern as chat.spec.ts for consistency across the E2E suite
- e2e-llm CI job mirrors e2e-django structure (compose setup, health wait, Next.js start) but restricted to push-to-main only to avoid PR cost/flakes
- Django backend chosen for LLM tests as the most battle-tested backend
- Generous 120s timeout on Django health check in e2e-llm job (LLM model loading can be slow)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness
- Real LLM E2E tests ready to validate on next push to main
- Tests skip gracefully in all other contexts (local dev without key, PRs, mocked CI)

---
*Quick Task: 1-issue-13*
*Completed: 2026-05-17*
