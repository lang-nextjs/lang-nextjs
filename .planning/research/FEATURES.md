# Feature Landscape

**Domain:** Blazing workspace provider integration
**Researched:** June 2026

## Executive Summary

The Blazing workspace provider requires a complete rewrite of the existing `BlazingSandbox` stub to match the real `/v1/workspace` REST API contract. The current stub implements an invented `/workspaces` API that doesn't exist in the real Blazing service. The real API uses different URL paths, authentication headers, request/response formats, and has specific limitations (e.g., rejects `env` and `exec_timeout_ms` in create requests).

## Table Stakes

Features users expect. Missing = integration feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **REST API mapping** | Real Blazing service has 7 specific endpoints that must map to Sandbox interface | Medium | URL paths differ from stub: `/v1/workspace` (singular) vs `/workspaces` |
| **Authentication** | Real API uses `verify_token` (Bearer token) vs stub's `X-Api-Key` | Low | Header change only |
| **Workspace creation** | Core feature to create isolated environments | Medium | Real API rejects `env` and `exec_timeout_ms` (422) |
| **Command execution** | Ability to run tools inside workspaces | Low | Real API expects argv-style (command + args array) |
| **Workspace lifecycle** | Get, list, destroy operations | Low | Standard CRUD operations |
| **Health checks** | Verify provider availability | Low | Circuit breaker already implemented |
| **Capacity reporting** | Show resource usage limits | Low | Simple endpoint mapping |
| **Error mapping** | Convert HTTP errors to SandboxError codes | Medium | 422, 429, 5xx need proper mapping |
| **Circuit breaker** | Prevent cascading failures | Low | Already implemented in stub |

## Differentiators

Features that set the integration apart. Not expected, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Real-time exec timeout** | Real API reports `timed_out` flag | Low | Already in DTO mapping |
| **Duration reporting** | Accurate timing for tool executions | Low | `duration_ms` in response |
| **Container ID mapping** | Track container lifecycle | Low | `container_id` in workspace record |
| **Provider metadata** | Image, status, creation timestamps | Low | Available in workspace DTO |
| **Idempotent destroy** | Safe repeated deletion | Low | Real API returns 204 even if not found |
| **Merged stdout/stderr** | Real API merges streams | Medium | Need to handle empty stderr |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Env var injection** | Real API rejects env vars in create | Document limitation, advise use of container image with pre-configured env |
| **Custom exec timeouts** | Real API ignores exec_timeout_ms | Use provider defaults or document fixed timeout behavior |
| **Workspace filtering** | No query params in list endpoint | Return all workspaces, let clients filter locally |
| **Batch operations** | API is strictly single-workspace | Implement client-side batching if needed |

## Feature Dependencies

```
Sandbox interface → real API endpoints
  create → POST /v1/workspace
  executeTool → POST /v1/workspace/{id}/exec
  destroy → DELETE /v1/workspace/{id}
  get → GET /v1/workspace/{id}
  list → GET /v1/workspaces
  capacity → GET /v1/workspaces/capacity
  health → GET /v1/health
```

## Key Gaps Between Sandbox Interface and Real API

### 1. URL Structure
- **Stub**: `/workspaces` (plural)
- **Real**: `/v1/workspace` (singular) for create/get/delete, `/v1/workspaces` (plural) for list/capacity

### 2. Authentication
- **Stub**: `X-Api-Key` header
- **Real**: `Authorization: Bearer <verify_token>`

### 3. Request Formats
- **Stub (create)**: `{ image, label, memory_limit_mb, cpu_limit, exec_timeout_ms, env }`
- **Real (create)**: `{ image, label }` only (rejects env and exec_timeout_ms with 422)

### 4. Execution Format
- **Stub**: `{ command, args }` (shell command string)
- **Real**: `{ command, args }` (argv-style array)

### 5. Response Wrapping
- **Stub (list)**: Direct array of workspace DTOs
- **Real (list)**: `{ workspaces: [...] }` wrapper

### 6. Error Handling
- **Stub**: Generic error handling
- **Real**: 422 for invalid create requests (e.g., sending rejected fields)

### 7. Output Handling
- **Stub**: Separate stdout/stderr
- **Real**: stderr mostly empty (container runtime merges stdout+stderr)

## Implementation Complexity Assessment

| Feature | Complexity | Risk | Mitigation |
|---------|------------|------|------------|
| URL path mapping | Low | Low | Simple string replacement in request URLs |
| Auth header change | Low | Low | Add Authorization header, remove X-Api-Key |
| Request validation | Medium | Medium | Validate create requests, strip unsupported fields |
| List response unwrapping | Low | Low | Extract `workspaces` array from response |
| Error code mapping | Medium | Medium | Map 422, 429, 5xx to appropriate SandboxError codes |
| DTO transformations | Low | Low | Convert snake_case to camelCase properties |

## MVP Recommendation

Prioritize:
1. **Core API mapping** - Implement all 7 real endpoints with correct paths
2. **Authentication** - Switch to verify_token Bearer auth
3. **Request validation** - Filter out unsupported fields (env, exec_timeout_ms)
4. **Basic error handling** - Map 422, 429, 5xx to appropriate SandboxError codes
5. **Integration tests** - Mock-based test suite validating the new contract

Defer: 
- Advanced features like workspace filtering or batch operations until v1.8

## Sources

- Existing BlazingSandbox stub implementation
- DockerSandbox reference implementation
- Circuit breaker implementation
- Sandbox interface types
- Milestone context documentation
- Git history showing stub hardening (commit 30d38e0)