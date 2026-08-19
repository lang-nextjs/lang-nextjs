# CCR-2: Implementation Plan Evaluation for v1.5-01-open-swe-adapter-foundation

**Evaluation Date**: 2026-05-04
**Plans Evaluated**: v1.5-01-01-PLAN.md, v1.5-01-02-PLAN.md, v1.5-01-03-PLAN.md
**Phase Goal**: Implement openSweAdapter with tool event mapping (ADAPT-01, 02), reorder buffer (ADAPT-04), and SSE heartbeat (ADAPT-03)

---

## EVALUATION: 5 CRITICAL QUESTIONS

### Q1: Multi-frame return from reorder buffer + SSE frame splitting compatibility

**QUESTION**: The plan specifies joining multiple buffered end frames with `\n\n` into a single SseFrame raw field. Is this compatible with how the downstream handler/accumulator splits and processes SSE frames?

**FINDING**: ✅ **CORRECT**

**Evidence**:
- accumulator.ts splits on `\n\n` via: `const parts = this.buffer.split('\n\n')`
- Multiple `\n\n`-separated chunks within a single frame.raw will be correctly split downstream
- Plan 02 task 1 explicitly documents: "joining with \n\n so the SSE writer emits them as separate frames. The handler splits on \n\n before writing"
- Example: `"data: frame1\n\ndata: frame2\n\n"` splits into `["data: frame1", "data: frame2", ""]` which correctly emits two frames

**Confidence**: HIGH

---

### Q2: Heartbeat timer lifecycle — risk of enqueue() after stream close

**QUESTION**: The heartbeat uses setTimeout inside ReadableStream start(). Is there a risk that the timer fires after the stream closes and controller.enqueue() throws?

**FINDING**: ⚠️ **MEDIUM RISK — PLAN MITIGATES CORRECTLY**

**Analysis**:
- **The risk is real**: After stream.close(), the controller is dead. Calling enqueue() throws with controller closed error.
- **Plan 03 mitigates correctly**:
  1. Line "if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);" in finally block ensures cleanup
  2. Line "try { controller.enqueue(...) } catch { // ignore }" wraps heartbeat emit in try-catch
  3. After stream close, the finally block clears the timer, preventing reschedule
- **However**: The catch block silently swallows ALL errors — this is acceptable for "controller closed" but could hide real bugs
- **Improvement**: Could be more explicit:
  ```ts
  } catch (e) {
    if (!(e instanceof TypeError && e.message.includes('closed'))) throw;
  }
  ```
  But the current approach is pragmatic and safe.

**Verdict**: Plan is SAFE but could be slightly more explicit about the expected error.

**Confidence**: HIGH

---

### Q3: Test coverage gaps — reorder buffer drain-on-flush scenario

**QUESTION**: Does the reorder buffer test cover the drain-on-flush scenario (multiple buffered ends released when head arrives)?

**FINDING**: ✅ **CORRECT AND EXPLICITLY COVERED**

**Evidence** from Plan 01 task 4:
```
- Send: on_tool_end for "tool_a"
  → result should emit tool_a end frame (emits in start order)
- After tool_a end emitted, buffer flush emits tool_b end frame
  (test the flush mechanism — may need to call a flush method or check the next call)
```

**Specific test coverage required**:
- Sends 2 on_tool_start events (tool_a, tool_b) → get toolCallId_a, toolCallId_b
- Sends on_tool_end for tool_b FIRST (reversed order) → expects null (buffered)
- Sends on_tool_end for tool_a → expects tool_a end PLUS tool_b end (flush)
- Tests the exact drain-on-flush condition

**Confidence**: HIGH — the test requirement is explicit and includes multi-frame flush

---

### Q4: ADAPT-03 separation — no circular dependencies between ADAPT-01/02/04 and ADAPT-03

**QUESTION**: Does plan 03 correctly separate ADAPT-03 from ADAPT-01/02/04? Are there circular dependencies?

**FINDING**: ✅ **CORRECTLY SEPARATED — NO CIRCULAR DEPENDENCIES**

**Architecture**:
- **ADAPT-01, 02, 04** (plans 01–02): Synchronous SseTransform pipeline
  - Files: openSwe.ts, openSwe.test.ts
  - Dependency: None except imports from accumulator.ts and deepagents.ts
  - State: Per-request closure in createOpenSweTransform()
  
- **ADAPT-03** (plan 03): Asynchronous ReadableStream wrapper
  - Files: openSweHeartbeat.ts, openSweHeartbeat.test.ts
  - Dependency: None except Web Stream APIs
  - State: Per-request closure in createHeartbeatStream()
  - Decoupled: Wraps UPSTREAM of SseFrameAccumulator, NOT inside SseTransform pipeline

**Dependency Graph**:
```
upstream ReadableStream
    ↓
createHeartbeatStream (ADAPT-03) ← optional wrapper
    ↓
createDeepAgentsHandler body input
    ↓
SseFrameAccumulator (splits on \n\n)
    ↓
SseTransform pipeline [openSweAdapter.transforms + user transforms]
    ↓
client SSE handler
```

