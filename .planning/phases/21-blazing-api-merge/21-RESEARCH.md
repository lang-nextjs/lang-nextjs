# Phase 21: Blazing API Merge - Research

**Researched:** 2026-06-08
**Domain:** REST API implementation, Python/FastAPI, CI/CD workflows
**Confidence:** HIGH (based on existing blazing patterns and clear requirements)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BLZ-01 | PR #81 (`/v1/workspace` REST API — 7 endpoints, 56 tests) is merged into blazing master | FastAPI patterns identified, merge workflow established |
| BLZ-02 | Staging smoke test passes: `curl` create → exec `echo hello` → delete round-trip | Test scaffolding patterns documented, verification commands identified |
| BLZ-03 | Kill switch (`WORKSPACE_API_ENABLED=false`) disables all `/v1/workspace*` routes | FastAPI dependency injection patterns documented |
</phase_requirements>

## Summary

Phase 21 focuses on landing the Blazing workspace REST API from the blazing repository into production. This requires merging PR #81 which implements a FastAPI-based workspace management system with 7 endpoints, comprehensive test coverage (56 tests), and a kill switch mechanism. The implementation follows established blazing patterns using FastAPI with proper error handling, authentication via `verify_token` and `get_app_id`, and robust retry mechanisms.

**Primary recommendation:** Follow the established FastAPI patterns in the blazing repository, use the admin-merge workflow due to billing-blocked CI, and implement proper smoke testing that validates the complete round-trip flow.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| FastAPI | Latest | REST API framework | Industry standard for Python async APIs, built-in OpenAPI support |
| Pydantic | Latest | Data validation | Type-safe request/response models, automatic serialization |
| httpx | Latest | HTTP client | Async HTTP client with built-in retry capabilities |
| aredis_om | Latest | Redis ORM | For operation state persistence, blazing's standard pattern |
| pytest | Latest | Testing | blazing's standard test framework with async support |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| TestClient | - | FastAPI testing | For integration tests without live server |
| pytest-asyncio | - | Async testing | For async endpoint tests |
| redis | - | Redis client | For direct operations in tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| httpx | requests | requests is sync-only, blocking for blazing's async architecture |
| aredis_om | redis-py | aredis_om provides ORM features that blazing uses throughout codebase |

**Installation:**
```bash
# Already part of blazing repo - no additional dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/blazing_service/workspace/
├── __init__.py
├── rest_api.py          # Main REST API implementation (573 lines)
├── models.py           # Pydantic models for request/response
├── service.py          # Business logic layer
└── dao.py              # Data access layer

tests/
└── test_workspace_rest_api.py  # Integration tests (908 lines)
```

### Pattern 1: FastAPI Endpoint Structure
**What:** Standard blazing endpoint pattern with proper error handling, auth, and retry
**When to use:** For all workspace API endpoints
**Example:**
```python
# Source: /Users/jonathanborduas/code/blazing/src/blazing_service/server.py
@app.post("/v1/workspace", status_code=status.HTTP_201_CREATED)
async def create_workspace(
    request: CreateWorkspaceRequest,
    authorization: str = Depends(auth_dependency)
) -> WorkspaceRecord:
    # Verify token and get app_id
    app_id = await get_app_id(authorization)
    
    # Validate request
    validated = request.model_validate(request)
    
    # Execute with retry
    result = await _server_request_with_retry(
        client, "POST", f"{EXECUTOR_URL}/workspace/create",
        "create_workspace", json=validated.dict()
    )
    
    # Handle response
    if result.status_code != 201:
        raise HTTPException(status_code=result.status_code, detail=result.text)
    
    return WorkspaceRecord.model_validate(result.json())
```

### Pattern 2: Workspace State Management
**What:** Using proper state tracking for workspace lifecycle
**When to use:** For any endpoint that handles workspace state changes
**Example:**
```python
# Standard state enum
class WorkspaceState(str, Enum):
    CREATING = "creating"
    RUNNING = "running" 
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"

# State-based handler
async def get_workspace_state(workspace_id: str) -> WorkspaceState:
    # Redis lookup via aredis_om
    pass
```

