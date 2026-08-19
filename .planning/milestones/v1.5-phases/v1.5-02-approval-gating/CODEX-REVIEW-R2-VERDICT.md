# CODEX-1 Round 2 Quorum Verdict: Phase v1.5-02 Revised Plans

**Review Date:** 2026-05-04
**Slot:** codex-1 (Round 2)
**Mode:** Verification of Round 1 fixes
**Verdict Requested:** APPROVE or BLOCK

---

## Executive Summary

The revised plans have successfully incorporated all 4 critical fixes from the Round 1 CODEX review. Each issue identified in Round 1 has been comprehensively addressed with explicit QUORUM markers and detailed implementation guidance. **The plans are now correct and ready for execution.**

---

## Quorum Fix Verification

### QUORUM-1: Race Condition — cleanupApproval() NOT called in POST handler

**Round 1 Finding:** Plan 03 POST handler called `cleanupApproval()` immediately after `resolveApproval()`, creating a race where buffered frames were lost before the SSE transform could drain them.

**Round 2 Fix Status:** ✅ **FIXED**

**Evidence:**
```typescript
// From Plan 03 POST handler:
resolveApproval(approvalId, decision as "approve" | "reject");
// [QUORUM-1] CRITICAL: Do NOT call cleanupApproval(approvalId) here.
// Cleanup is the transform's responsibility (after drain),
// and the handler finally block's cleanupExpiredApprovals() handles eventual GC.
return NextResponse.json({ id: approvalId, decision, accepted: true });
```

**Key Changes:**
- ❌ Removed: `cleanupApproval(approvalId)` call from POST handler
- ✅ Added: Explicit [QUORUM-1] marker with detailed race explanation (lines 157-167)
- ✅ Added: Note that `cleanupApproval` is intentionally NOT imported in approval-routes.ts
- ✅ Added: Clarification that cleanup happens via transform (after drain) and handler finally block (lazy TTL)

**Verification:** Grep search confirms `cleanupApproval` does NOT appear in POST handler body. The transform handles cleanup after drain; periodic `cleanupExpiredApprovals()` in handler finally block handles eventual GC.

**Verdict:** ✅ **CORRECTLY FIXED**

---

### QUORUM-2: Global Pause Flag — Text-Delta Frames Buffered

**Round 1 Finding:** Transform only gated tool-keyed frames (via toolCallId matching). Text frames (which have no toolCallId) passed through unchanged while tool approval was pending, violating the ROADMAP "no further tool **or text frames**" criterion.

**Round 2 Fix Status:** ✅ **FIXED**

**Evidence:**
```typescript
// From Plan 02 Transform Logic, Step 4:
// [QUORUM-2] Global pause flag — ALL frames buffered during pending approval
if (pendingApprovalsByToolCallId.size > 0) (stream is globally paused):
  - For frames with NO toolCallId or with a toolCallId NOT in pendingApprovalsByToolCallId
    (e.g., text-delta frames), push to globalBufferedFrames; return null.

// Closure state includes:
globalBufferedFrames: SseFrame[]   // [QUORUM-2] frames buffered during global pause
```

**Key Changes:**
- ✅ Added: Explicit global pause check BEFORE per-toolCallId logic (Step 4 in transform)
- ✅ Added: `globalBufferedFrames` closure state to buffer non-tool frames
- ✅ Added: Logic to push text-delta and other frames to `globalBufferedFrames` when ANY approval pending
- ✅ Added: Drain logic that restores globalBufferedFrames to readyQueue after approval resolves
- ✅ Added: Step 1e explicitly moves "approval.bufferedFrames + globalBufferedFrames to readyQueue"

**Verification:** Plan documents `pendingApprovalsByToolCallId.size > 0` check before per-toolCallId logic. Text-delta frames are explicitly mentioned as examples of frames that must be buffered. Step 4 executes before JSON.parse, so frame type (text-delta) is detected before processing.

