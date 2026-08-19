# Requirements: deepagents-nextjs — v1.7 Blazing Workspace Provider

**Defined:** 2026-06-08
**Core Value:** A developer can wire up DeepAgents end-to-end in two lines of code — one server route, one hook — and get fully typed messages out of the box, in their framework of choice.

> v1.7 scope: wire up the Blazing workspace sandbox provider so open-swe agents can execute code in ephemeral container workspaces backed by Blazing infrastructure. The blazing REST API (PR #81) already exists; the work is landing it and consuming it correctly from TypeScript. **Zero new runtime dependencies.**

## Baseline Requirements

*Carried forward from v1.6. Cross-cutting quality gates that remain active.*

- [x] **BL-01**: Zero new runtime dependencies in the library packages (server, react, sveltekit, remix, edge)
- [x] **BL-02**: Edge-runtime compatibility preserved — no Node-only APIs in `/edge`
- [x] **BL-03**: All packages typecheck clean (`tsc --noEmit`)
- [x] **BL-04**: Existing test suites remain green (no regressions)

## Milestone v1.7 Requirements

### Blazing REST API (blazing repo)

- [x] **BLZ-01**: PR #81 (`/v1/workspace` REST API — 7 endpoints, 56 tests) is merged into blazing master
- [x] **BLZ-02**: Staging smoke test passes: `curl` create → exec `echo hello` → delete round-trip returns correct responses
- [x] **BLZ-03**: Kill switch (`WORKSPACE_API_ENABLED=false`) disables all `/v1/workspace*` routes (verified by 404s)

### TypeScript Adapter (lang-nextjs repo)

- [x] **ADPT-01**: `BlazingSandbox` class rewritten to match real API contract — correct URL paths (`/v1/workspace` singular, `/v1/workspaces` plural), Bearer token auth, argv-style exec, wrapped list response
- [x] **ADPT-02**: DTO types match real API response shapes: `WorkspaceRecord` (`sandbox_id`, `container_id`, `state`, `image`, `created_at`, `label`, `host`), `ExecResponse` (`exit_code`, `stdout`, `stderr`, `duration_ms`, `timed_out`), `CapacityResponse` (`used`, `max`, `available`), `WorkspaceListResponse` (`{workspaces: [...]}`)
- [x] **ADPT-03**: Error mapping covers all real API status codes: 404 → `not_found`, 429 → `at_capacity`, 422 → `create_failed` (unsupported fields), 409 → `create_failed` (already creating), 503 → `provider_unavailable`
- [x] **ADPT-04**: Exec maps `executeTool(command, args)` to `{command, args}` argv-style request — no shell wrapping
- [x] **ADPT-05**: `getSandbox()` factory returns `BlazingSandbox` when `BLAZING_API_URL` is set, using `BLAZING_API_TOKEN` for Bearer auth

### Testing

- [x] **TEST-01**: Mock-fetch test suite covers all 7 endpoints against the real PR #81 contract (create, exec, get, list, destroy, health, capacity)
- [x] **TEST-02**: Mock tests cover error paths: 404, 429, 422, 409, 503, network timeout, circuit breaker open
- [x] **TEST-03**: Live local smoke test validates create → exec → destroy against a running blazing instance (Docker + blazing required) — _verified 2026-06-09: 8/8 through the real `BlazingSandbox` adapter against an isolated master-built blazing-api (`lib/sandbox/blazing-sandbox.live.test.ts`); surfaced + fixed a `health()` contract bug (`status:"healthy"`)_

### Documentation

- [x] **DOC-01**: Provider setup documented: env vars (`BLAZING_API_URL`, `BLAZING_API_TOKEN`), auth model, known limitations (env/exec_timeout_ms forwarded by the adapter but rejected by Blazing with 422 — blazing#48; stderr merged with stdout)

## Future Requirements

Deferred to v1.8+ or blazing follow-up. Tracked, not in this roadmap.

### Workspace API Extensions (blazing)
- **BLZ-F1**: Apply `env` and `exec_timeout_ms` in create — Blazing's `POST /v1/workspace` currently **rejects both with HTTP 422** (blazing#48; the workspace runtime does not model them). The TS adapter already forwards them from `SandboxConfig`, so they begin working the moment Blazing wires the runtime — no adapter change needed.
- **BLZ-F2**: File operation endpoints (read_file, write_file, edit_file) — currently only exec
- **BLZ-F3**: Workspace state change webhook / polling for async bootstrap completion

### Provider Extensions (lang-nextjs)
- **ADPT-F1**: Workspace auto-reconnect / re-create on provider restart
- **ADPT-F2**: OpenAPI-generated types from blazing spec (when blazing exposes an OpenAPI schema)
- **ADPT-F3**: Multi-host workspace proxy awareness (route exec to correct host when sandbox is remote)

## Out of Scope

Explicitly excluded, with reasoning to prevent re-adding.

| Feature | Reason |
|---------|--------|
| OpenAPI client generation | 7 endpoints is too few to justify the build-time tooling; hand-written types are simpler and match the existing pattern |
| File operation client methods | The REST API doesn't expose file ops — they go through exec (`bash -c "cat /path"`); adding them here would be facade-only |
| Blazing Docker image changes | The workspace container image is a blazing-side concern, not this library's scope |
| New `@deepagents-nextjs/*` package | The BlazingSandbox lives in `apps/open-swe/` (app code), not a published library package |
| Custom sandbox image support | Create endpoint accepts an `image` field but image management is the deployer's concern |
| Changes to the Sandbox interface | The existing interface is provider-agnostic and works; only the Blazing implementation changes |

## Traceability

Phases continue from 21. Roadmap created 2026-06-08.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BLZ-01 | Phase 21 | Complete |
| BLZ-02 | Phase 21 | Complete |
| BLZ-03 | Phase 21 | Complete |
| ADPT-01 | Phase 22 | Complete |
| ADPT-02 | Phase 22 | Complete |
| ADPT-03 | Phase 22 | Complete |
| ADPT-04 | Phase 23 | Complete |
| ADPT-05 | Phase 23 | Complete |
| TEST-01 | Phase 24 | Complete |
| TEST-02 | Phase 24 | Complete |
| TEST-03 | Phase 24 | Verified live (8/8, 2026-06-09) |
| DOC-01 | Phase 25 | Complete |

**Coverage:**
- v1.7 requirements: 12 total
- Mapped to phases: 12 ✓
- Unmapped: 0 ✓

---