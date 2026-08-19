# Pitfalls Research

**Domain:** TypeScript REST client consuming Python FastAPI API
**Researched:** 2026-06-08
**Confidence:** HIGH (based on industry patterns and known issues)

## Critical Pitfalls

### Pitfall 1: Contract Drift Between Mock and Real API

**What goes wrong:**
The existing BlazingSandbox test suite exercises against mocked `fetch()` that assumes an OLD contract (`POST /workspaces`, flat array responses), but the real API uses `/v1/workspace` endpoints with wrapped responses `{workspaces: [...]}`. Tests pass but integration fails.

**Why it happens:**
- Mock implementations often oversimplify the real API
- Developers test happy path without error scenarios
- Test doubles (mocks/fakes) drift from real API contract
- Two-repo coordination leads to parallel development without integration validation

**How to avoid:**
- Generate test fixtures from OpenAPI spec (not manual mocks)
- Use contract testing tools like Dredd or Spectator
- Write integration tests against real API endpoints in CI
- Implement test validation that matches actual HTTP contracts

**Warning signs:**
- Mock test suites pass but real API calls fail
- Tests don't include 422/401/500 status codes
- Response shapes differ between test and production
- OpenAPI spec not used as single source of truth

**Phase to address:**
Phase 1 - Integration Test Setup (contract validation tests)

---

### Pitfall 2: Snake_case vs camelCase Type Mismatch

**What goes wrong:**
FastAPI returns JSON with snake_case fields (`container_id`, `exec_timeout_ms`) but TypeScript client expects camelCase (`containerId`, `execTimeoutMs`). Manual mappings get out of sync, causing runtime errors.

**Why it happens:**
- Python ecosystem uses snake_case by convention
- JavaScript/TypeScript uses camelCase by convention
- Manual field conversion is tedious and error-prone
- Type safety lost when doing string-based transformations

**How to avoid:**
- Use runtime transformation middleware (zod-transformer or custom)
- Generate TypeScript types from OpenAPI spec with case conversion
- Create runtime DTOs that preserve TypeScript types while converting data
- Use tool like Kiota for auto-generated clients with proper casing

**Warning signs:**
- TypeScript compilation passes but runtime errors occur
- `undefined` fields in responses despite typing
- Manual field mappings scattered across codebase
- Inconsistent casing between request/response objects

**Phase to address:**
Phase 1 - API Client Implementation (runtime transformation layer)

---

### Pitfall 3: Authentication Token Handling Mismatch

**What goes wrong:**
Blazing's auth requires `verify_token` + `get_app_id` headers, but TypeScript client sends single `X-Api-Key` or `Authorization: Bearer`. Wrong auth leads to 401s despite correct token.

**Why it happens:**
- Custom auth schemes not following standard patterns
- Incomplete documentation of required headers
- Assumption of standard OAuth/JWT flow
- Two-repo communication gap on auth implementation

**How to avoid:**
- Document exact header requirements with examples
- Implement auth interceptor that handles multiple auth methods
- Test auth failure scenarios explicitly
- Use environment variables for multiple auth tokens

**Warning signs:**
- 401/403 errors on all API calls
- Auth headers missing or incorrect in requests
- Multiple auth token types needed but only one implemented
- Auth behavior differs between dev and production

**Phase to address:**
Phase 1 - Auth Implementation (auth interceptor and test scenarios)

---

### Pitfall 4: Exec Interface Mismatch (argv-style vs shell-string)

**What goes wrong:**
Real Blazing API expects exec endpoint to receive `{command: string, args: string[]}` but the old stub assumed shell-style command string. Tool calls fail with malformed requests.

**Why it happens:**
- Sandbox interface design doesn't match actual API
- Assumption about how commands should be executed
- API contract not clearly communicated between repos
- Interface abstraction doesn't align with implementation

**How to avoid:**
- Map Sandbox interface to actual API contract in adapter layer
- Document exact exec requirements in interface comments
- Add validation for command/args format before API call
- Create test cases that verify exact request structure

**Warning signs:**
- Exec API calls return 400/422 errors
- Command arguments not parsed correctly by server
- Interface methods don't match API documentation
- Test mocks use wrong request format

**Phase to address:**
Phase 1 - Interface Implementation (adapter layer mapping)

---

### Pitfall 5: Error Mapping Inconsistency

**What goes wrong:**
- FastAPI returns 422 for `env` and `exec_timeout_ms` rejections (create endpoint)
- But TypeScript expects specific SandboxError codes
- 5xx responses trigger circuit breaker but should distinguish between network errors and server faults

**Why it happens:**
- HTTP status codes don't map cleanly to application error types
- Circuit breaker logic too broad (trips on all 5xx)
- Error response format not standardized between repos
- Missing validation of error response shape

**How to avoid:**
- Implement detailed error mapping from HTTP codes to SandboxError codes
- Add circuit breaker configuration for different error types
- Validate error response shape before parsing
- Create error assertion tests for all expected error scenarios

**Warning signs:**
- Generic "provider_unavailable" errors for specific issues
- Circuit breaker trips on temporary network issues
- Error messages don't help diagnose root cause
- Tests don't cover error response mapping

**Phase to address:**
Phase 1 - Error Handling (comprehensive error mapping tests)

---

### Pitfall 6: Two-Repo Coordination Failures