**Verdict:** ✅ **CORRECTLY FIXED**

---

### QUORUM-3: Rejection Emits data-error Terminal Frame

**Round 1 Finding:** Transform detected rejection status but returned `null` (discarding the frame), emitting no signal to client. ROADMAP criterion 3 requires "a terminal frame is emitted" on rejection.

**Round 2 Fix Status:** ✅ **FIXED**

**Evidence:**
```typescript
// From Plan 02 Transform Logic, Step 6f:
// [QUORUM-3] Rejection emits data-error frame — NOT null:
f. If approval.status === "rejected":
   - pendingApprovalsByToolCallId.delete(toolCallId)
   - Re-add globalBufferedFrames to readyQueue (unrelated frames should still be sent)
   - return { raw: `data: ${JSON.stringify({ 
       type: "data-error", 
       data: { 
         code: "approval_rejected", 
         message: "Tool execution was rejected" 
       } 
     })}` }
   - (Do NOT call cleanupApproval here — let cleanupExpiredApprovals() handle GC)
```

**Key Changes:**
- ✅ Changed: Returns explicit `data-error` frame (NOT null) when status === "rejected"
- ✅ Added: Frame payload with `code: "approval_rejected"` and descriptive message
- ✅ Added: Logic to clear toolCallId entry from `pendingApprovalsByToolCallId` before returning frame
- ✅ Added: Logic to re-add globalBufferedFrames to readyQueue so unrelated frames still send
- ✅ Added: [QUORUM-3] marker with explicit "NOT null" note
- ✅ Added: Timeout case (step 6g) also returns `data-error` frame with code "approval_timeout"

**Verification:** Plan explicitly documents `return { raw: data-error frame }` in step 6f. Frame is not null. Client receives terminal signal on rejection.

**Verdict:** ✅ **CORRECTLY FIXED**

---

### QUORUM-4: Cleanup-After-Drain + Stale Approved GC

**Round 1 Finding (Part A):** Transform did not clean up registry entries after draining buffered frames. Plan mentioned "transform calls cleanupApproval after drain" but implementation was unclear.

**Round 1 Finding (Part B):** `cleanupExpiredApprovals()` skipped "approved" status entries to avoid race, but this creates memory leak of stale entries if drain is interrupted.

**Round 2 Fix Status:** ✅ **FIXED (Both Parts)**

**Part A — Cleanup-After-Drain:**

**Evidence:**
```typescript
// From Plan 02 Task 2, Step 1b:
// [QUORUM-4] Cleanup after drain — call cleanupApproval from transform:
// Track drain completion by counting how many buffered frames remain.
// When the readyQueue becomes empty (last buffered frame was just returned),
// call cleanupApproval(approvalId) and delete from pendingApprovalsByToolCallId.

// Closure state:
let drainingApprovalId: string | null = null;
let remainingDrainCount = 0;

// At step 1a, BEFORE shift:
if (readyQueue.length > 0) {
  const frame = readyQueue.shift()!;
  remainingDrainCount--;
  if (remainingDrainCount === 0 && drainingApprovalId !== null) {
    cleanupApproval(drainingApprovalId);
    drainingApprovalId = null;
  }
  return frame;
}

// Step 1e (approval approved):
- Set drainingApprovalId = approvalId; remainingDrainCount = readyQueue.length
- [QUORUM-4] If readyQueue.length === 0: call cleanupApproval(approvalId) immediately
- Else cleanupApproval will be called after last drain (step 1b)
```

**Key Changes (Part A):**
- ✅ Added: Explicit drain tracking via `drainingApprovalId` and `remainingDrainCount` variables
- ✅ Added: Logic in step 1 to decrement counter and call `cleanupApproval()` when counter reaches 0
- ✅ Added: Special case for immediate cleanup if readyQueue is empty (no buffered frames)
- ✅ Added: [QUORUM-4] marker explicitly labeling cleanup-after-drain logic
- ✅ Added: Detailed comment explaining that drain completes safely before cleanup

