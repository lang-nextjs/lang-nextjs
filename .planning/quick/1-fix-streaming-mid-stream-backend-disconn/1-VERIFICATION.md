---
phase: quick-1-fix-streaming-mid-stream-backend-disconn
verified: 2026-05-17T22:12:00Z
status: passed
score: 5/5 must-haves verified
---

# Quick Task 1: Fix Streaming Mid-Stream Backend Disconnect Verification Report

**Task Goal:** Fix streaming mid-stream backend disconnect (GitHub issue #4) — detect upstream
disconnect during the `reader.read()` loop in `packages/server/src/handler.ts`, emit a parseable
in-band SSE error event to the client before closing the stream, and clean up the AbortController
and registered streams. Clean finishes must NOT regress.

**Verified:** 2026-05-17T22:12:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                  | Status     | Evidence                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mid-stream backend disconnect delivers a parseable SSE error event before stream close (not a silent truncation). | ✓ VERIFIED | Both disconnect paths in `handler.ts` enqueue `buildErrorFrame(...)` (`data: {"type":"data-error","data":{"code":"upstream_disconnect","message":"..."}}\n\n`) then `controller.close()`. Tests "emits an SSE error event ... THROWS mid-stream" and "... WITHOUT a terminal frame (premature done)" both pass. |
| 2   | When `reader.read()` throws mid-stream, the handler enqueues an SSE error frame before propagating.    | ✓ VERIFIED | `catch (err)` block (handler.ts:399-421): logs via `console.error`, then `controller.enqueue(buildErrorFrame(...))` guarded by try/catch, then `controller.close()` (switched from `controller.error(err)`). Test 1 of the issue-#4 block asserts `"type":"data-error"` present. |
| 3   | On mid-stream failure the stream-registry entry for the resumeId is marked done (unlocked).            | ✓ VERIFIED | `finally` block (handler.ts:422-432) calls `markStreamDone(resumeId)` guarded by `resumeId && isStreamReconnectEnabled()` on every exit path. Test "marks the stream-registry entry done on mid-stream failure" asserts `mockMarkStreamDone` called with `"res-disconnect"`; pre-existing SRV "markStreamDone IS called in finally" also green. |
| 4   | The AbortController is aborted on mid-stream failure so the upstream fetch connection is released.     | ✓ VERIFIED | `const abortController = new AbortController()` (handler.ts:284); `signal: abortController.signal` threaded into the upstream fetch init (handler.ts:293); `abortController.abort()` is the FIRST statement in `finally` (handler.ts:425), running on clean finish, truncation, and thrown-error paths. |
| 5   | A clean stream finish (terminal frame + normal close) still closes without an error event — no regression. | ✓ VERIFIED | `sawTerminalFrame` tracking + `isTerminalFrame()` gate the truncation error frame; truncation frame is only enqueued when `!sawTerminalFrame`. Test "does NOT emit an error event on a clean finish" asserts output does NOT contain `"type":"data-error"`. Full suite green (244/244), no pre-existing test regressed. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact                                  | Expected                                                                                       | Status     | Details                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/handler.ts`          | Mid-stream disconnect detection, SSE error event emission, AbortController + registry cleanup; `contains: "AbortController"` | ✓ VERIFIED | 442 lines. `grep "AbortController"` → 3 matches (created at :284, comment :281/:424). `isTerminalFrame()` (:137) + `buildErrorFrame()` (:159) helpers added. Modified in commit `4b84fc8`. |
| `packages/server/src/handler.test.ts`     | Failing-then-passing tests reproducing mid-stream disconnect (truncated stream + thrown read); `contains: "mid-stream"` | ✓ VERIFIED | New `describe("mid-stream backend disconnect (issue #4)")` block with 4 tests (thrown read, premature-done truncation, clean-finish no-regression, registry cleanup). `grep -c "mid-stream"` → 16. Added in commit `94a80fd`, narrowed assertion in `4b84fc8`. |

### Key Link Verification

| From                            | To                                          | Via                                                              | Status   | Details                                                                                                                                                       |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/handler.ts` | client SSE stream                          | `controller.enqueue` of an error frame before `controller.close` (pattern `controller\.enqueue.*error`) | ✓ WIRED  | `controller.enqueue(buildErrorFrame(...))` at handler.ts:370-377 (truncation path) and :406-413 (thrown path). `buildErrorFrame` emits `data: {"type":"data-error",...}` — `data-error` satisfies the `.*error` pattern. |
| `packages/server/src/handler.ts` | `packages/server/src/stream-registry.ts`   | `markStreamDone` in `finally` on the error path                  | ✓ WIRED  | `markStreamDone` imported (:20), called in `finally` (:427) guarded by `resumeId && isStreamReconnectEnabled()`. Runs on the error path — confirmed by test.   |
| `packages/server/src/handler.ts` | upstream fetch                              | AbortController signal passed to fetch, aborted on mid-stream failure (pattern `signal:\s*\w*[Cc]ontroller`) | ✓ WIRED  | `signal: abortController.signal` (:293) inside the `fetchWithRetry` init object; `abortController.abort()` in `finally` (:425). Pattern matches at :293.        |

### Requirements Coverage

| Requirement | Source Plan | Description                                                                 | Status      | Evidence                                                                                                  |
| ----------- | ----------- | --------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| INTENT-01   | 1-PLAN.md   | Fix GitHub issue #4 — mid-stream backend disconnect surfaces a parseable in-band error event with cleanup. | ✓ SATISFIED | All 5 must-have truths verified; 4 new issue-#4 tests pass; full server suite 244/244 green; `tsc` clean. |

### Anti-Patterns Found

| File         | Line | Pattern | Severity | Impact |
| ------------ | ---- | ------- | -------- | ------ |
| _none_       | —    | —       | —        | No TODO/FIXME/placeholder/stub patterns in the modified code. The two `catch {}` empty blocks (handler.ts:378-380, :414-416, :419-421) are deliberate, documented guards — a disconnected client makes `controller.enqueue/close` throw `Invalid state`; swallowing that prevents masking the original failure. Not a stub. |

### Formal Verification

Omitted — the plan declared `formal_artifacts: none` and no formal modules matched. This is a
localized bug fix in a Next.js monorepo with no formal tooling; no formal model checking was run.

### Anti-Regression Notes

- Pre-existing SRV-06 test ("calls controller.error() and logs on mid-stream ReadableStream error")
  still passes despite the `catch` switching from `controller.error(err)` to `enqueue + close` —
  the test only asserts `console.error` fired and tolerates a thrown OR clean drain.
- The summary documents 2 auto-fixed deviations: (1) `isTerminalFrame` checks the RAW backend
  frame, not the transformed frame, so a user `dropAll` transform is not mistaken for a disconnect;
  (2) the "frame drop" test assertion was narrowed from a blanket `not.toContain('"type"')` to
  specific dropped-content checks. Both are correctness fixes and are reflected in the passing suite.
- Documented frame-shape deviation: the executor adopted the existing codebase convention
  `data: {"type":"data-error","data":{"code":...,"message":...}}` (from `adapters/approvalGating.ts`)
  instead of the plan's proposed `{"type":"error","errorText":...}`. Verified that the RED tests
  and the implementation both use `data-error` consistently, the frame remains a parseable SSE
  `data:` line satisfying the truths, and the `controller\.enqueue.*error` key-link pattern still
  matches (`data-error` contains `error`).

### Verification Commands Run

- `vitest run` (packages/server) → **244/244 tests pass** across 15 files; `handler.test.ts` at 57 tests.
- `tsc --noEmit` (packages/server) → exit 0, no type errors.
- `grep` confirmations: `AbortController`, `signal: abortController.signal`, `abortController.abort()`,
  `markStreamDone`, `buildErrorFrame`, and `controller.enqueue` of the error frame all present in `handler.ts`;
  `mid-stream` present 16 times in `handler.test.ts`.
- Commits `94a80fd` (RED tests) and `4b84fc8` (GREEN fix) confirmed to exist with the expected file diffs.

### Gaps Summary

No gaps. All 5 must-have truths are VERIFIED, both artifacts exist and are substantive and wired,
all 3 key links are WIRED, the INTENT-01 requirement is SATISFIED, no blocker anti-patterns were
found, and the full server test suite plus typecheck are green. The phase goal — fixing GitHub
issue #4 — is achieved: a mid-stream upstream disconnect (both the thrown-`reader.read()` form and
the premature-`done`-without-terminal-frame truncation form) now emits a parseable in-band SSE
error event before the stream closes, the AbortController is aborted to release the upstream
socket, the stream-registry entry is unlocked via `markStreamDone`, and a clean finish still
closes with no error event (no regression).

---

_Verified: 2026-05-17T22:12:00Z_
_Verifier: Claude (nf-verifier)_
