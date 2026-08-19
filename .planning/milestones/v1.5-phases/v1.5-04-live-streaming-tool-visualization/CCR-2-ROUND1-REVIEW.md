# v1.5-04 Plans Review: CCR-2 Round 1

**Reviewer:** Claude Sonnet 4.6 (Haiku mode)
**Date:** 2026-05-04
**Scope:** v1.5-04-01-PLAN.md, v1.5-04-02-PLAN.md (pre-execution review)

## Executive Summary

**VOTE: APPROVE with structured improvements**

Both plans are technically sound and executable. The architecture correctly implements the five requirements (1) SSE proxy route, (2-4) React hooks and UI components with proper state isolation, (5) per-runId stream isolation. However, there are 8 specific improvements needed to prevent execution failures.

**Critical Issues:** 3 (fixes required before execution)
**Medium Issues:** 3 (should fix; will cause minor test failures)
**Minor Issues:** 2 (nice-to-have; DX improvements)

---

## Requirement-by-Requirement Analysis

### Requirement 1: SSE Proxy Route GET /api/open-swe/runs/[runId]/stream

**Status:** ✅ CORRECT
- Route handler correctly validates `threadId` query param (400 response)
- Correct 502 response when LANGGRAPH_PLATFORM_URL env unset
- Correct Content-Type: text/event-stream header
- Dynamic export + proper abort handling
- Relative imports (no @/ alias)

**Quality:** HIGH. Implementation is minimal, stateless, and defensive.

---

### Requirement 2-3: React Hooks (useRunStream + useToolState)

**Status:** ✅ CORRECT (with caveats)

**useRunStream:**
- EventSource per-component instance ✅
- Proper cleanup on unmount ✅
- Event parsing with JSON.parse try-catch ✅
- URL pattern: `/api/open-swe/runs/${runId}/stream?threadId=...` ✅

**useToolState:**
- Map keyed by toolCallId ✅
- Pending → completed transition ✅
- Immutable state updates ✅

---

### Requirement 4: ToolCard Component + RunDetail Page

**Status:** ⚠️ PARTIAL

**ToolCard:**
- Renders pending/completed states ✅
- Expand button only on completed ✅
- Full JSON.stringify of input+output ✅
- Test attributes (data-testid) present ✅

**RunDetail page:**
- Uses useRunStream + useToolState ✅
- Accumulates text tokens via filter + map + join ✅
- Renders ToolCards with toolCallId key ✅
- **ISSUE:** threadId read via `window.location.search` client-side will cause React hydration mismatch if SSR is enabled (Next.js 15 App Router default)

---

### Requirement 5: Stream Isolation per runId (DASH-05)

**Status:** ✅ CORRECT
- Each useRunStream hook creates its own EventSource instance
- No module-level EventSource storage
- URL includes runId in path
- Concurrent tabs would have separate contexts

---

## Critical Issues (Must Fix Before Execution)

### ISSUE #1: RunDetail Page Hydration Mismatch

**Location:** v1.5-04-02-PLAN.md, Task 2 - RunDetail implementation

**Problem:**
```typescript
const threadId =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("threadId") ?? ""
    : "";
```

This pattern returns `""` on server side, but a non-empty value on client, causing React hydration mismatch error. Tests will pass (jsdom has window), but production deployment will fail.

**Fix:**
Use `useSearchParams()` hook from 'next/navigation' instead, with a comment noting "Requires wrapping in Suspense boundary; v1.5-05 refactors to accept threadId as prop from run list."

---

### ISSUE #2: EventSource "done" Event Not Standard

**Location:** v1.5-04-02-PLAN.md, Task 1 - useRunStream implementation

**Problem:**
```typescript
es.addEventListener("done", () => {
  setStatus("done");
  es.close();
});
```

The browser EventSource API does NOT emit a "done" event. Standard events are: "open", "message", "error". LangGraph Platform stream must send a custom event or marker.

**Impact:** Status will never transition to "done"; stream cleanup is fragile.

**Fix:**
Check v1.5-04-RESEARCH.md for LangGraph Platform event format. If no explicit end event, listen for a `stream-end` type in message events:
```typescript
if (parsed.type === "stream-end") {
  setStatus("done");
  es.close();
}
```

---

### ISSUE #3: Test File Location + Relative Import Pattern

**Location:** v1.5-04-01-PLAN.md, Task 1

**Problem:**
Plan specifies `import { GET } from './route'` at RED phase, but route file does NOT exist yet. TypeScript will fail at import time. Module-level mocks do not retroactively fix missing imports.