**Part B — Stale Approved Entries GC:**

**Evidence:**
```typescript
// From Plan 02 Task 1:
// [QUORUM-4] CRITICAL — cleanupExpiredApprovals must also GC stale "approved" entries:
export function cleanupExpiredApprovals(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, approval] of registry) {
    if (approval.expiresAt < now) {
      // Remove ALL expired entries regardless of status (approved entries
      // are safe to remove here because the transform cleans up immediately
      // after drain via cleanupApproval(); any remaining approved entry
      // past TTL is an abandoned drain that will never complete)
      registry.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
```

**Key Changes (Part B):**
- ✅ Changed: No longer skips `status === "approved"` entries
- ✅ Changed: Removes **ALL** expired entries regardless of status
- ✅ Added: Explicit comment explaining why stale "approved" entries are now safe to remove
- ✅ Added: Note that if an "approved" entry is past TTL, the drain was interrupted/abandoned
- ✅ Added: [QUORUM-4] marker with detailed justification

**Verification:** Plan documents drain tracking mechanism (drainingApprovalId, remainingDrainCount). Plan explicitly removes all expired entries including "approved" status. Comment justifies the removal: drain completes immediately after drain, so any remaining approved entry past TTL is abandoned.

**Verdict:** ✅ **CORRECTLY FIXED (Both Parts)**

---

## Must_Haves Strength Verification

**Question:** Are the 4 must_haves truths still as strong as ROADMAP success criteria?

**Finding:** ✅ **YES — UNCHANGED AND EQUIVALENT**

All three plans (01, 02, 03) state **identical must_haves truths**:

1. "When approval gating is enabled on the handler, the client receives a `data-approval-required` frame containing the pending tool call details before the tool executes"
2. "The run remains paused — no further tool or text frames are emitted — until the handler receives an explicit approval or rejection POST from the client"
3. "When the client sends a rejection, the run is cancelled and a terminal frame is emitted; no further tool execution occurs"
4. "When approval gating is disabled (default), the adapter behaves identically to the non-gating path — no `data-approval-required` frames are emitted"

These are **word-for-word copies** of the ROADMAP success criteria (verified in Round 1). They remain **equally strong** because:
- **QUORUM-2 fix** (global pause flag) strengthens Must_Have 2 ("no further tool **or text** frames")
- **QUORUM-3 fix** (data-error on rejection) strengthens Must_Have 3 ("a terminal frame is emitted")
- **QUORUM-4 fixes** (cleanup-after-drain + stale approved GC) ensure the cleanup lifecycle is sound

**Verdict:** ✅ **MUST_HAVES REMAIN STRONG**

---

## Summary Table

| Quorum Issue | R1 Status | R2 Fix | Evidence | Verdict |
|-------------|-----------|-------|----------|---------|
| QUORUM-1: Race condition | ❌ FAIL | ✅ cleanupApproval removed from POST | Line 157-167 Plan 03 | ✅ FIXED |
| QUORUM-2: Text frames not gated | ❌ FAIL | ✅ globalBufferedFrames + size check | Plan 02 Step 4 | ✅ FIXED |
| QUORUM-3: No terminal frame | ❌ FAIL | ✅ Returns data-error on rejection | Plan 02 Step 6f | ✅ FIXED |
| QUORUM-4a: No cleanup after drain | ❌ FAIL | ✅ drainingApprovalId tracking | Plan 02 Step 1b, 1e | ✅ FIXED |
| QUORUM-4b: Stale approved not GC'd | ❌ FAIL | ✅ Remove all expired regardless | Plan 02 Task 1 | ✅ FIXED |
| Must_Haves strength | ✅ EQUIV | ✅ Unchanged & strong | All plans consistent | ✅ STRONG |

---

## Detailed Answers to Review Questions