**Key Separation**: 
- ADAPT-03 doesn't call openSweAdapter methods
- openSweAdapter doesn't know about heartbeat
- Both are exported from same package but used in different pipeline stages
- No circular imports

**Confidence**: HIGH

---

### Q5: tool_call_id counter reconstruction on on_tool_end

**QUESTION**: Are there missing edge cases around tool_call_id counter reconstruction on on_tool_end events?

**FINDING**: ⚠️ **CRITICAL EDGE CASE — PLAN HAS A SUBTLE BUG**

**The Issue**:
Plan 02 task 1 specifies:
```
case "on_tool_end":
  - Extract: toolName, run_id
  - Reconstruct toolCallId: look up counter for (run_id, toolName). The counter was already
    incremented on start, so the matching toolCallId uses count - 1.
    IMPORTANT: use a separate "completed counter" per (run_id, toolName) to track which
    invocation number this end event matches. Increment it after computing the ID.
```

**The Bug**: The plan uses a NESTED COUNTER STRUCTURE for start tracking but specifies
reconstructing on_tool_end with "count - 1" logic. This creates a mismatch:

**Scenario**: Two on_tool_start events for same (run_id, toolName):
1. First on_tool_start: counter[run_id][toolName] = 0, toolCallId = "run-1--bash-0", counter → 1
2. Second on_tool_start: counter[run_id][toolName] = 1, toolCallId = "run-1--bash-1", counter → 2
3. First on_tool_end arrives: tries to use counter[run_id][toolName] - 1 = (2 - 1) = 1
   - **BUG**: It reconstructs as "run-1--bash-1" but should be "run-1--bash-0" (the first call)

**Root Cause**: Plan uses a single counter per (run_id, toolName) for **all calls**, but
on_tool_end events don't arrive in order. The "count - 1" fallback only works if on_tool_end
events arrive in strict start-order, which violates the premise of ADAPT-04 (reorder buffer).

**Correct Approach** (from langchain.ts pattern):
- Counter tracks how many times tool has been started
- On on_tool_start: increment AFTER using current count
- On on_tool_end: reconstruct using a SEPARATE tracking mechanism:
  - Option A: Store (run_id, toolName, counter) tuple in startOrder queue, use it when end arrives
  - Option B: Use a "completed count" per (run_id, toolName) instead of "started count"
    - on_tool_start increments "startCount"
    - on_tool_end increments "completedCount" and uses it as the counter
    - Only works if ends arrive in order (but ADAPT-04 breaks this)
  - **Correct option**: A — embed the counter value in startOrder queue

**How langchain.ts Does It**:
```ts
const count = toolCallCounters.get(toolName) ?? 0;
const toolCallId = explicitId ?? `lc-${toolName}-${count}`;
if (explicitId === undefined) {
  toolCallCounters.set(toolName, count + 1);
}
```
This ONLY tracks starts, not ends. There's no on_tool_result mapping in langchain.ts.
But for open-swe, we MUST handle on_tool_end → tool-output-available, which requires
matching the counter from start.

**The Real Fix for Plan 02**:
In the reorder buffer logic, when pushing toolCallId to startOrder, also push the counter value:
```ts
startOrder: Array<{ toolCallId: string; counter: number; }>
// or simpler:
startOrderIds: string[] // just the IDs (already correct)
startOrderCounters: Map<toolCallId, number> // recover the counter

case "on_tool_end":
  // Reconstruct toolCallId: find it in the startOrderCounters map
  const counter = startOrderCounters.get(toolCallId);
  // This implicitly works because toolCallId was stored when start arrived
```

**Correction Status**: The plan RECOGNIZES the issue but the implementation guidance is incomplete.
The phrase "use a separate 'completed counter'" is vague about how to reconstruct.

**Recommendation**: 
1. Plan 02 task 1 should store the generated toolCallId in startOrder queue (not compute it on end)
2. on_tool_end simply looks up the matching toolCallId from startOrder[0]
3. This makes the counter reconstruction trivial (already done at start time)

**Confidence**: HIGH — this is a correctness bug that will manifest in tests

---

## SUMMARY TABLE

| Question | Status | Risk | Confidence |
|----------|--------|------|-----------|
| Q1: Frame joining + splitting | ✅ Correct | None | HIGH |
| Q2: Heartbeat timer lifecycle | ✅ Safe (mitigated) | LOW | HIGH |
| Q3: Reorder buffer test coverage | ✅ Covered | None | HIGH |
| Q4: ADAPT-03 separation | ✅ Correct | None | HIGH |
| Q5: tool_call_id counter reconstruction | ⚠️ Incomplete | **MEDIUM** | HIGH |

---

## RECOMMENDED FIXES

### Fix for Q5 — Plan 02, Task 1, on_tool_end reconstruction logic

**Change**: Modify the reorder buffer to track toolCallId directly instead of reconstructing from counter.

**Current (Problematic)**:
```ts
case "on_tool_end":
  const counter = toolCallCounters.get(toolName) ?? 0;  // ← BUG: uses current counter, not start counter
  const toolCallId = `${run_id}--${toolName}-${counter}`;
```