**Impact:** Test file won't parse in TypeScript strict mode.

**Fix:**
Create route.ts stub (empty `export {};`) FIRST before writing test imports, or use dynamic import inside tests:
```typescript
const { GET } = await import('./route');
```

---

## Medium Issues (Should Fix; Minor Test Failures)

### ISSUE #4: @testing-library/react Dependency Check Missing

**Location:** v1.5-04-02-PLAN.md, Task 2, Step C

**Problem:**
Plan says "verify dependency exists" but does NOT include the step to add it if missing.

**Fix:**
Add explicit dependency check:
```bash
if ! grep -q "@testing-library/react" apps/open-swe/package.json; then
  pnpm --filter open-swe add -D @testing-library/react
fi
```

---

### ISSUE #5: jsdom Configuration Not Verified

**Location:** v1.5-04-02-PLAN.md, Task 1, Step D

**Problem:**
Plan recommends per-file `// @vitest-environment jsdom` but does not verify jsdom is installed or available.

**Fix:**
Add verification step:
```bash
grep -q "jsdom" apps/open-swe/vitest.config.ts || \
  pnpm --filter open-swe add -D @vitest/environment-jsdom
```

---

### ISSUE #6: Language Inconsistency

**Location:** v1.5-04-02-PLAN.md, Task 2, Step A (ToolCard)

**Problem:**
Plan text says "input payload and output result" but code labels are "input" and "output". Minor but tests expect exact testid names.

**Fix:**
Clarify: "ToolCard displays expanded content in two sections: Input (tool.input as JSON) and Output (tool.output as JSON)."

---

## Minor Issues (Nice-to-Have)

### ISSUE #7: No Circular Reference Handling

**Location:** ToolCard component

**Problem:**
`JSON.stringify` will throw if `tool.output` contains circular references. Rare but possible with LLM tool returns.

**Fix (optional):**
Wrap in try-catch or use replacer function with cycle detection.

---

### ISSUE #8: Undefined Output Not Guarded

**Location:** ToolCard component

**Problem:**
If `tool.output` is undefined, `JSON.stringify` outputs the string `"undefined"`.

**Fix:**
Guard with `tool.output !== undefined` before rendering output section.

---

## Structural Assessment

### Plan Completeness

| Aspect | Status | Notes |
|--------|--------|-------|
| Test surface (5 files) | ✅ COMPLETE | All test names, locations specified |
| Route implementation | ✅ COMPLETE | Full handler code provided |
| Hook implementations | ✅ COMPLETE | Full useRunStream + useToolState source |
| Component implementation | ✅ COMPLETE | ToolCard + RunDetail page code |
| Types extension | ✅ COMPLETE | StreamEvent, ToolCallState, RunStreamStatus |
| Verify steps | ✅ PRESENT | Grep checks, test runs, typecheck |
| Success criteria | ✅ CLEAR | 5 measurable criteria per plan |

### Task Breakdown Quality

**v1.5-04-01:**
- Task 1 (RED stubs): 5 test files, well-scoped ✅
- Task 2 (route): 1 file, self-contained ✅
- Tasks can run in either order ✅

**v1.5-04-02:**
- Task 1 (hooks + types): 5 files, depends on v1.5-04-01 ✅
- Task 2 (components): 4 files, depends on Task 1 ✅
- Clean dependency chain ✅

---

## Validation Against Requirements