### Anti-Patterns to Avoid
- **Synchronous database calls:** All blazing APIs are async, use async Redis patterns
- **Manual retry logic:** Use `_server_request_with_retry` for consistent retry behavior
- **Bypassing auth:** All endpoints must verify via `verify_token` + `get_app_id`

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Authentication | Custom JWT verification | `verify_token` + `get_app_id` | blazing's existing auth system with proper token validation |
| HTTP retry | Custom retry logic | `_server_request_with_retry` | Built-in AWS-style jitter retry, properly configured |
| Error handling | Manual HTTP status mapping | FastAPI `HTTPException` + status codes | Consistent error format and status codes |
| Redis operations | Manual Redis commands | aredis_om models blazing's standard |

**Key insight:** The blazing ecosystem has well-established patterns for authentication, retry, and data persistence. Custom implementations would introduce inconsistencies and likely regressions.

## Common Pitfalls

### Pitfall 1: CI/CD Billing Block
**What goes wrong:** GitHub Actions billing blocks automated CI runs
**Why it happens:** Enterprise billing policies restrict automated workflows
**How to avoid:** Use admin-merge workflow: `gh pr merge --squash --admin`
**Warning signs:** PR checks failing without actual test failures

### Pitfall 2: Environment Variable Scoping
**What goes wrong:** Kill switch not properly scoped to workspace endpoints
**Why it happens:** FastAPI dependency injection not correctly configured
**How to avoid:** Use dependency factory pattern for conditional feature flags
**Warning signs:** Endpoints still accessible when disabled

### Pitfall 3: Authentication Bypass
**What goes wrong:** New endpoints missing proper auth verification
**Why it happens:** Copy-paste errors or missing auth dependency injection
**How to avoid:** Verify all endpoints include `authorization: str = Depends(auth_dependency)`
**Warning signs:** Missing auth imports or dependency injection

### Pitfall 4: State Machine Complexity
**What goes wrong:** Workspace lifecycle state transitions not properly handled
**Why it happens:** Async state management is complex and error-prone
**How to avoid:** Use established blazing patterns with proper state enums
**Warning signs:** Multiple state variables tracking similar concepts

## Code Examples

### Endpoint Implementation Pattern
```python
# Source: Based on existing blazing server.py patterns
from fastapi import Depends, FastAPI, HTTPException, status
from blazing_common.auth import verify_token, get_app_id

@app.get("/v1/workspace/{workspace_id}")
async def get_workspace(
    workspace_id: str,
    authorization: str = Depends(auth_dependency)
) -> WorkspaceRecord:
    """Get a specific workspace by ID."""
    app_id = await get_app_id(authorization)
    
    # Check if workspace exists and belongs to app
    workspace = await workspace_dao.get(workspace_id)
    if not workspace or workspace.app_id != app_id:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    return workspace
```

### Kill Switch Pattern
```python
# Source: FastAPI dependency injection pattern
from fastapi import Depends, HTTPException

async def check_workspace_enabled():
    """Dependency to check if workspace API is enabled."""
    if not os.getenv("WORKSPACE_API_ENABLED", "true").lower() == "true":
        raise HTTPException(status_code=404, detail="Not found")
    return True

@app.get("/v1/workspace/{workspace_id}", dependencies=[Depends(check_workspace_enabled)])
async def get_workspace_enabled(...):
    """Endpoint only available when workspace API is enabled."""
    ...
```