**Corrected**:
```ts
// At start of openSweTransform():
const toolCallIdByName = new Map<string, string>();
// ... store by "run_id::toolName::count" triple

case "on_tool_start":
  const key = `${run_id}::${toolName}::${count}`;
  const toolCallId = `${run_id}--${toolName}-${count}`;
  toolCallIdByName.set(key, toolCallId);  // ← Store the mapping
  startOrder.push(toolCallId);  // ← Push the GENERATED ID
  
case "on_tool_end":
  const key = `${run_id}::${toolName}::??`;  // ← Need the count!
  // SIMPLER: Just use startOrder.shift() to get the next expected toolCallId
  // Then look it up in endBuffer
  if (startOrder.length > 0 && endBuffer.has(startOrder[0])) {
    // Next buffered end is now ready
  }
```

**EVEN SIMPLER** (recommended):
Don't reconstruct at all — store the full (run_id, toolName) in a pending map, then
when on_tool_end arrives, look for a PENDING start with matching (run_id, toolName).
Use the counter from that pending entry.

```ts
const pendingStarts = new Map<string, { toolCallId: string; count: number }>();
// Key: `${run_id}::${toolName}`

case "on_tool_start":
  const key = `${run_id}::${toolName}`;
  const count = (toolCallCounters.get(key) ?? 0);
  const toolCallId = `${run_id}--${toolName}-${count}`;
  pendingStarts.set(key, { toolCallId, count });
  toolCallCounters.set(key, count + 1);
  startOrder.push(toolCallId);

case "on_tool_end":
  const key = `${run_id}::${toolName}`;
  const pending = pendingStarts.get(key);  // ← Lookup the pending start
  if (!pending) return null;  // Orphaned end event
  const { toolCallId } = pending;
  pendingStarts.delete(key);  // Remove from pending
  // ... reorder logic using toolCallId
```

This approach is simpler and doesn't require counter reconstruction at all.

---

## IMPROVEMENTS SECTION

### Plan 01 Improvements
- ✅ Test suite is comprehensive; no gaps identified
- ✅ RED phase is correctly designed

### Plan 02 Improvements

**Issue A: Counter reconstruction logic needs clarification**
- Current text: "use a separate 'completed counter'" is vague
- Recommend: Add explicit pseudo-code showing the startOrder/toolCallId storage mechanism

**Issue B: No mention of orphaned on_tool_end events**
- What if on_tool_end arrives WITHOUT a matching on_tool_start?
- Current plan has no error handling or passthrough rule
- Recommendation: Add test case for orphaned end events (should be dropped or passed through?)

**Example test case**:
```ts
it("on_tool_end without matching on_tool_start is dropped (orphaned event)", async () => {
  const orphanEnd = {
    event: "on_tool_end",
    name: "bash",
    run_id: "unknown-run",
    data: { output: "orphaned" }
  };
  const result = transform({ raw: `data: ${JSON.stringify(orphanEnd)}` });
  expect(result).toBeNull();
});
```

### Plan 03 Improvements

**Issue A: Heartbeat error handling could be more explicit**
- Current: `catch { }` swallows all errors
- Recommendation: Add a comment clarifying that "controller closed" is expected

**Issue B: No mention of timer cleanup on stream cancellation**
- If upstream cancels the readable stream, does the heartbeat timer leak?
- Plan correctly clears in finally block, but test should verify this
- Recommendation: Add test for stream.cancel() → verify timer is cleared

**Example test**:
```ts
it("cleans up heartbeat timer when stream is cancelled", async () => {
  const upstream = new ReadableStream(...);
  const heartbeat = createHeartbeatStream(upstream, { intervalMs: 30_000 });
  const reader = heartbeat.getReader();
  reader.cancel();  // Cancel the stream
  // Verify: no more heartbeats emitted, timer is cleared
  // (This is hard to test directly, but checking that no setTimeout remains is good)
});
```

### General Architecture Notes

**Strength**: The separation of concerns is excellent:
- SseTransform (synchronous, per-request state) handles event mapping + reorder
- ReadableStream wrapper (asynchronous, per-request state) handles heartbeat
- Both stateless at module scope, preventing inter-request contamination

**Potential Future Issue**: 
- If developers use openSweAdapter without createHeartbeatStream, they'll get connection
  timeouts on long-running tasks (>30s idle). Consider adding a note in openSwe.ts JSDoc
  recommending heartbeat usage, or making it automatic.

---

## FINAL VERDICT

**Overall Assessment**: ✅ **READY FOR EXECUTION WITH ONE CRITICAL FIX**

**Blockers**: 1 (Q5 — counter reconstruction logic)
**Warnings**: 1 (Q2 — heartbeat error handling could be more explicit)
**Improvements**: 2 (Plan 02 and 03 edge cases)

**Recommendation**: 
1. Before executing Plan 02, clarify the counter reconstruction approach (use the simpler
   "store toolCallId in startOrder" pattern or "pendingStarts lookup" pattern)
2. Add edge case test for orphaned on_tool_end events
3. Plan 03 is solid; just add a comment about expected "controller closed" error

The plans are well-structured and address the phase goals correctly. The critical fix in Q5
is non-trivial but straightforward to implement.

