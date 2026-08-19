---
phase: quick-1-fix-streaming-mid-stream-backend-disconn
plan: 1
subsystem: api
tags: [sse, streaming, abortcontroller, error-handling, nextjs, vitest]

# Dependency graph
requires:
  - phase: v1.3-03-stream-reconnection
    provides: stream-registry (markStreamDone) and reconnect (isStreamReconnectEnabled) used on the mid-stream error path
provides:
  - Mid-stream upstream-disconnect detection in createDeepAgentsHandler
  - In-band SSE data-error event emitted to the client before stream close
  - AbortController lifecycle for the upstream fetch (aborted on every exit path)
  - Terminal-frame tracking ({"type":"finish"} / [DONE]) to distinguish clean finish from truncation
affects: [handler, streaming, reconnection, error-channel]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "In-band SSE error frame uses the AI SDK data-error channel (data: {\"type\":\"data-error\",\"data\":{...}}) — same shape as adapters/approvalGating.ts"
    - "AbortController created per-request, aborted in the ReadableStream finally block on every exit path"
    - "Terminal-frame detection runs against the RAW backend frame (pre-transform), so user transforms dropping frames are never mistaken for an upstream disconnect"

key-files:
  created: []
  modified:
    - packages/server/src/handler.ts
    - packages/server/src/handler.test.ts

key-decisions:
  - "Adopted the data-error frame shape (codebase convention) instead of the plan's proposed {\"type\":\"error\",\"errorText\":\"...\"} — tests and implementation kept internally consistent"
  - "isTerminalFrame checks the RAW backend frame, not the transformed frame — a user transform dropping frames is a deliberate client choice, not a backend disconnect"
  - "catch block switches from controller.error(err) to enqueue(error frame) + controller.close() so the client can reliably read the final in-band event"

patterns-established:
  - "Mid-stream failure → enqueue parseable data-error frame, then controller.close() (never controller.error which kills the stream silently)"
  - "Guard every controller.enqueue/close on the error path with try/catch — a disconnected client must not mask the original failure"

requirements-completed: [INTENT-01]

# Metrics
duration: ~8min
completed: 2026-05-17
---

# Phase quick-1: Fix Streaming Mid-Stream Backend Disconnect Summary

