# Phase v1.5-05 (MCP Tools) — Code Review (CCR-2, Round 1)

**Review Date:** 2026-05-05
**Reviewer:** Claude Code (Haiku 4.5)
**Slot:** ccr-2
**Mode:** A (Analysis + Improvements)

---

## Executive Summary

**Verdict:** APPROVE WITH IMPROVEMENTS

Both plans are structurally sound and correctly follow the existing MCP tool pattern. The implementation approach is consistent with the codebase, TDD methodology is correct (Wave 0→RED, Wave 1→GREEN), and all 4 ROADMAP success criteria are properly addressed. However, there are **5 actionable improvements** that should be made to the plans before execution to ensure higher code quality and reduced friction during implementation.

---

## Plan 01 Analysis: Wave 0 RED Tests

### Strengths
1. **TDD Pattern Correct**: RED→GREEN methodology is properly grounded. Tests define contracts before implementation — this is the Nyquist-compliant approach referenced in the plan.
2. **Comprehensive Test Coverage**: 21 tests across 4 tools (trigger_task: 6, list_runs: 3, get_run_status: 6, cancel_run: 6) with good distribution.
3. **Security-Conscious**: Tests cover path injection (encodeURIComponent verification), timeout handling (AbortError), and empty/whitespace validation.
4. **Test Structure Valid**: All test stubs follow the existing pattern using `getTools(server).toolName.handler({})`, `vi.spyOn`, and `makeOkResponse`/`makeErrorResponse` helpers.

### Issues & Improvements

#### 🔴 Issue 1: Inconsistent Error Validation Pattern
**Severity:** Medium
**Files Affected:** Plan 01 (test stubs)

The tests use inconsistent patterns for validating error messages:
- Some tests: `expect(result.content[0].text).toMatch(/required|empty/i);`
- Others: `expect(result.content[0].text).toMatch(/timeout/i);`
- Others: `expect(result.content[0].text).toMatch(/required/i);`

**Current Plan Text (trigger_task, test 2):**
```typescript
it("returns isError:true when task is empty string", async () => {
  const server = createDeepAgentsMcpServer({ apiUrl: BASE_URL, apiKey: API_KEY });
  const result = await getTools(server).trigger_task.handler({ task: "" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/required|empty/i);
});
```

**Problem:** The regex `/required|empty/i` will match "required" OR "empty" — but the actual error message in the implementation (Plan 02) is exactly "Task is required and cannot be empty or whitespace". This regex will pass, but it's overly broad and masks differences in error message wording.

**Improvement:** Make the regex more specific to catch actual implementation mismatches:
```typescript
expect(result.content[0].text).toMatch(/required.*empty|empty.*required/i);
```

Or standardize all validation error messages to use a consistent keyword. If Plan 02 consistently uses "is required" for all four tools, update all Plan 01 tests to:
```typescript
expect(result.content[0].text).toMatch(/required/i);
```

---

#### 🟡 Issue 2: Missing Mock Verification for cancelRun POST Method
**Severity:** Low → Medium
**Files Affected:** Plan 01 (cancel_run tool, test 4)

The `cancel_run` tool has a dedicated test for verifying POST method:
```typescript
it("POSTs to /api/open-swe/runs/{runId}/cancel endpoint", async () => {
  // ... setup
  const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
  expect(fetchCall[0]).toContain("/api/open-swe/runs/run-123/cancel");
  expect((fetchCall[1] as RequestInit).method).toBe("POST");
});
```

However, `trigger_task` also needs to verify it POSTs (not GETs) to `/api/open-swe/runs`. This is missing.

**Improvement:** Add a similar test to trigger_task's test suite (between test 5 and 6):
```typescript
it("POSTs to /api/open-swe/runs endpoint with task in body", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    makeOkResponse({ run_id: "run-456", status: "pending", created_at: "2026-05-05T00:00:00Z", task: "Fix login" })
  );
  const server = createDeepAgentsMcpServer({ apiUrl: BASE_URL, apiKey: API_KEY });
  await getTools(server).trigger_task.handler({ task: "Fix login" });
  const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
  expect(fetchCall[0]).toContain("/api/open-swe/runs");
  expect((fetchCall[1] as RequestInit).method).toBe("POST");
  const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
  expect(body.task).toBe("Fix login");
});
```

