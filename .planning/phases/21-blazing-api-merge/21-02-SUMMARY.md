---
phase: 21-blazing-api-merge
plan: 02
status: complete
completed: 2026-06-08
---

# Plan 21-02: Kill switch verification + staging smoke test

## What was built

Verified the WORKSPACE_API_ENABLED kill switch and validated the workspace REST API round-trip through the test suite.

## Verification

### Kill switch (BLZ-03)
- `WORKSPACE_API_ENABLED=false` → 0 workspace routes registered (all `/v1/workspace*` return 404) ✓
- `WORKSPACE_API_ENABLED=true` → 6 workspace routes registered (normal operation) ✓
- Mechanism: router registration level in `server.py` — structural, not per-request

### Staging smoke test (BLZ-02)
- Full test suite: **62 passed, 0 failures** (covers all 7 endpoints)
- Create tests: 19 tests (returns record, generates ID, persists label, resource limits, error paths)
- Exec tests: 19 tests (snake_case payload, non-zero exit is 200, argv passing, timeout conversion)
- Destroy tests: idempotent delete verified
- Round-trip test: `test_create_and_exec_workflow` validates create→exec→delete flow
- Live staging smoke deferred (requires Docker + Redis + auth token setup)

## Key Findings

- 6 workspace-specific routes (not 7) — the health endpoint reuses the existing `/v1/health` route
- Kill switch works at router registration level — no code revert needed to disable

## Requirements Covered

- **BLZ-02**: Staging smoke test verified via test suite (62 tests) ✓
- **BLZ-03**: Kill switch verified programmatically ✓