**Mid-stream upstream disconnects (thrown read + premature truncation) now emit a parseable in-band `data-error` SSE event before the stream closes, with AbortController + stream-registry cleanup — instead of a silent UI freeze (issue #4).**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-17T22:03:00Z
- **Completed:** 2026-05-17T22:08:00Z
- **Tasks:** 2/2
- **Files modified:** 2

## Accomplishments

- Detects upstream disconnect in both forms: `reader.read()` throwing AND `reader.read()` returning `done` with no terminal frame ever observed (silent truncation).
- Emits a client-parseable in-band SSE error event (`data: {"type":"data-error","data":{"code":"upstream_disconnect","message":"..."}}`) BEFORE the stream is closed, so the AI SDK consumer sees a real error part rather than truncated output.
- Introduces an `AbortController`, threads its `signal` into the upstream `fetch`, and calls `abortController.abort()` in the `finally` block on every exit path (clean finish, truncation, thrown error) — releasing the upstream socket.
- Preserves `markStreamDone(resumeId)` cleanup on the error path so a crashed stream does not permanently 409-lock its `resumeId`.
- No regression: a clean finish (backend sends `{"type":"finish"}` then closes) still closes with no error event. Full server suite is green (244/244).

## Task Commits

Each task was committed atomically (TDD bug fix — RED then GREEN):

1. **Task 1: Write failing tests reproducing the mid-stream disconnect (RED)** - `94a80fd` (test)
2. **Task 2: Detect disconnect, emit SSE error event, clean up AbortController + registry (GREEN)** - `4b84fc8` (fix)

**Plan metadata:** see final docs commit.

## Files Created/Modified

- `packages/server/src/handler.ts` - Added `isTerminalFrame()` and `buildErrorFrame()` helpers; created an `AbortController` and passed `signal` to the upstream fetch; reworked the `ReadableStream` `start()` body to track terminal-frame observation, emit an in-band `data-error` event on truncation and on thrown reads, switch `catch` from `controller.error()` to `enqueue + controller.close()`, and `abort()` the controller in `finally`.
- `packages/server/src/handler.test.ts` - New `describe("mid-stream backend disconnect (issue #4)")` block with 4 tests (thrown read, premature-done truncation, clean-finish no-regression, registry-cleanup guard); narrowed one over-broad pre-existing assertion (see Deviations).

## Decisions Made

- **Error-frame shape (constraint #5 reconciliation):** The plan's Task 2(C) proposed `data: {"type":"error","errorText":"..."}`. The existing codebase convention (`adapters/approvalGating.ts`) emits in-band errors on the AI SDK custom data-part channel as `data: {"type":"data-error","data":{"code":"...","message":"..."}}`. Per the debug-context constraint #5 (codebase consistency strongly preferred, test + implementation must agree), the handler adopts the **`data-error`** shape. The RED tests (Task 1) were written to assert `"type":"data-error"` so test and implementation stay in lockstep. The frame remains a parseable `data: {...json...}` SSE line, satisfying the must_haves truth "parseable SSE error event."
- **Terminal-frame detection runs on the RAW frame, not the transformed frame:** The plan's Task 2(D) instructed checking the transformed frame "so it reflects what the client receives." That caused a regression (see Deviation 1) — a user transform that drops all frames would make the handler believe the backend truncated. Truncation is a property of *what the backend sent*, not *what survives the transform pipeline*, so `isTerminalFrame` is checked against the raw accumulator frame before transforms. This also honors debug-context constraint #6.
- **`catch` switches from `controller.error(err)` to `enqueue(errorFrame) + controller.close()`:** After `controller.error()` a ReadableStream cannot carry data; closing (not erroring) lets the client reliably read the final in-band error event. SRV-06 (which only asserts `console.error` fired and tolerates a thrown OR clean drain) stays green unchanged — verified.

## Formal Modeling

### Loop 2 Simulation
- **Status:** Skipped (tool unavailable)
- **Reason:** formal-coverage-intersect.cjs / formal-fix-loop.cjs not present in this repo (Next.js monorepo, no formal tooling)

The plan declares `formal_artifacts: none`. The pre-flight notice confirmed `bin/formal-coverage-intersect.cjs`, `bin/run-formal-verify.cjs`, and `bin/run-formal-check.cjs` are absent. Per the fail-open policy, the formal coverage auto-detection and Loop 2 pre-commit simulation gate were logged as WARNINGs and skipped before each atomic commit. No `.planning/formal/` files were touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Terminal-frame detection wrongly fired on transform-dropped frames**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** The plan's Task 2(D) said to set `sawTerminalFrame` from the *transformed* frame. With that wording, the pre-existing test "omits frames from the output stream when a transform returns null (frame drop)" — which uses a `dropAll` transform — never let any frame reach the terminal check, so the handler treated a cleanly-closed backend stream as a truncation and appended a `data-error` frame. That is incorrect: a user transform dropping frames is a deliberate client choice, not a backend disconnect.
- **Fix:** Changed `isTerminalFrame` to run against the RAW backend frame (from the accumulator, before `applyTransforms`). Truncation is now detected purely from what the backend sent. Consistent with debug-context constraint #6 ("the handler must track whether a terminal `finish` frame passed through the pipeline").
- **Files modified:** `packages/server/src/handler.ts`
- **Verification:** Full server suite green (244/244) after the change.
- **Committed in:** `4b84fc8` (Task 2 commit)

**2. [Rule 1 - Bug] Over-broad assertion in the frame-drop test conflicted with correct issue #4 behavior**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** The pre-existing test "omits frames from the output stream when a transform returns null" asserted `expect(output).not.toContain('"type"')`. Its real intent is "the dropped frame must not leak." But that test's mock backend sends `data: {"type":"text","text":"hi"}` and closes with **no `finish` frame** — which under issue #4 is, correctly, a truncation. The handler now appends a legitimate `data: {"type":"data-error",...}` frame, and the blanket `"type"` check caught that legitimate frame.
- **Fix:** Narrowed the assertion to check the *dropped frame's specific content* is absent (`not.toContain('"type":"text"')`, `not.toContain('"text":"hi"')`) instead of the blanket `"type"` substring. The test's original intent (dropped frames must not leak) is fully preserved; the assertion no longer encodes the pre-issue-#4 expectation that a backend may close without a terminal frame and produce zero output. (Analogous to the SRV-06 guidance in the debug context — update assertions that conflict with the new correct behavior.)
- **Files modified:** `packages/server/src/handler.test.ts`
- **Verification:** Full server suite green (244/244); the test still fails if a `dropAll` transform ever lets the dropped frame's content through.
- **Committed in:** `4b84fc8` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs, Rule 1).
**Impact on plan:** Both auto-fixes were necessary for correctness. Deviation 1 corrected a real bug in the plan's prescribed approach (transformed-frame detection); Deviation 2 reconciled an over-broad pre-existing assertion with the intended issue #4 behavior. No scope creep — out-of-scope items (client-side reconnection retry, backoff, non-SSE protocols) untouched.

## Issues Encountered

- TDD RED state confirmed exactly as planned: tests 1 (thrown read) and 2 (premature-done truncation) failed against the original handler with assertion errors about the missing `"type":"data-error"` frame; tests 3 (clean finish) and 4 (registry cleanup) passed already.
- After the first GREEN pass, one pre-existing test failed — see Deviation 1; root-caused and fixed inline within the same task.

## User Setup Required

None - no external service configuration required.

## Verification Results

- `pnpm exec vitest run` in `packages/server` — **244/244 tests pass** across 15 files (handler.test.ts now 57 tests, including the 4 new mid-stream-disconnect tests; SRV-06 and `markStreamDone IS called in finally` both still green).
- `pnpm exec tsc --noEmit` in `packages/server` — clean (exit 0).
- `grep -n "AbortController" src/handler.ts` — matches (created, aborted in finally).
- `grep -n "data-error" src/handler.ts` — matches (error frame builder).
- `grep -n "signal:" src/handler.ts` — matches (signal passed to upstream fetch).
- `grep -n "markStreamDone" src/handler.ts` — matches (still called on the error path).

## Self-Check: PASSED

- FOUND: `packages/server/src/handler.ts` (modified)
- FOUND: `packages/server/src/handler.test.ts` (modified)
- FOUND: commit `94a80fd` (Task 1, test)
- FOUND: commit `4b84fc8` (Task 2, fix)

## Next Phase Readiness

- Issue #4 is resolved: mid-stream backend disconnects now surface a parseable in-band error event with full resource cleanup.
- No blockers. The `data-error` channel is now the single in-band error shape across the handler and approvalGating adapter — future error paths should reuse `buildErrorFrame`.

---
*Phase: quick-1-fix-streaming-mid-stream-backend-disconn*
*Completed: 2026-05-17*