### Test Pattern
```python
# Source: Based on test_operation_data_api.py
@pytest.mark.asyncio
async def test_create_workspace_smoke():
    """Test full round-trip: create → exec → delete."""
    # Create workspace
    create_resp = client.post("/v1/workspace", json={"image": "python:3.9"})
    assert create_resp.status_code == 201
    workspace_id = create_resp.json()["id"]
    
    # Execute command
    exec_resp = client.post(f"/v1/workspace/{workspace_id}/exec", 
                           json={"command": "echo hello"})
    assert exec_resp.status_code == 200
    assert exec_resp.json()["stdout"] == "hello\n"
    
    # Delete workspace
    delete_resp = client.delete(f"/v1/workspace/{workspace_id}")
    assert delete_resp.status_code == 204
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual HTTP clients | httpx with retry | 2024 | Consistent retry behavior, better error handling |
| Custom auth | verify_token + get_app_id | 2024 | Standardized across all blazing endpoints |
| No state tracking | explicit WorkspaceState enum | 2024 | Better reliability, clearer state transitions |

**Deprecated/outdated:**
- requests library: blazing is async-first, requests is sync-only
- Custom error formats: FastAPI provides consistent HTTPException handling

## Validation Architecture

### Test Framework and Commands
```bash
# Quick test run (smoke test only)
pytest tests/test_workspace_rest_api.py::test_create_exec_delete_smoke -v

# Full test suite
pytest tests/test_workspace_rest_api.py -v --cov=src/blazing_service/workspace/rest_api.py

# Staging smoke test validation
curl -X POST $BLAZING_URL/v1/workspace \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"image": "python:3.9"}' | jq '.id' > workspace_id
curl -X POST $BLAZING_URL/v1/workspace/$(cat workspace_id)/exec \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo hello"}' | jq '.stdout'
curl -X DELETE $BLAZING_URL/v1/workspace/$(cat workspace_id) \
  -H "Authorization: Bearer $TOKEN"
```

### Wave 0 Test Scaffolding Requirements
1. **Fixtures:** 
   - `mock_workspace_dao()` - for DAO layer testing
   - `auth_dependency_override()` - for testing without real auth
   - `test_app()` - FastAPI test app fixture

2. **Test Data:** 
   - Sample workspace creation payloads
   - Expected response DTOs
   - Error response scenarios

### Per-Task Test Types
| Task | Test Type | Coverage Area |
|------|-----------|---------------|
| Merge PR #81 | Integration test | 7 endpoints, 56 tests pass |
| Smoke test | E2E test | create → exec → delete round-trip |
| Kill switch verification | Negative test | 404 when disabled, 200 when enabled |

## Open Questions

1. **Workspace State Persistence**
   - What we know: aredis_om is used throughout blazing
   - What's unclear: Specific DAO models for workspace state
   - Recommendation: Follow existing operation_dao pattern

2. **Executor URL Configuration**
   - What we know: Executor backend is at configurable URL
   - What's unclear: Whether workspace uses same EXECUTOR_URL constant
   - Recommendation: Check server.py for URL configuration

3. **Concurrency Control**
   - What we know: Blazing has concurrency limits
   - What's unclear: If workspace endpoints respect same limits
   - Recommendation: Verify with `wait_for_concurrency_slot` pattern

## Sources

### Primary (HIGH confidence)
- `/Users/jonathanborduas/code/blazing/src/blazing_service/server.py` - FastAPI patterns and auth implementation
- `/Users/jonathanborduas/code/blazing/tests/test_operation_data_api.py` - Test structure and patterns
- `/Users/jonathanborduas/code/lang-nextjs/.planning/REQUIREMENTS.md` - BLZ-01, BLZ-02, BLZ-03 requirements

### Secondary (MEDIUM confidence)
- Web search for FastAPI best practices with async/await
- GitHub documentation for admin-merge workflow

### Tertiary (LOW confidence)
- Additional FastAPI pattern documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Based on existing blazing codebase patterns
- Architecture: HIGH - Clear from existing server.py implementation
- Pitfalls: HIGH - Based on CI billing issues mentioned in requirements

**Research date:** 2026-06-08
**Valid until:** 2026-07-08