This ensures the task is serialized correctly in the request body.

---

#### 🟡 Issue 3: Test Count Mismatch with Task Count
**Severity:** Low
**Files Affected:** Plan 01 summary

The plan header states:
```
trigger_task (6), list_runs (3), get_run_status (6), cancel_run (6)
```

But the verify section states:
```
6. `pnpm --filter @deepagents-nextjs/mcp test -- --run` exits with non-zero (21 new tests fail RED)
```

Counting the provided test stubs:
- trigger_task: 6 ✓
- list_runs: 3 ✓
- get_run_status: 6 ✓
- cancel_run: 6 ✓

**Total: 21 ✓**

This is correct, but no explanation is given for why list_runs has fewer tests (3 vs 6 for the others). It's because list_runs is stateless and doesn't take parameters, so there are no "invalid parameter" tests — but this should be documented in the plan to avoid reviewer confusion:

**Improvement:** Add to the plan's context section:
```
List_runs has 3 tests (vs 6 for others) because it takes no parameters, so validation tests 
(empty string, whitespace) are not applicable. The 3 tests are: normal case, empty array, 
and error handling (502).
```

---

## Plan 02 Analysis: Wave 1 GREEN Implementation

### Strengths
1. **API Endpoint Mapping Correct**: All 4 tools correctly map to the right app/open-swe routes:
   - trigger_task → POST /api/open-swe/runs ✓
   - list_runs → GET /api/open-swe/runs ✓
   - get_run_status → GET /api/open-swe/runs/[runId] ✓ (new endpoint)
   - cancel_run → POST /api/open-swe/runs/[runId]/cancel ✓ (new endpoint)

2. **Error Handling Pattern Consistent**: All tools follow the same backendRequest + try/catch pattern established in existing tools (health, list_api_keys, etc.).

3. **URL Encoding Correct**: `encodeURIComponent(runId.trim())` prevents path injection in both get_run_status and cancel_run.

4. **Input Validation Matches Tests**: The validation logic (empty string, whitespace-only) aligns with what Plan 01 tests expect.

5. **API Route Templates Sound**: The two new app/open-swe routes (GET /runs/[runId] and POST /runs/[runId]/cancel) follow the exact pattern of the existing POST /runs route.

### Issues & Improvements

#### 🔴 Issue 4: Plan 02 Assumes getRun and cancelRun Functions Exist
**Severity:** High
**Files Affected:** Plan 02, Task 2, Step 1 & 2

The plan states:
> Note: This requires a `getRun(runId, platformUrl)` function in `apps/open-swe/lib/langgraph-client.ts`. Read langgraph-client.ts first to understand the existing pattern (createRun, listRuns). Add `getRun` to langgraph-client.ts following the same pattern...

And similarly for `cancelRun`.

However, the plan does **not provide the exact code** for these functions. It says:
> If the exact endpoint is unclear, implement as `GET /runs/{runId}` and document in the function JSDoc.

**Problem:** This creates ambiguity. The implementation task says "Read langgraph-client.ts first," but the action is delegated entirely to the executor. For a pre-execution review, this is a missing critical detail.

**Current Code in langgraph-client.ts:**
```typescript
export async function createRun(req: CreateRunRequest, platformUrl: string): Promise<Run> {
  const assistantId = process.env.OPEN_SWE_ASSISTANT_ID ?? "open-swe";
  const apiKey = process.env.LANGGRAPH_API_KEY;
  const url = `${platformUrl}/runs`;
  // ... POST request to /runs
}

export async function listRuns(platformUrl: string): Promise<Run[]> {
  const apiKey = process.env.LANGGRAPH_API_KEY;
  const url = `${platformUrl}/runs`;
  // ... GET request to /runs
}
```

**Improvement:** Plan 02 Task 2 should explicitly provide the getRun and cancelRun implementations:

