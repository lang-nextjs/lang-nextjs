# Blazing Workspace Provider Integration Architecture

**Domain:** Blazing sandbox API integration
**Researched:** June 2026
**Focus:** Architecture for integrating Blazing's /v1/workspace REST API into open-swe

## Executive Summary

The BlazingSandbox adapter integration requires a complete rewrite of the existing stub to match the real API contract while preserving the established architecture patterns. The integration spans two repositories (blazing and lang-nextjs) and focuses on updating the BlazingSandbox class with correct endpoints, DTO shapes, authentication, and error mapping, then wiring it into the getSandbox() factory.

## Current Architecture Overview

### Existing Components

1. **Sandbox Interface** (`apps/open-swe/lib/sandbox/types.ts`)
   - Provider-agnostic `Sandbox` interface
   - Shared types: `SandboxWorkspace`, `ToolExecutionResult`, `SandboxConfig`
   - Error handling: `SandboxError` with stable error codes

2. **DockerSandbox** (`apps/open-swe/lib/sandbox/docker-sandbox.ts`)
   - Local Docker daemon provider
   - Uses `docker` CLI via injectable `DockerExecFn`
   - Maintains workspace state in `Map<string, SandboxWorkspace>`

3. **BlazingSandbox Stub** (`apps/open-swe/lib/sandbox/blazing-sandbox.ts`)
   - Currently a stub targeting wrong API paths
   - Has correct architecture patterns: circuit breaker, error mapping, fetch wrapper
   - Uses snake_case DTOs that don't match real API

4. **Sandbox Factory** (`apps/open-swe/lib/sandbox/index.ts`)
   - `getSandbox()` returns provider-specific instance
   - Currently throws when `BLAZING_API_URL` is set
   - Maps errors to HTTP responses via `sandboxErrorToResponse()`

5. **Circuit Breaker** (`apps/open-swe/lib/circuit-breaker.ts`)
   - Prevents cascading failures
   - Configurable threshold and reset timeout
   - Used by both sandbox providers

## Real API Contract (from PR #81)

### Endpoints
- **Singular Workspace Operations**
  - `POST /v1/workspace` → Create workspace (returns WorkspaceRecord)
  - `GET /v1/workspace/{id}` → Get workspace (returns WorkspaceRecord)
  - `DELETE /v1/workspace/{id}` → Destroy workspace (returns 204)
  - `POST /v1/workspace/{id}/exec` → Execute command (returns ExecResult)
  
- **Plural Operations**
  - `GET /v1/workspaces` → List workspaces (returns {workspaces: WorkspaceRecord[]})
  - `GET /v1/workspaces/capacity` → Get capacity (returns Capacity)

### Authentication
- Uses `verify_token` header (likely `Authorization: Bearer`)

### Key Differences from Stub
- **URL Paths**: `/v1/workspace` (singular) vs `/workspaces` (plural in stub)
- **Exec Format**: `argv-style` (command + args array) vs shell string
- **Create Response**: WorkspaceRecord with specific fields vs BlazingWorkspaceDto
- **Destroy**: Idempotent (204) vs throws on unknown IDs
- **List**: Wrapped in `{workspaces: [...]}` vs direct array

## Integration Architecture

### 1. Modified Files (lang-nextjs repo)

#### `apps/open-swe/lib/sandbox/blazing-sandbox.ts`
**Changes Required:**
- Update URL paths to use `/v1/workspace` and `/v1/workspaces`
- Replace DTO interfaces with real API shapes:
  - `WorkspaceRecord` (from API)
  - `ExecResult` (different from `BlazingExecDto`)
  - `Capacity` (different from `BlazingCapacityDto`)
- Update authentication header to `Authorization: Bearer verify_token`
- Change exec to use `{command, args}` format
- Update error mapping for new API responses
- Add proper handling for wrapped list response

#### `apps/open-swe/lib/sandbox/index.ts`
**Changes Required:**
- Modify `getSandbox()` to return `BlazingSandbox` when `BLAZING_API_URL` is set
- Remove error throwing, create provider instance instead
- Update comment about Blazing provider status

#### `apps/open-swe/lib/sandbox/types.ts`
**Changes Required:**
- Add DTO types matching real Blazing API
- Update error codes if new ones are introduced

### 2. New Components

#### DTO Types (in blazing-sandbox.ts)
```typescript
interface WorkspaceRecord {
  id: string;
  container_id: string;
  container_name?: string;
  image: string;
  status: "ready" | "error";
  created_at: string;
  label?: string;
  exec_timeout_ms?: number;
}

interface ExecResult {
  exit_code: number;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
  timed_out: boolean;
}

interface Capacity {
  used: number;
  max: number;
  available?: number;
}
```

### 3. Two-Repo Coordination

#### Blazing Repo
- Merge PR #81 (already complete based on milestone context)
- Ensure API is accessible at configured endpoint
- Maintain backwards compatibility if needed

#### Lang-NextJS Repo
- Update BlazingSandbox implementation
- Add integration tests
- Update configuration documentation

## Data Flow Architecture

### Request Flow
1. open-swe route calls `getSandbox()`
2. Factory returns `BlazingSandbox` instance (if `BLAZING_API_URL` set)
3. Method call (e.g., `create()`) → `guardedFetch()` → circuit breaker
4. HTTP request to Blazing API with proper auth
5. Response parsing → error mapping → return result

