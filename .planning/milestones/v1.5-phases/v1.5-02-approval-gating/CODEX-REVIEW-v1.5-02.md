# CODEX Review: Phase v1.5-02 (Approval Gating) Implementation Plan Analysis

**Review Date:** 2026-05-04
**Slot:** codex-1 (Round 1)
**Artifact Path:** .planning/phases/v1.5-02-approval-gating/v1.5-02-01-PLAN.md, v1.5-02-02-PLAN.md, v1.5-02-03-PLAN.md
**Review Context:** Pre-execution implementation plan evaluation
**Reviewer:** Claude Code (Haiku 4.5)

---

## Executive Summary

The Phase v1.5-02 implementation plan for approval gating addresses the core requirement to pause SSE streams pending human approval. However, the analysis reveals **3 critical correctness issues** that must be resolved before execution:

| Issue | Question | Severity | Status |
|-------|----------|----------|--------|
| Race condition on cleanup | Q3 | 🔴 CRITICAL | Must fix |
| Missing text frame gating | Q4 | 🔴 CRITICAL | Must fix |
| Missing rejection terminal frame | Q5 | 🟡 ISSUE | Must fix |

The plan's TDD wave structure (RED→GREEN→exports) and must_haves alignment are sound.

---

## Question 1: Must-Haves vs ROADMAP Success Criteria

**Question:** Are the 4 must_haves truths in each plan as strong as or stronger than the 4 ROADMAP success criteria?

**Finding:** ✓ **PASS** — The plan must_haves are **exact word-for-word copies** of the ROADMAP success criteria:

| Criterion | Plan 01 | Plan 02 | Plan 03 |
|-----------|---------|---------|---------|
| 1. Client receives `data-approval-required` frame | ✓ | ✓ | ✓ |
| 2. Run paused — no further tool or text frames | ✓ | ✓ | ✓ |
| 3. Rejection → terminal frame + cancel | ✓ | ✓ | ✓ |
| 4. Default disabled → no frames | ✓ | ✓ | ✓ |

**Verdict:** ✓ **EQUIVALENT STRENGTH** — The must_haves ensure traceability but provide no additional detail beyond ROADMAP specification. **Status: ACCEPTABLE**.

---

## Question 2: TDD RED→GREEN→Exports Wave Structure

**Question:** Does the 3-plan TDD RED→GREEN→exports wave structure fully implement ADAPT-05?

**Finding:** ✓ **PASS** — The wave structure is well-designed and comprehensive:

- **Plan 01 (RED)**: 33+ failing tests define contracts for approval-registry, approvalGating transform, and handler integration
- **Plan 02 (GREEN)**: Implements all 3 modules; wires into handler pipeline; makes all tests pass
- **Plan 03 (EXPORTS)**: Exposes API surface via index.ts; documents in README.md

**Coverage Analysis:**
| Requirement | Plan 01 | Plan 02 | Plan 03 | Complete? |
|-------------|---------|---------|---------|-----------|
| approval-registry (register, get, resolve, cleanup) | RED tests | GREEN impl | — | ✓ |
| approvalGating transform (gate+buffer+drain) | RED tests | GREEN impl | — | ✓ |
| handler option (approvalGating field) | RED tests | GREEN impl | — | ✓ |
| Approval routes (GET/POST handlers) | — | — | impl | ✓ |
| Server package exports | — | — | impl | ✓ |
| README documentation | — | — | doc | ✓ |

**Verdict:** ✓ **FULL IMPLEMENTATION** — All three plans together form a complete, testable implementation of ADAPT-05. **Status: ACCEPTABLE**.

---

## Question 3: Race Condition in Plan 03 POST Handler

**Question:** Is there a race condition in Plan 03 where `cleanupApproval()` is called immediately after `resolveApproval()` in the POST handler — before the SSE transform reads the status?

**Finding:** ⚠ **CRITICAL ISSUE** — YES, race condition exists.