### (1) Is the race condition fixed — Plan 03 Task 1 POST handler NO LONGER calls cleanupApproval()?

**Answer:** ✅ **YES**

`cleanupApproval()` is completely removed from the POST handler. Instead:
- POST handler calls `resolveApproval()` only
- Transform calls `cleanupApproval()` after drain completes (tracked via `remainingDrainCount`)
- Handler finally block calls `cleanupExpiredApprovals()` for lazy cleanup of abandoned entries

This eliminates the race where buffered frames are lost to premature deletion.

### (2) Does Plan 02 Task 2 now gate text-delta frames via a global pause flag (pendingApprovalsByToolCallId.size > 0)?

**Answer:** ✅ **YES**

Transform step 4 explicitly checks `if (pendingApprovalsByToolCallId.size > 0)` and buffers **all frames** (text-delta, text, etc.) to `globalBufferedFrames` when any tool approval is pending. These frames are drained after all pending approvals resolve.

### (3) Does Plan 02 Task 2 step 6f now emit a data-error frame on rejection instead of returning null?

**Answer:** ✅ **YES**

Step 6f returns explicit `data-error` frame:
```
return { raw: `data: ${JSON.stringify({ type: "data-error", data: { code: "approval_rejected", ... } })}` }
```

Not null. Client receives terminal signal on rejection.

### (4) Does the transform now call cleanupApproval() after drain completes (cleanup-after-drain inside transform)?

**Answer:** ✅ **YES**

Transform closure tracks `drainingApprovalId` and `remainingDrainCount`. Step 1b decrements counter on each shift. When counter reaches 0, calls `cleanupApproval(drainingApprovalId)`. Step 1e initializes tracking when drain starts.

### (5) Does cleanupExpiredApprovals() now also GC stale approved entries?

**Answer:** ✅ **YES**

Function implementation removes **all** entries where `expiresAt < now` regardless of status, including "approved". Comment justifies: transform cleans up immediately after drain, so any remaining "approved" entry past TTL is abandoned.

---

## Phase Goal Achievement

**Phase v1.5-02 Goal:** "Implement approval gating to pause SSE streams awaiting human approval, allowing explicit unblock or rejection with proper cleanup, without memory leaks or race conditions."

**Assessment:** ✅ **CORRECTLY ADDRESSES PHASE GOAL**

- **Pause mechanism:** ✅ Global pause flag + buffering (QUORUM-2, Step 4)
- **Approval/Rejection handling:** ✅ Transform detects status + emits terminal frame (QUORUM-3, Step 6f)
- **Buffering:** ✅ All frame types buffered during pending (QUORUM-2)
- **Draining:** ✅ Frames drained after approval, unrelated frames preserved (Step 1e, 6f)
- **Memory safety:** ✅ Cleanup after drain + lazy TTL cleanup (QUORUM-4a, 4b)
- **Race safety:** ✅ No premature cleanup; transform responsible for drain+cleanup (QUORUM-1)

---

## Recommendation

**VERDICT: APPROVE ✅**

The revised plans comprehensively address all 4 issues from the Round 1 CODEX review. Each fix is:
- ✅ Explicitly documented with [QUORUM-N] markers
- ✅ Implemented correctly in the plan pseudocode
- ✅ Cross-verified (global pause flag, data-error frame, cleanup tracking, stale GC)
- ✅ Justified with detailed comments explaining the race/memory safety

**The phase goal is correctly addressed. All 4 must_haves remain strong. The 3-plan TDD wave (RED→GREEN→exports) is complete and ready for execution.**

**Next Step:** Execute Plan 01 (RED tests), then Plan 02 (GREEN implementation), then Plan 03 (API exports).

---

**Review Completed:** 2026-05-04
**Confidence Level:** HIGH
**Artifacts Reviewed:** v1.5-02-01-PLAN.md, v1.5-02-02-PLAN.md, v1.5-02-03-PLAN.md (revised)