### Error Handling Flow
1. Network/timeout → `CircuitOpenError` → `provider_unavailable`
2. 4xx errors → specific error codes (404 → `not_found`, 422 → `invalid_command`)
3. 5xx errors → circuit breaker tripped → `provider_unavailable`
4. Valid errors mapped to `SandboxError` with stable codes

### Circuit Breaker Integration
- Wraps all API calls
- Opens after 5 consecutive failures
- Resets after 30s timeout
- Prevents cascading failures from slow/dead API

## Build Order Dependencies

### Phase 1: Foundation (blazing repo)
1. **Merge PR #81** - Ensure real API is available
   - Verify all 7 endpoints are functional
   - Confirm authentication works

### Phase 2: Implementation (lang-nextjs repo)
2. **Update DTO Types** - Match real API response shapes
3. **Rewrite BlazingSandbox** - Implement correct endpoints and logic
4. **Update Factory** - Wire in new provider
5. **Integration Tests** - Mock + local smoke tests

### Phase 3: Validation
6. **E2E Testing** - Test with real Blazing instance
7. **Documentation Updates** - Configuration and usage guides

## Architecture Patterns Preserved

### 1. Provider Agnostic Interface
- Same `Sandbox` interface used by all providers
- Routes don't need to know implementation details

### 2. Circuit Breaker Pattern
- Consistent failure handling across providers
- Configurable thresholds and timeouts

### 3. Error Mapping
- Stable error codes for HTTP status translation
- Consistent error reporting surface

### 4. Singleton Pattern
- Process-wide workspace state management
- Avoids duplicate container creation

### 5. Injectable Dependencies
- Fetch function overrideable for testing
- Configurable timeouts and defaults

## Key Integration Points

### 1. Provider Selection
```typescript
// Before (stub)
if (process.env.BLAZING_API_URL?.trim()) {
  throw new Error("Blazing provider not implemented");
}

// After (real integration)
if (process.env.BLAZING_API_URL?.trim()) {
  return new BlazingSandbox({
    baseUrl: process.env.BLAZING_API_URL,
    apiKey: process.env.BLAZING_API_KEY,
  });
}
```

### 2. Endpoint Mapping
```typescript
// Stub (wrong)
POST /workspaces → WorkspaceDto
POST /workspaces/{id}/exec → ExecDto

// Real API (correct)
POST /v1/workspace → WorkspaceRecord
POST /v1/workspace/{id}/exec → ExecResult
GET /v1/workspaces → {workspaces: WorkspaceRecord[]}
```

### 3. Authentication Header
```typescript
// Stub (assumed)
headers["X-Api-Key"] = apiKey

// Real API (expected)
headers["Authorization"] = `Bearer ${verifyToken}`
```

## Security Considerations

1. **Token Management** - Verify proper handling of authentication tokens
2. **Input Validation** - Ensure command/args are properly sanitized
3. **Rate Limiting** - Handle API rate limits gracefully
4. **Secure Headers** - Only send necessary headers

## Performance Characteristics

- **Cold Start**: API calls have 15s timeout
- **Circuit Breaker**: Prevents thundering herd failures
- **Workspace State**: In-memory map for fast lookups
- **Connection Reuse**: Native fetch connection pooling

## Monitoring and Observability

1. **Health Checks** - Regular API health probes
2. **Capacity Tracking** - Monitor workspace usage vs limits
3. **Error Tracking** - Count and categorize failures
4. **Performance Metrics** - Track API response times

## Migration Path

From current Docker-only to dual-provider:
1. Deploy updated code with Blazing provider disabled
2. Test with Docker provider (baseline)
3. Enable Blazing provider in staging
4. Validate all endpoints work correctly
5. Production deployment with both providers available

## Testing Strategy

### Unit Tests
- Verify correct endpoint URLs
- Test DTO transformation
- Validate error mapping
- Mock HTTP responses

### Integration Tests
- Mock server with correct API responses
- Test all 7 endpoints
- Verify circuit breaker behavior
- Test error scenarios

### E2E Tests
- Local Blazing instance smoke test
- Real API call validation
- Performance under load
- Failover behavior

## Configuration

### Environment Variables
- `BLAZING_API_URL` - Base URL for Blazing API
- `BLAZING_API_KEY` - Authentication token (if required)
- `SANDBOX_MAX_WORKSPACES` - Max concurrent workspaces

### Runtime Configuration
- Per-workspace timeout (inherited from API)
- Memory/cpu limits (passed through to API)
- Custom labels (for observability)

## Potential Pitfalls

1. **API Versioning** - Ensure `/v1/` prefix is stable
2. **Field Names** - snake_case vs camel_case mapping
3. **Null Handling** - API may return null vs missing fields
4. **Timeout Propagation** - Ensure exec timeouts work correctly
5. **Destroy Idempotency** - Handle 204 on unknown IDs gracefully

## Success Metrics

1. **API Availability** - >99.9% uptime
2. **Response Time** - <1s for normal operations
3. **Error Rate** - <1% for valid requests
4. **Circuit Trips** - Minimal false positives
5. **Workspace Creation** - <30s average creation time

## Sources

- Project context from milestone description - HIGH confidence, official requirements
- Existing codebase analysis - HIGH confidence, actual implementation
- Circuit breaker pattern documentation - HIGH confidence, proven in production
- REST API integration patterns - HIGH confidence, industry standard practices