**Evidence from Plan 03:**
```typescript
POST: async (request, context) => {
  // ... validation ...
  
  // Resolve: update status in registry (transform reads status on next call)
  resolveApproval(approvalId, decision as "approve" | "reject");
  cleanupApproval(approvalId);  // <-- IMMEDIATELY deletes entry
  
  return NextResponse.json({ id: approvalId, decision, accepted: true });
}
```

**Problem Analysis:**

1. `resolveApproval(approvalId, "approve")` sets `approval.status = "approved"` (entry remains in registry)
2. `cleanupApproval(approvalId)` **immediately deletes the entire registry entry**
3. SSE transform closure references `approval.bufferedFrames` which are still in memory
4. On next SSE frame call, transform executes:
   ```typescript
   approval = getApproval(approvalId)  // <-- Returns undefined (RACE LOST)
   if (approval === undefined) → return frame (safety: pass-through)
   ```
5. **Buffered frames are LOST** — discarded without draining

**Race Timeline:**
```
T0: SSE client POSTs /api/approval/[id] with decision="approve"
T1: cleanupApproval(id) deletes entry from registry
T2: SSE stream emits next frame (e.g., tool-output-available)
T3: transform calls getApproval(id) → undefined
T4: Buffered frames discarded instead of drained
T5: Client never receives tool output
```

**Impact:**
- Tool output frames buffered during approval are silently dropped
- Client UI hangs in "waiting for approval" state despite approval being sent
- User sees incomplete tool execution

**Recommended Fixes:**
- **Option A (Recommended):** Don't delete immediately. Use lazy cleanup via `cleanupExpiredApprovals()` after TTL expires
- **Option B:** Add 500ms grace period before cleanup to allow drain
- **Option C:** Don't cleanup in POST handler; let cleanup happen in handler's finally block via periodic `cleanupExpiredApprovals()`

**Verdict:** 🔴 **MUST FIX BEFORE EXECUTION** — Remove or defer `cleanupApproval()` call in Plan 03 POST handler.

---

## Question 4: Gating of Text Frames

**Question:** Does the plan cover gating of text frames (ROADMAP says "no further tool or text frames" during pause — the transform logic in Plan 02 only shows gating tool-input-start and toolCallId frames)?

**Finding:** ⚠ **CRITICAL ISSUE** — Text frames are NOT gated.

**Evidence from Plan 02 transform logic:**
```typescript
// Step 6: Extract toolCallId from parsed (check parsed.toolCallId):
if (toolCallId exists and pendingApprovalsByToolCallId.has(toolCallId)):
  a. approvalId = ...
  b. approval = getApproval(approvalId)
  c-f. [buffer/drain/reject/timeout logic]

// Step 7: Return frame (pass-through for non-tool frames)
```

**Problem Analysis:**

1. Step 6 gates frames that have a `toolCallId` matching a pending approval
2. Step 7 returns **all non-tool frames unchanged** (frames without `toolCallId`)
3. AI SDK `data-text` frames have **NO `toolCallId`** field
4. **Text frames pass through the transform unchanged** while tool is pending approval

**ROADMAP Criterion 2 Violation:**
> "The run remains paused — **no further tool or text frames** are emitted — until the handler receives an explicit approval or rejection POST from the client"

**Example Scenario:**
```
1. AI model: "I'll run bash_execute to check the status"
2. AI SDK emits: data-text frame "I'll run bash_execute..."
3. Approval gating receives tool-input-start for bash_execute
4. Transform buffers tool-input-start, emits data-approval-required
5. AI SDK emits: data-text frame "Executing command..."
6. **PROBLEM:** Text frame PASSES THROUGH (no toolCallId to match)
7. Client sees both text frames before approval
8. **Criterion violated** — text emitted before approval
```

**Recommended Fix:**
Track all frames (not just tool-keyed) when approval is pending. When `pendingApprovalsByToolCallId` is non-empty, buffer **all frames** until approval is resolved:

```typescript
// Pseudo-fix in transform step 2
if (pendingApprovalsByToolCallId.size > 0) {
  // At least one tool is pending — buffer all frames
  const pendingApprovalId = pendingApprovalsByToolCallId.values().next().value
  const approval = getApproval(pendingApprovalId)
  if (approval?.status === "waiting") {
    approval.bufferedFrames.push(frame)
    return null
  }
}
```

**Verdict:** 🔴 **MUST FIX BEFORE EXECUTION** — Extend Plan 02 transform to buffer all frames when any approval is pending.

---

## Question 5: Terminal Frame on Rejection

**Question:** On rejection: does the plan emit a terminal frame to the client (ROADMAP criterion 3 requires this)?

**Finding:** ⚠ **ISSUE** — Plan does not explicitly emit a terminal frame on rejection.

**Evidence from Plan 03 POST Handler:**
```typescript
POST: async (request, context) => {
  // ... validation ...
  
  if (approval.status !== "waiting") {
    return NextResponse.json(
      { error: "approval already resolved", status: approval.status },
      { status: 409 }
    );
  }

  resolveApproval(approvalId, decision as "approve" | "reject");
  cleanupApproval(approvalId);
  
  return NextResponse.json({ id: approvalId, decision, accepted: true });
  // <-- Only HTTP JSON response; no SSE frame
}
```

**Evidence from Plan 02 Transform Logic:**
```typescript
// Step 6f: If approval.status === "rejected" → return null (discard)
```

**Problem Analysis:**

1. POST handler returns `{ id, decision, accepted: true }` to HTTP request (not SSE)
2. Transform detects `approval.status === "rejected"` and returns `null` (discards frame)
3. **No explicit terminal frame is emitted to SSE stream**
4. Client receives no signal that rejection occurred

**ROADMAP Criterion 3 Violation:**
> "When the client sends a rejection, the run is cancelled and **a terminal frame is emitted**; no further tool execution occurs"

**Current Gap:**
```
1. Client POSTs rejection decision
2. Server responds with JSON: { decision: "reject", accepted: true }
3. SSE stream continues; no terminal frame emitted
4. Client doesn't know rejection was processed
5. Stream hangs or times out
```

**Expected Behavior:**
```
1. Client POSTs rejection
2. Server sets approval.status = "rejected"
3. Next SSE frame call to transform detects rejection
4. Transform emits terminal frame:
   data: {"type":"data-error","data":{"code":"approval_rejected","message":"Tool approval rejected"}}
5. Client receives terminal frame, closes stream
```

**Plan 02 Commentary Acknowledges the Gap:**
> "Note from RESEARCH.md: The research describes emitting a `data-error` terminal frame on rejection. However, emitting directly from the approval POST handler is complex (requires a reference to the stream controller). The cleaner approach: the transform detects "rejected" status and returns a `data-error` frame on the next tool frame for that toolCallId."

But the implementation code only returns `null`:
```typescript
f. If approval.status === "rejected" → return null (discard)
```

**Recommended Fix:**
Modify Plan 02 step 6f to emit terminal frame on first rejection detection:

```typescript
f. If approval.status === "rejected":
   // Track per-toolCallId to emit once
   if (!sentRejectionFrame.has(toolCallId)) {
     sentRejectionFrame.add(toolCallId)
     return { raw: `data: ${JSON.stringify({
       type: "data-error",
       data: {
         code: "approval_rejected",
         message: "Tool execution rejected by user"
       }
     })}` }
   }
   return null
```

**Verdict:** 🟡 **MUST FIX BEFORE EXECUTION** — Modify Plan 02 to emit `data-error` terminal frame when rejection is detected.

---

## Summary of Findings

| Question | Finding | Severity | Required Action |
|----------|---------|----------|-----------------|
| Q1: must_haves vs ROADMAP | ✓ Equivalent strength; word-for-word copies | — | None |
| Q2: TDD RED→GREEN→exports | ✓ Complete 3-plan wave | — | None |
| Q3: Race condition | ⚠ Race between cleanup and drain | 🔴 CRITICAL | Remove/defer `cleanupApproval()` in Plan 03 POST |
| Q4: Text frame gating | ⚠ Text frames not gated | 🔴 CRITICAL | Buffer all frames when approval pending |
| Q5: Terminal frame rejection | ⚠ No terminal frame emitted | 🟡 ISSUE | Emit `data-error` on rejection detection |

