# Cleanup Report: v1.5-03 open-swe Scaffold + API Routes

**Phase:** v1.5-03-open-swe-scaffold-api-routes  
**Date:** 2026-05-04  
**Scope:** Review 11 files for redundancy, dead code, and over-defensive patterns

---

## Key Findings

### 1. Over-Defensive Error Handling Pattern (route.ts)
**File:** `app/api/open-swe/runs/route.ts`  
**Lines:** 46-63 (POST), 88-106 (GET)

**Issue:** Identical error-handling blocks in both POST and GET handlers:
- Check for `PlatformError` with status >= 500
- Check for `AbortError` 
- Default error catch

Both handlers duplicate this exact pattern, violating DRY principle.

**Recommendation:** Extract to shared utility function:
```typescript
function handlePlatformError(err: unknown): Response {
  if (err instanceof PlatformError && err.status >= 500) {
    return new Response(
      JSON.stringify({ error: "LangGraph Platform unreachable" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new Response(
      JSON.stringify({ error: "LangGraph Platform request timed out" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
  console.error("Unhandled platform error:", err);
  return new Response(JSON.stringify({ error: "Internal server error" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}
```

### 2. Over-Defensive Header Construction (langgraph-client.ts)
**File:** `lib/langgraph-client.ts`  
**Lines:** 5-13

**Issue:** `makeHeaders()` function takes `apiKey: string | undefined` but the conditional check (`if (apiKey)`) is overly defensive since the calling functions already extract and pass `process.env.LANGGRAPH_API_KEY`. The function would be simpler as:
```typescript
function makeHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}
```
Current approach is defensive but idiomatic TypeScript usage would be lighter.

### 3. Redundant Environment Variable Fallback (langgraph-client.ts)
**File:** `lib/langgraph-client.ts`  
**Line:** 44

**Issue:** Default fallback to "open-swe" string:
```typescript
const assistantId = process.env.OPEN_SWE_ASSISTANT_ID ?? "open-swe";
```

**Context:** This is actually reasonable (not redundant) since it provides a sensible default when the env var is unset. However, it conflicts with the route handler philosophy which treats missing `LANGGRAPH_PLATFORM_URL` as a fatal 502 error. Recommend consistency: either both should fail loudly, or both should have defaults. Currently inconsistent.

**Recommendation:** Add JSDoc note clarifying the fallback intent, or make it consistent with platform URL handling.

### 4. Catch Block Eating Errors (langgraph-client.ts)
**File:** `lib/langgraph-client.ts`  
**Lines:** 58, 83

**Issue:** Error recovery in `platformFetch()` is reasonable, but the `catch (() => "")` in response text extraction swallows errors:
```typescript
const text = await response.text().catch(() => "");
```

This is defensive but could mask genuine issues. Empty string is returned on error, which might confuse debugging. Consider logging or using a descriptive fallback.

**Recommendation:** 
```typescript
const text = await response.text().catch(() => "(unable to read response body)");
```

### 5. Test Fixtures with Hardcoded Dates (route.test.ts, langgraph-client.test.ts)
**File:** `app/api/open-swe/runs/route.test.ts` and `lib/langgraph-client.test.ts`

**Issue:** Tests use hardcoded date `"2026-05-04T00:00:00Z"` in 5 locations across both test files. This is not dead code, but it's not dynamic and could become stale.

**Recommendation:** Create a test helper or use a fixed date constant for consistency, or use dynamic dates to future-proof tests.

### 6. Redundant Environment Variable Stubbing (route.test.ts)
**File:** `app/api/open-swe/runs/route.test.ts`  
**Line:** 18

**Issue:** Test stubs `OPEN_SWE_ASSISTANT_ID` in beforeEach, but this env var is never directly tested in the route handler tests (it's only used inside `createRun()`, which is mocked).

**Recommendation:** Remove stub of `OPEN_SWE_ASSISTANT_ID` from route tests since the langgraph-client is mocked. Keep only `LANGGRAPH_PLATFORM_URL`.

### 7. Boilerplate Configuration Files
**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`

**Assessment:** These are standard scaffolding and not problematic. No dead code or redundancy detected.

### 8. Simple UI Components (layout.tsx, page.tsx)
**Files:** `app/layout.tsx`, `app/page.tsx`

**Assessment:** Minimal and appropriate. No over-defensiveness detected.

---

## Summary

| Category | Count | Severity |
|----------|-------|----------|
| Redundant Code Blocks | 1 | Medium |
| Over-Defensive Patterns | 3 | Low-Medium |
| Inconsistent Error Handling | 1 | Low |
| Test Cleanup Opportunities | 2 | Low |

**Total: 7 findings**

### Actionable Improvements (Priority Order)
1. **Extract error handler to utility** (route.ts) — Eliminates 18 lines of duplication
2. **Remove unused env var stub** (route.test.ts) — Simplifies test setup
3. **Improve error fallback messages** (langgraph-client.ts) — Better debugging experience
4. **Document env var fallback intent** (langgraph-client.ts) — Clarify platform vs assistant ID strategy
5. **Consolidate test date fixtures** (both test files) — Future-proof tests

---

## Code Health Assessment
- **Duplication:** Moderate (error handlers)
- **Dead Code:** None detected
- **Over-Defensiveness:** Low (mostly reasonable safety patterns)
- **Test Coverage:** Good (comprehensive mocking and edge case coverage)
