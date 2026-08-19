---
phase: 1-issue-12
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified: [packages/server/src/approval-routes.test.ts]
autonomous: true
requirements: []
must_haves:
  truths:
    - "All approval route handlers (GET and POST) have comprehensive test coverage"
    - "Tests cover approval request, approval grant, approval denial, timeout, concurrent approvals, invalid approval IDs, expired approvals, and authorization checks"
    - "Test file follows existing patterns from approval-registry.test.ts"
    - "Tests can be run via npm test and pass"
  artifacts:
    - path: "packages/server/src/approval-routes.test.ts"
      provides: "Comprehensive test coverage for approval-routes.ts"
      min_lines: 200
      contains: "describe('approval-routes',"
  key_links:
    - from: "packages/server/src/approval-routes.test.ts"
      to: "packages/server/src/approval-routes.ts"
      via: "import createApprovalRoutes"
      pattern: "import.*createApprovalRoutes.*from.*approval-routes"
    - from: "packages/server/src/approval-routes.test.ts"
      to: "packages/server/src/approval-registry.ts"
      via: "import registerApproval, getApproval, cleanupApproval"
      pattern: "import.*registerApproval.*from.*approval-registry"
formal_artifacts: none
---

<objective>
Create comprehensive test coverage for packages/server/src/approval-routes.ts.

Purpose: This file handles security-sensitive approval gating but has zero test coverage. Tests must cover all scenarios: approval request (GET), approval grant (POST with approve), approval denial (POST with reject), timeout, concurrent approvals, invalid approval IDs, expired approvals, and authorization checks.

Output: approval-routes.test.ts with 15+ tests covering all routes and edge cases.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/1-issue-12/scope-contract.json

@packages/server/src/approval-routes.ts (target file to test)
@packages/server/src/approval-registry.ts (registry API)
@packages/server/src/approval-registry.test.ts (existing test patterns)
</context>

<feature>
  <name>approval-routes comprehensive test suite</name>
  <files>
    packages/server/src/approval-routes.test.ts
  </files>
  <behavior>
    Approval routes (GET /api/approval/[approvalId] and POST /api/approval/[approvalId])
    must handle:

    GET /api/approval/[approvalId]:
    - Returns 200 with approval data for valid, non-expired approval
    - Returns 404 for non-existent approvalId
    - Returns 200 with status="timeout" for expired approval (registry marks on get)
    - Returns approval object with: id, toolCallId, toolName, status, createdAt, expiresAt

    POST /api/approval/[approvalId] with decision="approve":
    - Returns 200 with {id, decision: "approve", accepted: true}
    - Sets approval.status to "approved" in registry
    - Does NOT call cleanupApproval() (QUORUM-1: transform handles after drain)

    POST /api/approval/[approvalId] with decision="reject":
    - Returns 200 with {id, decision: "reject", accepted: true}
    - Sets approval.status to "rejected" in registry

    POST error cases:
    - Returns 400 for invalid JSON body
    - Returns 400 for decision !== "approve" or "reject"
    - Returns 404 for non-existent approvalId
    - Returns 409 for already-resolved approval (status !== "waiting")

    Concurrency scenarios:
    - Multiple POST requests to same approvalId: first resolves, subsequent return 409

    Timeout/expired scenarios:
    - POST on expired approval returns 404 (approval not found or expired)
    - GET on expired approval returns 200 with status="timeout"
  </behavior>
  <implementation>
    Use Vitest testing framework (already configured in packages/server).
    Follow patterns from approval-registry.test.ts:
    - Use afterEach for cleanup with cleanupApproval(id)
    - Use vi.useFakeTimers() for timeout scenarios
    - Use makeApproval helper for test data
    - Import and test createApprovalRoutes factory function

    Test structure:
    1. Setup: createApprovalRoutes() factory
    2. Helper: register test approval via registerApproval()
    3. Test GET route with NextRequest mock
    4. Test POST route with NextRequest mock (body parsing)
    5. Cleanup: cleanupApproval(id) in afterEach

    Note: Authorization checks are placeholder (no real auth in approval-routes.ts),
    so test should verify current behavior (no auth check) as-is.
  </implementation>
</feature>

<tasks>