---

## Required Fixes (Pre-Execution)

### Fix 1: Race Condition — Defer Cleanup (Plan 03)

**Change in Plan 03 POST handler:**

Remove the immediate `cleanupApproval()` call:
```diff
- resolveApproval(approvalId, decision as "approve" | "reject");
- cleanupApproval(approvalId);
+ resolveApproval(approvalId, decision as "approve" | "reject");
  // Cleanup happens lazily via cleanupExpiredApprovals() in handler finally block
  return NextResponse.json({ id: approvalId, decision, accepted: true });
```

This ensures buffered frames can be drained before the registry entry is deleted.

---

### Fix 2: Text Frame Gating — Buffer All Frames (Plan 02)

**Change in Plan 02 transform step 2:**

Add check before step 5 to handle any pending approval:
```typescript
// NEW: Step 2a — Gate all frames when any approval is pending
if (pendingApprovalsByToolCallId.size > 0) {
  // At least one tool is pending approval — buffer all frames
  const pendingApprovalId = Array.from(pendingApprovalsByToolCallId.values())[0];
  const approval = getApproval(pendingApprovalId);
  if (approval?.status === "waiting") {
    // Buffer this frame (any type, not just tool-keyed)
    approval.bufferedFrames.push(frame);
    return null;
  }
  // If approval is resolved (approved/rejected), fall through to normal processing
}
```

This ensures text frames are also buffered during approval wait.

---

### Fix 3: Terminal Frame on Rejection — Emit Error Frame (Plan 02)

**Change in Plan 02 transform step 6f:**

Add explicit terminal frame emission:
```typescript
f. If approval.status === "rejected":
   // Emit terminal error frame once per toolCallId
   if (!rejectionFrameSent.has(toolCallId)) {
     rejectionFrameSent.add(toolCallId);
     return {
       raw: `data: ${JSON.stringify({
         type: "data-error",
         data: {
           code: "approval_rejected",
           message: "Tool execution rejected by user"
         }
       })}`
     };
   }
   // Subsequent frames for this toolCallId are discarded
   return null;
```

Add to closure state: `const rejectionFrameSent = new Set<string>();`

---

## Minor Improvements (Recommended)

1. **Plan 01:** Add explicit test case for rejection terminal frame emission (currently implicit)
2. **Plan 01:** Add test case for text frame buffering during approval wait
3. **Plan 03:** Document in README.md that rejection emits terminal frame
4. **Plan 02:** Document that cleanup is deferred, not immediate

---

## Verdict

**Status: CONDITIONAL APPROVAL** ✅

The Phase v1.5-02 implementation plan is **well-structured** with strong TDD discipline and clear separation of concerns. The three critical issues identified are **not design flaws** but rather **incomplete specification** in the plan's pseudocode.

**Approval Conditions:**
1. ✅ Fix race condition (Q3) — remove immediate cleanup
2. ✅ Fix text frame gating (Q4) — buffer all frames when approval pending
3. ✅ Fix terminal frame emission (Q5) — emit `data-error` on rejection

Once these three fixes are incorporated into Plans 02 and 03, the plan is **ready for RED phase execution**.

**Key Strengths:**
- Clear TDD wave structure (RED→GREEN→exports)
- Comprehensive must_haves alignment with ROADMAP
- Good separation between registry, transform, and routes
- Proper use of lazy TTL eviction pattern

**Time to Fix:** Approximately 30 minutes to update the three plan documents with the fixes above.

---

**Review Completed:** 2026-05-04T[timestamp]
**Confidence Level:** HIGH
**Artifacts Reviewed:** 3 plans (v1.5-02-01, v1.5-02-02, v1.5-02-03)