**What goes wrong:**
Changes in blazing repo (API endpoints, auth scheme) break TypeScript client without clear communication. CI passes in separate repos but integration fails.

**Why it happens:**
- No automated cross-repo validation
- Separate CI/CD pipelines don't test integration
- Release coordination lacking between repos
- Documentation not kept in sync

**How to avoid:**
- Implement cross-repo CI that tests integration
- Use dependency injection for API client in tests
- Maintain API contract documentation in both repos
- Coordinate releases between related repositories

**Warning signs:**
- API changes in one repo break the other
- Integration tests only run manually
- Different version of API contracts in each repo
- Merge conflicts in shared types/interfaces

**Phase to address:**
Phase 2 - Cross-Repo Integration (automated integration testing)

---

### Pitfall 7: stdout/stderr Handling Mismatch

**What goes wrong:**
Container runtime merges stdout+stderr, but tests expect separate stderr. Debug output and error detection fail because empty stderr breaks assumptions.

**Why it happens:**
- Runtime behavior differs from development environment
- Test environment doesn't mirror production runtime
- Container configuration affects stream behavior
- Interface doesn't account for runtime quirks

**How to avoid:**
- Don't rely on empty stderr as error indicator
- Combine stdout/stderr in output processing
- Log warnings when streams are merged
- Test against real container runtime behavior

**Warning signs:**
- Tests expecting separate stderr fail
- Error detection relies on stderr presence
- Runtime behavior differs locally vs in production
- Interface assumptions about streams

**Phase to address:**
Phase 1 - Output Handling (stream processing adaptation)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Manual field mapping | Quick implementation | Maintenance burden, typo-prone | MVP only, replace with auto-generation ASAP |
| Mock-based testing | Fast feedback loop | Contract drift, false confidence | Early development only |
| Single auth method | Simpler code | Inflexible for different auth schemes | Only if auth is guaranteed to stay simple |
| Broad error handling | Less code to write | Poor error diagnosis, hard debugging | Never in production code |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OpenAPI generation | Ignoring case conversion | Use generator that preserves TypeScript types while converting casing |
| Circuit breakers | Tripping on all failures | Distinguish between network errors and business logic errors |
| Two-repo sync | Manual updates | Automated validation that contracts match |
| Error responses | Assuming standard format | Validate and map actual error response structure |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Circuit breaker state | Rapid retries on failure | Configure appropriate thresholds and timeouts | >5 consecutive failures |
| Request timeouts | Timeouts under load | Adaptive timeout based on operation type | Concurrent >10 operations |
| Large response payloads | Memory spikes | Streaming for large responses | Response size >1MB |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing auth tokens in localStorage | XSS token theft | Use HTTP-only cookies or secure storage |
| Hardcoded credentials | Exposure in code | Environment variables with validation |
| Missing input validation | API injection attacks | Validate all inputs before API call |
| Unencrypted traffic | Man-in-middle attacks | HTTPS enforcement in all environments |

## "Looks Done But Isn't" Checklist

- [ ] **API Client:** Often missing error mapping for 422 responses — verify all HTTP status codes handled
- [ ] **Authentication:** Often missing header validation — verify all required headers sent
- [ ] **Interface Mapping:** Often assumes old contract — verify endpoint paths match real API
- [ ] **Test Coverage:** Often mocks happy path — verify error scenarios and edge cases
- [ ] **Integration:** Often separate tests — verify end-to-end flow with real API

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Contract drift | MEDIUM | 1. Freeze API contract<br>2. Generate new client types<br>3. Update all consumers<br>4. Add contract tests |
| Auth failures | LOW | 1. Document auth scheme<br>2. Update auth interceptor<br>3. Add auth tests<br>4. Validate token rotation |
| Interface mismatch | HIGH | 1. Design adapter layer<br>2. Map interface to API<br>3. Update all callers<br>4. Deprecate old interface |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Contract Drift | Phase 1 - Integration Test Setup | Contract test suite passes |
| Case Conversion | Phase 1 - API Client Implementation | Runtime transformation tested |
| Auth Handling | Phase 1 - Auth Implementation | Auth tests with 401/403 scenarios |
| Exec Interface | Phase 1 - Interface Implementation | Adapter layer tested |
| Error Mapping | Phase 1 - Error Handling | All error scenarios covered |
| Two-Repo Sync | Phase 2 - Cross-Repo Integration | Cross-repo CI passes |
| stdout/stderr | Phase 1 - Output Handling | Stream processing validated |
| Performance | Phase 3 - Optimization | Load testing with real API |

## Sources

- [FastAPI & TypeScript Integration Challenges](https://fastapi.tiangolo.com/advanced/generate-clients/)
- [API Contract Dr Prevention](https://api7.ai/learning-center/api-101/contract-testing-in-api-development)
- [Snake_case vs camelCase Best Practices](https://reddit.com/r/javascript/comments/brzfiw/camelcase_in_front_snake_case_in_the_back/)
- [JWT Authentication Pitfalls](https://medium.com/@rinkitadhana/jwt-authentication-apis-with-typescript-node-js-and-mongodb-b05a8a3cb062)
- [Cross-Repo Coordination Patterns](https://www.tembo.io/blog/cross-repo-automation)

---
*Pitfalls research for: TypeScript REST client consuming Python FastAPI API*
*Researched: 2026-06-08*