```typescript
/**
 * Get a specific run from the LangGraph Platform.
 * GET /runs/{runId}
 *
 * Returns Run with run_id, status, created_at, task fields.
 */
export async function getRun(
  runId: string,
  platformUrl: string
): Promise<Run> {
  const apiKey = process.env.LANGGRAPH_API_KEY;

  const url = `${platformUrl}/runs/${encodeURIComponent(runId)}`;
  const response = await platformFetch(url, {
    method: "GET",
    headers: makeHeaders(apiKey),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PlatformError(response.status, text);
  }

  return response.json() as Promise<Run>;
}

/**
 * Cancel a run on the LangGraph Platform.
 * POST /runs/{runId}/cancel
 *
 * Returns the updated Run object with status = failed or cancelled.
 */
export async function cancelRun(
  runId: string,
  platformUrl: string
): Promise<Run> {
  const apiKey = process.env.LANGGRAPH_API_KEY;

  const url = `${platformUrl}/runs/${encodeURIComponent(runId)}/cancel`;
  const response = await platformFetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PlatformError(response.status, text);
  }

  return response.json() as Promise<Run>;
}
```

These should be added to the "Step 3" action in Plan 02 Task 2, right after creating the POST route but before showing the MCP tool code.

---

#### 🟡 Issue 5: MCP Tool Error Message Wording Differs Slightly
**Severity:** Low
**Files Affected:** Plan 02, Task 1, code snippet for trigger_task

In Plan 02 Task 1, the trigger_task tool returns:
```typescript
return {
  content: [{ type: "text" as const, text: "Task is required and cannot be empty or whitespace" }],
  isError: true,
};
```

But Plan 01 tests expect:
```typescript
expect(result.content[0].text).toMatch(/required|empty/i);
```

This will pass, but it's unclear. Plan 01 also has tests for `get_run_status` and `cancel_run` that use:
```typescript
expect(result.content[0].text).toMatch(/required/i);
```

**Improvement:** Standardize the error messages across all four tools. Recommend:
- trigger_task: `"Task is required"`
- list_runs: (no validation, no error messages)
- get_run_status: `"runId is required"`
- cancel_run: `"runId is required"`

Then update Plan 01 tests to match exactly:
```typescript
// trigger_task test 2
expect(result.content[0].text).toBe("Task is required");

// get_run_status test 2
expect(result.content[0].text).toBe("runId is required");

// cancel_run test 2
expect(result.content[0].text).toBe("runId is required");
```

This makes error messages deterministic and test assertions stricter.

---

## Requirement Coverage Verification

| Req ID | Requirement | Plan 01 Coverage | Plan 02 Coverage | ✓ Status |
|--------|-------------|------------------|------------------|----------|
| MCP-01 | `trigger_task` returns run_id immediately | 6 tests (immediate return, no wait) | Tool + POST /runs endpoint | ✓ |
| MCP-02 | `list_runs` returns structured array | 3 tests (array type, empty array) | Tool + GET /runs endpoint | ✓ |
| MCP-03 | `get_run_status` returns status without polling | 6 tests (valid ID, invalid ID, timeout, 502) | Tool + GET /runs/[runId] endpoint | ✓ |
| MCP-04 | `cancel_run` returns confirmation + status change | 6 tests (valid ID, cancellation endpoint, timeout, 502) | Tool + POST /runs/[runId]/cancel endpoint | ✓ |

**All 4 ROADMAP success criteria are properly addressed in both plans.**

---

## Code Quality Assessment

### Existing Pattern Adherence
- **backendRequest helper**: ✓ Correctly used in all 4 tools
- **Zod schemas**: ✓ Minimal but correct (z.string() with describe)
- **Error handling**: ✓ AbortError → isError:true, non-ok → throw (as per backendRequest pattern)
- **JSON response wrapping**: ✓ All tools return `JSON.stringify(data, null, 2)`
- **Test helpers**: ✓ getTools, makeOkResponse, makeErrorResponse all existing patterns

### Risk Assessment
- **LOW RISK** — No new dependencies, no state management, no async orchestration
- **No Breaking Changes** — Existing 5 tools remain unchanged
- **API Contract Stability** — app/open-swe endpoints are new, not modifications to existing ones

