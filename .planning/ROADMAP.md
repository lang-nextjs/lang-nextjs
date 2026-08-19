# Roadmap: v1.7 Blazing Workspace Provider

**Project:** deepagents-nextjs  
**Milestone:** v1.7 Blazing Workspace Provider  
**Phase Range:** 21–25  
**Depth:** Comprehensive  
**Total Requirements:** 12 (BLZ-01..03, ADPT-01..05, TEST-01..03, DOC-01)  
**Coverage:** 12/12 requirements mapped ✓

## Phases

- [x] **Phase 21: Blazing API Merge** - Merge PR #81 and validate staging smoke *(2 plans, 2 waves)* (completed 2026-06-08)
- [x] **Phase 22: TypeScript Adapter Contract** - Rewrite BlazingSandbox to match real API (completed 2026-06-08)
- [x] **Phase 23: Provider Wiring** - Connect BLAZING_API_URL to activate provider (completed 2026-06-08)
- [x] **Phase 24: Test Suite Integration** - Mock tests + live local smoke validation (completed 2026-06-08)
- [x] **Phase 25: Provider Documentation** - Setup guide with env vars and limitations (completed 2026-06-08)

## Phase Details

### Phase 21: Blazing API Merge
**Goal:** Blazing `/v1/workspace` REST API is merged and functionally available for consumption
**Depends on:** Nothing (dependency phase)
**Requirements:** BLZ-01, BLZ-02, BLZ-03
**Success Criteria** (what must be TRUE):
  1. PR #81 (7 endpoints, 56 tests) merged into blazing master branch
  2. Staging smoke test passes: create → exec `echo hello` → delete round-trip succeeds with correct responses
  3. Kill switch works: `WORKSPACE_API_ENABLED=false` returns 404 for all `/v1/workspace*` routes
**Plans:**
  2/2 plans complete
  - [ ] 21-02-PLAN.md — Kill switch verification + staging smoke test round-trip (BLZ-02, BLZ-03)

### Phase 22: TypeScript Adapter Contract
**Goal:** BlazingSandbox class fully matches the real API contract with correct URLs, types, and error handling
**Depends on:** Phase 21 (BLZ-01 merged)
**Requirements:** ADPT-01, ADPT-02, ADPT-03
**Success Criteria** (what must be TRUE):
  1. BlazingSandbox uses correct URL paths (`/v1/workspace` singular, `/v1/workspaces` plural) with Bearer token auth
  2. DTO types exactly match real API response shapes: WorkspaceRecord, ExecResponse, CapacityResponse, WorkspaceListResponse
  3. Error mapping covers all real status codes: 404→not_found, 429→at_capacity, 422→create_failed, 409→create_failed, 503→provider_unavailable
**Plans:** 0/0 plans complete

### Phase 23: Provider Wiring
**Goal:** getSandbox() factory activates Blazing provider when BLAZING_API_URL is set
**Depends on:** Phase 22 (contract complete)
**Requirements:** ADPT-04, ADPT-05
**Success Criteria** (what must be TRUE):
  1. Exec maps `executeTool(command, args)` to `{command, args}` argv-style request without shell wrapping
  2. getSandbox() returns BlazingSandbox instance when `BLAZING_API_URL` is set, using `BLAZING_API_TOKEN` for Bearer auth
**Plans:** 0/0 plans complete

### Phase 24: Test Suite Integration
**Goal:** Full test coverage validating the Blazing integration against both mock and real API
**Depends on:** Phase 21 (API available), Phase 22 (contract complete), Phase 23 (wiring complete)
**Requirements:** TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. Mock-fetch test suite covers all 7 endpoints against the real PR #81 contract
  2. Mock tests cover all error paths: 404, 429, 422, 409, 503, network timeout, circuit breaker
  3. Live local smoke test validates create → exec → destroy against a running blazing instance
**Plans:** 0/0 plans complete

### Phase 25: Provider Documentation
**Goal:** Complete setup and usage documentation for the Blazing workspace provider
**Depends on:** Can start alongside any phase, completes after Phase 24
**Requirements:** DOC-01
**Success Criteria** (what must be TRUE):
  1. Provider setup documented with env vars (`BLAZING_API_URL`, `BLAZING_API_TOKEN`) and auth model
  2. Known limitations documented (env/exec_timeout_ms not yet supported, stderr merged with stdout)
**Plans:** 0/0 plans complete

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 21. Blazing API Merge | 0/2 | Complete    | 2026-06-08 |
| 22. TypeScript Adapter Contract | 0/3 | Complete    | 2026-06-08 |
| 23. Provider Wiring | 0/2 | Complete    | 2026-06-08 |
| 24. Test Suite Integration | 0/3 | Complete    | 2026-06-08 |
| 25. Provider Documentation | 0/1 | Complete    | 2026-06-08 |

## Key Dependencies

```
Phase 21 (BLZ API) ← Phase 22 (Contract) ← Phase 23 (Wiring)
      ↓                    ↓                    ↓
Phase 24 (Tests) ← Phase 25 (Docs)
```

**Critical Path:** Phase 21 must complete before TypeScript adapter work can proceed
**Parallel Work:** Documentation (Phase 25) can start immediately alongside any phase
**Final Gate:** TEST-03 (live smoke) requires both API and adapter to be complete

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Phase 21 as separate dependency phase | TypeScript adapter cannot be tested against real contract until PR #81 is merged |
| ADPT-01..05 mapped to single phase | All contract changes are interdependent (URLs, types, errors, exec format, factory) |
| TEST-01..02 can start after Phase 22 | Mock tests don't need live API, just contract specification |
| TEST-03 last phase | Requires both live API and complete adapter implementation |
| DOC-01 standalone | Documentation can proceed alongside development; can be validated incrementally |

## Future Scope

Deferred to v1.8+:
- BLZ-F1: `env` and `exec_timeout_ms` support in create endpoint
- BLZ-F2: File operation endpoints (read_file, write_file, edit_file)
- BLZ-F3: Workspace state change webhook / polling for async completion
- ADPT-F1: Workspace auto-reconnect on provider restart
- ADPT-F2: OpenAPI-generated types from blazing spec
- ADPT-F3: Multi-host workspace proxy awareness

---