<task type="auto">
  <name>Task 1: Create comprehensive test suite for approval-routes.ts</name>
  <files>packages/server/src/approval-routes.test.ts</files>
  <action>
    Create packages/server/src/approval-routes.test.ts with comprehensive test coverage.

    Import: describe, it, expect, afterEach, vi from vitest; NextRequest, NextResponse from next/server;
    createApprovalRoutes from ./approval-routes; registerApproval, getApproval, cleanupApproval from ./approval-registry;
    type PendingApproval from ./approval-registry.

    Helper function makeApproval(approvalId: string, overrides?: Partial<PendingApproval>): PendingApproval
    - Returns test approval object with defaults
    - approvalId from param, toolCallId=`tc-${approvalId}`, toolName="bash_execute",
      input={command: "echo test"}, status="waiting", createdAt=ISO string, expiresAt=Date.now()+60000

    afterEach: vi.useRealTimers(); cleanupApproval(testIds) for all test IDs

    Test groups:

    describe('approval-routes — GET /api/approval/[approvalId]'):
      1. GET returns 200 with approval data for valid approval
         - Register approval, call GET handler, verify 200 response contains id, toolCallId, toolName, status, createdAt, expiresAt
      2. GET returns 404 for non-existent approvalId
         - Call GET handler with unknown ID, verify 404 with error message
      3. GET returns 200 with status="timeout" for expired approval
         - Use vi.useFakeTimers(), register approval with expiresAt=Date.now()+1000, advance 2000ms, call GET, verify status="timeout"
      4. GET returns all required fields in response
         - Verify response object structure matches expected schema

    describe('approval-routes — POST /api/approval/[approvalId] with approve'):
      5. POST with decision="approve" returns 200 and sets status to "approved"
         - Register approval, POST {decision: "approve"}, verify 200 response, check registry status="approved"
      6. POST with approve does NOT call cleanupApproval (QUORUM-1)
         - After POST approval, call getApproval() and verify entry still exists (transform handles cleanup after drain)

    describe('approval-routes — POST /api/approval/[approvalId] with reject'):
      7. POST with decision="reject" returns 200 and sets status to "rejected"
         - Register approval, POST {decision: "reject"}, verify 200 response, check registry status="rejected"

    describe('approval-routes — POST error cases'):
      8. POST returns 400 for invalid JSON body
         - Mock NextRequest.json() to throw, call POST, verify 400 with "invalid JSON body"
      9. POST returns 400 for invalid decision value
         - POST {decision: "invalid"}, verify 400 with "decision must be 'approve' or 'reject'"
      10. POST returns 400 for missing decision field
          - POST {}, verify 400 error
      11. POST returns 404 for non-existent approvalId
          - POST to unknown ID, verify 404 with "approval not found or expired"
      12. POST returns 409 for already-resolved approval
          - Resolve approval first, then POST, verify 409 with "approval already resolved"
      13. POST on already-approved approval returns 409
          - Approve approval, POST again, verify 409 with status="approved"
      14. POST on already-rejected approval returns 409
          - Reject approval, POST again, verify 409 with status="rejected"

    describe('approval-routes — concurrency'):
      15. Multiple concurrent POST requests: first resolves, subsequent return 409
          - Register approval, POST twice, first returns 200, second returns 409

    describe('approval-routes — timeout and expiration'):
      16. POST on expired approval returns 404
          - Use vi.useFakeTimers(), register with expiresAt=Date.now()+1000, advance 2000ms, POST, verify 404
      17. GET on timed-out approval returns status="timeout"
          - Same setup as #16, call GET instead, verify status="timeout"

    describe('approval-routes — authorization (placeholder)'):
      18. GET has no authorization check (current behavior)
          - Call GET without auth headers, verify 200 (no auth required currently)

    Mocking NextRequest:
    - Use new Request('http://localhost/api/approval/test-id') with NextRequest wrapper
    - For POST with body: new Request('url', {method: 'POST', body: JSON.stringify({decision: "approve"})})
    - Context: {params: Promise.resolve({approvalId: "test-id"})}

    Verification:
    - Use expect(response.status).toBe(expectedCode)
    - Use expect(await response.json()).toEqual(expectedBody)
    - Use expect(getApproval(id)?.status).toBe(expectedStatus) for registry state
  </action>
  <verify>
    cd packages/server && npm test -- approval-routes.test.ts
  </verify>
  <done>
    All 18 tests pass, covering:
    - GET route (success, not found, timeout)
    - POST route (approve, reject, all error cases)
    - Concurrency (multiple POST requests)
    - Timeout/expired scenarios
    - Authorization (placeholder test for current behavior)

    Test file follows patterns from approval-registry.test.ts and runs successfully.
  </done>
</task>

</tasks>

<verification>
After completing the task, verify:

1. Test file exists at packages/server/src/approval-routes.test.ts
2. npm test -- approval-routes.test.ts passes with 15+ tests
3. All route handler scenarios are covered (GET, POST, errors, concurrency, timeout)
4. Tests follow existing project patterns (afterEach cleanup, vi.useFakeTimers for time-based tests)
5. Tests are isolated (no state leakage between tests)
</verification>

<success_criteria>
- Test file created with 15+ tests covering all approval route scenarios
- All tests pass when run via npm test
- Test coverage includes: GET (success/404/timeout), POST (approve/reject/error cases), concurrency, expiration
- Tests follow project conventions from approval-registry.test.ts
- Tests can be run independently without affecting other test suites
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-12/1-SUMMARY.md`
</output>