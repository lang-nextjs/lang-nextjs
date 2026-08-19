# Domain Pitfalls: Blazing REST API Client Integration

**Domain:** TypeScript REST client for FastAPI workspace provider
**Researched:** June 2026

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: Incorrect API Contract Mapping
**What goes wrong:** The existing BlazingSandbox stub targets an invented `/workspaces` API (plural) that doesn't exist in the real Blazing service. Real API uses `/v1/workspace` (singular) for core operations, causing all integration to fail.

**Why it happens:** Stub was implemented before real API was built, based on assumptions. PR #81 exposes the actual FastAPI endpoints with different URL patterns, authentication, and request formats.

**Consequences:** Complete integration failure - all calls result in 404 errors. Developer spends weeks debugging why nothing works before discovering contract mismatch.

**Prevention:** Extract actual API contract from PR #81 documentation and OpenAPI spec before writing any integration code. Map every endpoint to existing Sandbox interface methods.

**Detection:** Integration tests fail with 404s on all API calls.

### Pitfall 2: Authentication Header Mismatch
**What goes wrong:** Stub assumes `X-Api-Key` header, but real Blazing API uses `verify_token` (likely `Authorization: Bearer`). All requests fail with 401/403.

**Why it happens:** Different authentication patterns between expected and actual API. API expects JWT-style Bearer token, not simple API key.

**Consequences:** All API calls fail with authentication errors. Circuit breaker trips after threshold. Application appears completely broken.

**Prevention:** Confirm exact authentication pattern from Blazing team (likely `Authorization: Bearer <token>`). Update all requests to use correct header.

**Detection:** API logs show 401/403 errors for all requests.

### Pitfall 3: Unsupported Fields in Workspace Creation
**What goes wrong:** Real API rejects `env` and `exec_timeout_ms` parameters in create requests with 422 errors, but SandboxConfig interface allows them.

**Why it happens:** Real Blazing API has stricter validation than expected. Workspace creation only supports `image` and `label` parameters.

**Consequences:** Create workspace calls fail with 422 validation errors. SandboxError mapping doesn't handle 422, leading to generic "provider unavailable" errors.

**Prevention:** Validate create requests against supported fields, stripping unsupported ones. Update SandboxConfig to mark unsupported fields as optional with clear documentation.

**Detection:** Create requests fail with 422 status codes in logs.

### Pitfall 4: Response Format Assumptions
**What goes wrong:** Assumes list endpoint returns direct array, but real API wraps response in `{workspaces: [...]}`. Direct array access causes runtime errors.

**Why it happens:** Different API design patterns. Some APIs return bare arrays, others use wrapper objects for pagination/extensibility.

**Consequences:** Integration fails when trying to access returned data as array. Type errors and undefined access crash the application.

**Prevention:** OpenAPI-generated types will handle this automatically. Verify response structure matches spec before writing business logic.

**Detection:** TypeScript compilation errors accessing array properties on wrapped response.

### Pitfall 5: Exec Format Misunderstanding
**What goes wrong:** Stub expects shell command string, but real API expects `{command, args}` in argv format. Command execution fails or runs incorrectly.

**Why it happens:** Different approaches to command execution - shell parsing vs direct argument passing.

**Consequences:** Tool commands execute with wrong arguments or fail entirely. Agent tool calls produce unexpected results or errors.

**Prevention:** Map shell command + args to `{command, args}` format before sending to API. Handle shell escaping correctly.

**Detection:** Tool commands fail with exit codes or produce unexpected output.

## Moderate Pitfalls

### Pitfall 1: Circuit Breaker Configuration
**What goes wrong:** Default circuit breaker thresholds may be too aggressive for Blazing API, causing unnecessary trips during normal operation.

**Why it happens:** API may have different latency characteristics or rate limiting patterns than Docker provider.

**Consequences:** Provider appears unavailable even when working correctly. Users experience unnecessary fallbacks to Docker.

**Prevention:** Monitor API performance and adjust thresholds based on actual behavior. Consider API-specific circuit breaker configuration.

**Detection:** Frequent "provider_unavailable" errors during normal operation.

### Pitfall 2: Timeout Configuration
**What goes wrong:** Default timeout may be too short for Blazing API operations, especially workspace creation which could take longer than expected.

**Why it happens:** Network latency or API processing time exceeds default timeout.

**Consequences:** Timeouts cause circuit breaker trips and unnecessary fallbacks to Docker.

**Prevention:** Make timeout configurable based on operation type. Monitor actual response times and adjust accordingly.

**Detection:** Many "provider_unavailable" errors with timeout messages.

## Minor Pitfalls

### Pitfall 1: Case Sensitivity in Field Names
**What goes wrong:** Blazing API uses snake_case fields (`container_id`) but TypeScript code expects camelCase (`containerId`).

**Why it happens:** Different naming conventions between API and TypeScript code.

**Consequences:** undefined values when accessing API response fields. Runtime errors in business logic.

**Prevention:** Use generated types from OpenAPI spec to ensure correct field mapping.

**Detection:** undefined values in response DTO properties.

### Pitfall 2: Null Handling
**What goes wrong:** API may return null for optional fields, but code assumes they're always defined.

**Why it happens:** Different TypeScript and API approaches to optional values.

**Consequences:** Runtime errors when accessing nullable fields without null checks.

**Prevention:** Use generated types which will correctly mark optional fields as nullable.

**Detection:** TypeScript errors about possible undefined values.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| API Contract Discovery | Contract mismatch between stub and real API | Extract actual endpoints from PR #81 before implementation |
| Implementation | Field validation errors (422) | Validate requests against supported fields, strip unsupported ones |
| Integration | Authentication header mismatch | Confirm exact auth pattern from Blazing team |
| Testing | Response format assumptions | OpenAPI-generated types will prevent this |
| Deployment | Circuit breaker too aggressive | Monitor and adjust thresholds based on actual performance |

## Sources

- Project milestone context documentation
- Existing BlazingSandbox stub implementation
- Sandbox interface types
- Circuit breaker implementation patterns
- OpenAPI client generation best practices