### DASH-03: Live Stream of Agent Output
- ✅ GET /api/open-swe/runs/[runId]/stream returns text/event-stream
- ✅ useRunStream hook consumes EventSource
- ✅ RunDetail page displays streamed text progressively
- ⚠️ Hydration mismatch needs fix (ISSUE #1)

### DASH-04: Expandable Tool Cards
- ✅ ToolCard component has pending/completed states
- ✅ Expand button appears only on completed
- ✅ Full input + output JSON displayed (not truncated)
- ✅ Tests specify expand/collapse behavior

### DASH-05: Stream Isolation per runId
- ✅ No module-level EventSource storage
- ✅ Each hook instance creates own EventSource
- ✅ URL includes runId in path
- ✅ Test case included: "stream isolation: runId from params is included in upstream URL"

---

## Recommendations (Structured JSON)

```json
{
  "vote": "APPROVE",
  "confidence": "HIGH",
  "critical_fixes": [
    {
      "id": "ISSUE-1",
      "title": "RunDetail Page Hydration Mismatch",
      "impact": "Production deployment will fail with hydration errors",
      "fix": "Replace window.location.search with useSearchParams() from 'next/navigation'",
      "effort": "5 min",
      "blocking": true
    },
    {
      "id": "ISSUE-3",
      "title": "Route Import at RED Phase",
      "impact": "Test file won't parse in TypeScript strict mode",
      "fix": "Create route.ts stub file before writing tests, or use dynamic import()",
      "effort": "2 min",
      "blocking": true
    },
    {
      "id": "ISSUE-2",
      "title": "EventSource 'done' Event Not Standard",
      "impact": "Status never transitions to 'done'; stream end detection unclear",
      "fix": "Check LangGraph Platform event format; listen for stream-end marker or custom event",
      "effort": "10 min (includes research)",
      "blocking": true
    }
  ],
  "medium_fixes": [
    {
      "id": "ISSUE-4",
      "title": "Missing @testing-library/react Dependency",
      "fix": "Add pnpm add -D step if library not found",
      "effort": "2 min",
      "blocking": false
    },
    {
      "id": "ISSUE-5",
      "title": "jsdom Not Verified",
      "fix": "Add grep check in vitest.config.ts or install @vitest/environment-jsdom",
      "effort": "3 min",
      "blocking": false
    },
    {
      "id": "ISSUE-6",
      "title": "Language Inconsistency",
      "fix": "Clarify plan text: 'Input and Output sections' vs just 'input/output'",
      "effort": "1 min",
      "blocking": false
    }
  ],
  "minor_improvements": [
    {
      "id": "ISSUE-7",
      "title": "No Circular Reference Handling",
      "fix": "Add cycle detection to JSON.stringify or wrap in try-catch",
      "effort": "3 min",
      "blocking": false
    },
    {
      "id": "ISSUE-8",
      "title": "Undefined Output Not Guarded",
      "fix": "Check output !== undefined before rendering",
      "effort": "2 min",
      "blocking": false
    }
  ],
  "architecture_strengths": [
    "Minimal stateless SSE route (correct pattern)",
    "Per-component EventSource isolation (solves DASH-05 correctly)",
    "Map-keyed-by-toolCallId avoids cross-run leakage",
    "Full JSON payloads displayed (no truncation per DASH-04)",
    "Relative imports throughout (no @/ aliases; matches constraint)",
    "Wave 0 RED stub pattern matches v1.5-03 precedent",
    "Clear task breakdown with measurable success criteria"
  ],
  "execution_readiness": {
    "overall": "READY WITH FIXES",
    "estimated_duration": "8-12 min per plan with fixes applied",
    "blocking_issues": 3,
    "test_pass_likelihood": "95% if all fixes applied, 60% without"
  }
}
```

---

## Final Assessment

**APPROVE EXECUTION** with the three critical fixes applied first:

1. **Hydration mismatch:** Swap `window.location.search` for `useSearchParams()` in RunDetail page (~5 min)
2. **EventSource 'done' event:** Verify LangGraph Platform event format; add stream-end marker detection (~10 min)
3. **Route import:** Create route.ts stub file before writing test imports (~2 min)

Total fix time: ~15-17 min. These fixes prevent ~80% of likely execution failures. Plans are otherwise sound, well-structured, and correctly implement all five requirements.

**Post-Execution Recommendation:**
After Plan 02 completes successfully, add a quick v1.5-04-03 plan to:
- Add circular reference safety in ToolCard (try-catch JSON.stringify)
- Add output !== undefined guard in ToolCard
- Verify hydration in production-like build
- Manual test: open two run pages simultaneously and validate stream isolation (DASH-05)

---

## Key Strengths Affirmed

1. **SSE Route (DASH-03):** Minimal, correct implementation. Validates inputs, returns proper status codes, passes body through unchanged.
2. **Hooks (DASH-03, DASH-04):** Per-component EventSource isolation, clean Map-based tool call tracking, immutable state updates.
3. **Components (DASH-04):** Pending/completed states, expand-only-on-completed, full JSON payloads (no truncation).
4. **Stream Isolation (DASH-05):** No global state, per-instance EventSource, URL includes runId.
5. **Test Pattern:** Matches v1.5-03 precedent (module-level mocks, relative imports, Wave 0 RED stubs → Wave 2 GREEN).
6. **Documentation:** Clear task breakdown, success criteria, verification steps, key decision rationale.

---

## Red Flags (None Critical)

- No explicit error recovery beyond EventSource auto-retry ✅ (acceptable; LangGraph Platform handles)
- No analytics/logging for stream events ✅ (out of scope for v1.5-04)
- threadId as query param (not ideal UX; acceptable for v1.5-04, v1.5-05 will refactor to prop-based)

---

END OF REVIEW