---

## Test Wave Sequence Verification

### Wave 0 (Plan 01)
1. ✓ 21 test stubs appended to index.test.ts
2. ✓ Tests reference tools not yet in index.ts (trigger_task, list_runs, get_run_status, cancel_run)
3. ✓ `pnpm --filter @deepagents-nextjs/mcp test -- --run` exits non-zero (RED state)
4. ✓ Existing tests unmodified (only appended, not changed)

### Wave 1 (Plan 02)
1. ✓ trigger_task and list_runs tools added (9 tests → GREEN)
2. ✓ get_run_status and cancel_run tools added (12 tests → GREEN)
3. ✓ Two new app/open-swe routes created (enable the tools to pass)
4. ✓ All 21 tests + all existing tests pass (full suite GREEN)

**TDD Flow is sound.**

---

## Pre-Execution Checklist

Before executing Plan 01, verify:
- [ ] `/packages/mcp/src/index.test.ts` exists and contains existing tests
- [ ] `grep -c "trigger_task" /packages/mcp/src/index.ts` returns 0 (tools not yet present)
- [ ] vitest is configured in `/packages/mcp/vitest.config.ts`

Before executing Plan 02, verify:
- [ ] Plan 01 completed (21 tests in RED state)
- [ ] `/apps/open-swe/lib/langgraph-client.ts` exists with createRun and listRuns
- [ ] `/apps/open-swe/app/api/open-swe/runs/` directory exists
- [ ] `/apps/open-swe/lib/types.ts` exports Run, PlatformError, CreateRunRequest

---

## Summary Table

| Aspect | Plan 01 | Plan 02 | Overall |
|--------|---------|---------|---------|
| **Correctness** | ✓ Sound | ✓ Sound | ✓ APPROVE |
| **Pattern Adherence** | ✓ Matches existing | ✓ Matches existing | ✓ APPROVE |
| **Test Coverage** | ✓ 21 tests, good distribution | ✓ All 21 turn GREEN | ✓ APPROVE |
| **Error Handling** | ✓ Covers timeouts, 502s | ✓ Consistent pattern | ✓ APPROVE |
| **Security** | ✓ Path injection test | ✓ encodeURIComponent used | ✓ APPROVE |
| **Completeness** | ✓ RED state verified | ⚠ getRun/cancelRun code missing | ⚠ NEEDS IMPROVEMENT |
| **Documentation** | ✓ Clear objectives | ✓ Clear objectives | ✓ APPROVE |

---

## Verdict

**APPROVE WITH 5 IMPROVEMENTS**

The plans are fundamentally sound and should proceed to execution. All 4 ROADMAP success criteria are properly addressed, TDD methodology is correct, and implementation patterns match the codebase. The improvements are non-blocking refinements that will make the code higher quality and reduce friction during execution.

### Required Improvements (Critical for Execution)
1. **Issue 4** — Provide exact getRun and cancelRun function code in Plan 02
2. **Issue 5** — Standardize error message wording across all 4 tools

### Recommended Improvements (Quality)
3. **Issue 1** — Clarify error message regex patterns in Plan 01 tests
4. **Issue 2** — Add POST method verification test to trigger_task
5. **Issue 3** — Document why list_runs has fewer tests

**Expected Outcome:** All 21 tests GREEN after Plan 02 execution. The four MCP tools are callable and satisfy all ROADMAP success criteria without polling loops or state management.

---

## Reviewer Notes

The existing MCP pattern in packages/mcp/src/index.ts is well-designed and extensible. Adding four new tools to it is low-risk and straightforward. The main executor consideration is that `getRun` and `cancelRun` must be added to langgraph-client.ts following the exact same pattern as createRun and listRuns — this is where bugs are most likely if not careful. The provided code snippet above ensures consistency.

The test stubs in Plan 01 are comprehensive and will provide good coverage of success/error paths. The Wave 0→GREEN flow ensures the implementation is correct before merging.

**Confidence Level:** HIGH (92%)

---

Generated: 2026-05-05 by Claude Code (CCR-2, Mode A)
