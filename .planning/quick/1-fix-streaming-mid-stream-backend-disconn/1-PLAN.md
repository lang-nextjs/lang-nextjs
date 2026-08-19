---
phase: quick-1-fix-streaming-mid-stream-backend-disconn
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/server/src/handler.ts
  - packages/server/src/handler.test.ts
autonomous: true
requirements: [INTENT-01]
formal_artifacts: none
gap_closure: false

must_haves:
  truths:
    - "When the upstream backend disconnects mid-SSE-stream, the client receives a parseable SSE error event before the stream closes (not a silent truncation)."
    - "When reader.read() throws mid-stream, the handler enqueues an SSE error frame to the client before propagating the failure."
    - "On any mid-stream failure the stream-registry entry for the resumeId is marked done (unlocked) so the resumeId is not permanently 409-locked."
    - "The AbortController is aborted on mid-stream failure so the upstream fetch connection is released and does not leak."
    - "A clean stream finish (backend sends its terminal frame and closes normally) still closes without an error event — no regression."
  artifacts:
    - path: "packages/server/src/handler.ts"
      provides: "Mid-stream disconnect detection, SSE error event emission, AbortController + registry cleanup"
      contains: "AbortController"
    - path: "packages/server/src/handler.test.ts"
      provides: "Failing-then-passing tests reproducing mid-stream disconnect (truncated stream + thrown read)"
      contains: "mid-stream"
  key_links:
    - from: "packages/server/src/handler.ts"
      to: "client SSE stream"
      via: "controller.enqueue of an error frame before controller.error/close"
      pattern: "controller\\.enqueue.*error"
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/stream-registry.ts"
      via: "markStreamDone in finally on the error path"
      pattern: "markStreamDone"
    - from: "packages/server/src/handler.ts"
      to: "upstream fetch"
      via: "AbortController signal passed to fetch, aborted on mid-stream failure"
      pattern: "signal:\\s*\\w*[Cc]ontroller"
---

<objective>
Fix GitHub issue #4: when the upstream DeepAgents backend disconnects mid-SSE-stream,
`createDeepAgentsHandler` currently leaves the client hanging — it either closes the
stream cleanly (premature `reader.read()` `done`) or calls `controller.error()` which
aborts the ReadableStream without sending any in-band SSE event the client can parse.
Either way the UI shows truncated agent output with no error signal.

This plan makes the handler:
1. Detect upstream disconnect during the `reader.read()` loop (both the thrown-error
   case and the premature-`done` truncation case).
2. Emit a parseable SSE error event (`data: {"type":"error",...}\n\n`) to the client
   BEFORE the stream is closed.
3. Clean up resources on failure: abort the `AbortController` (releasing the upstream
   fetch connection) and mark the stream-registry entry `done` so the `resumeId` is
   not permanently 409-locked.

Purpose: Users get a clear, parseable error instead of a frozen UI on backend crashes.
Output: Updated `handler.ts` with disconnect detection + error emission + cleanup, and
`handler.test.ts` extended with tests reproducing the disconnect scenarios.

Out of scope (per scope contract): client-side reconnection retry logic, backend
auth changes, exponential backoff reconnection, non-SSE protocols.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

@packages/server/src/handler.ts
@packages/server/src/handler.test.ts
@packages/server/src/stream-registry.ts
@packages/server/src/accumulator.ts
@packages/server/src/reconnect.ts

# Key facts from reading the code:
# - handler.ts streaming loop lives inside `new ReadableStream({ async start(controller) {...} })`.
# - The loop: `while(true) { const {done,value} = await reader.read(); ... }`.
#   - `done === true` branch: flushes accumulator, `controller.close()`, `break`.
#   - `catch (err)`: `console.error("[deepagents/server] mid-stream error", err); controller.error(err)`.
#   - `finally`: calls `markStreamDone(resumeId)` (when reconnect enabled) and `cleanupExpiredApprovals()`.
# - There is currently NO AbortController — `fetch()` is called without a `signal`.
#   Issue #4 explicitly asks to "Clean up the AbortController" — so one must be introduced.
# - `controller.error(err)` aborts the ReadableStream; it does NOT send an SSE frame.
#   The client (AI SDK) sees a broken stream with no `{"type":"error"}` event.
# - A premature `done` (backend killed mid-stream, TCP closes) is indistinguishable
#   from a clean finish unless the handler tracks whether a terminal frame was seen.
# - Existing test patterns: `makeRequest()`, `makeFetchResponse()`, hand-built
#   `new ReadableStream({ start(c){ c.enqueue(...); c.error(...) } })` for error streams,
#   and the drain loop `while(true){ const {done}=await reader.read(); if(done) break }`.
# - Test "calls controller.error() and logs on mid-stream ReadableStream error (SRV-06)"
#   already exists — the NEW behavior (error frame emitted to client) must not break it.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write failing tests reproducing the mid-stream disconnect (RED)</name>
  <files>packages/server/src/handler.test.ts</files>
  <action>
Add a new `describe("mid-stream backend disconnect (issue #4)", ...)` block at the end of
`handler.test.ts`. Mirror the existing test helpers (`makeRequest`, `makeFetchResponse`,
the drain loop) and the existing top-of-file `vi.mock("./stream-registry", ...)` /
`vi.mock("./reconnect", ...)` setup — do NOT add new module mocks.

Use a `beforeEach` that calls `vi.restoreAllMocks()` and
`mockIsStreamReconnectEnabled.mockReturnValue(false)` (matching the main describe block).

Add these tests. They MUST fail against the current handler.ts (RED):

1. "emits an SSE error event to the client when reader.read() THROWS mid-stream":
   - Build a stream that enqueues one valid frame then throws:
     `new ReadableStream({ start(c){ c.enqueue(enc.encode('data: {"type":"text-delta","delta":"partial"}\n\n')); c.error(new Error("upstream-gone")); } })`.
   - Stub fetch to resolve `{ status:200, headers:new Headers(), body: errorStream }`.
   - Spy/silence `console.error`.
   - Call the handler, then drain the response body inside a try/catch (the stream
     may still surface an error after the error frame — that is acceptable).
   - Assert the collected output CONTAINS an SSE error frame: it must contain
     `"type":"error"` AND must contain the substring `data: ` for that frame.
     (The client must receive a parseable `data: {"type":"error",...}` line.)

2. "emits an SSE error event when the backend disconnects WITHOUT a terminal frame (premature done — truncation)":
   - Build a stream that enqueues a partial frame then closes cleanly WITHOUT any
     terminal/finish frame: `c.enqueue(enc.encode('data: {"type":"text-delta","delta":"half"}\n\n')); c.close();`
   - This simulates a backend killed mid-stream where TCP closes — `reader.read()`
     returns `{done:true}` but no `finish` frame ever arrived.
   - Drain the response. Assert the output CONTAINS `"type":"error"`.
   - NOTE: this is the harder case. Detection requires tracking whether a terminal
     SSE frame (a frame whose JSON `type` is `"finish"`, or the literal `[DONE]`
     sentinel) was observed before `done`. Task 2 implements that detection.

3. "does NOT emit an error event on a clean finish (backend sends a finish frame then closes)":
   - Stream: `c.enqueue(enc.encode('data: {"type":"text-delta","delta":"hi"}\n\n')); c.enqueue(enc.encode('data: {"type":"finish"}\n\n')); c.close();`
   - Drain the response. Assert the output does NOT contain `"type":"error"`.
   - This pins the no-regression invariant — a normal completion stays clean.

4. "marks the stream-registry entry done on mid-stream failure so the resumeId is unlocked":
   - Set `mockIsStreamReconnectEnabled.mockReturnValue(true)` and
     `mockLookupStream.mockReturnValue(undefined)` for this test.
   - Use the throwing errorStream from test 1.
   - Call the handler with `makeRequest({ headers: { "x-resume-id": "res-disconnect" } })`.
   - Drain the response (try/catch).
   - Assert `mockMarkStreamDone` was called with `"res-disconnect"`.
   - (This may already pass via the existing `finally` block — keep it as a
     regression guard so Task 2's refactor does not break registry cleanup.)

Run `pnpm --filter @deepagents-nextjs/server test handler.test.ts` (or `npx vitest run
src/handler.test.ts` from `packages/server`). Confirm tests 1 and 2 FAIL (no error
frame emitted) and test 3 passes. Test 4 may pass already.
  </action>
  <verify>
From `packages/server`: `npx vitest run src/handler.test.ts` — the new "mid-stream
backend disconnect (issue #4)" block shows tests 1 and 2 FAILING with assertion errors
about missing `"type":"error"` in the output. Test 3 passes. All pre-existing tests in
the file still pass (count unchanged for the old tests).
  </verify>
  <done>
`handler.test.ts` contains a new describe block with 4 mid-stream-disconnect tests.
Tests 1 and 2 fail (RED) because the current handler emits no SSE error frame; test 3
passes; the rest of the suite is unaffected.
  </done>
</task>

<task type="auto">
  <name>Task 2: Detect disconnect, emit SSE error event, and clean up AbortController + registry (GREEN)</name>
  <files>packages/server/src/handler.ts</files>
  <action>
Modify `createDeepAgentsHandler` in `handler.ts` to make the Task 1 tests pass. Keep
changes surgical — do not restructure the unrelated header/auth/retry logic.

(A) Introduce an AbortController for the upstream connection:
- Inside the `POST` function, before `fetchWithRetry`, create
  `const abortController = new AbortController();`.
- Pass `signal: abortController.signal` into the `RequestInit` object given to
  `fetchWithRetry` (alongside `method`, `headers`, `body`, `duplex`). The existing
  `fetchWithRetry` forwards `init` straight to `fetch`, so no signature change needed.
- This satisfies issue #4's "Clean up the AbortController" requirement and ensures the
  upstream fetch is releasable.

(B) Add a module-level helper to recognise a terminal SSE frame. Place it near
`applyTransforms`:
```
/** True if a transformed frame is the stream's terminal marker. */
function isTerminalFrame(frame: SseFrame): boolean {
  const raw = frame.raw;
  if (raw.includes("[DONE]")) return true;
  // SSE data lines look like: data: {...json...}
  const match = raw.match(/data:\s*(\{.*\})/s);
  if (!match) return false;
  try {
    const parsed = JSON.parse(match[1]) as { type?: string };
    return parsed.type === "finish";
  } catch {
    return false;
  }
}
```

(C) Add a module-level helper that builds the SSE error frame text:
```
/** Build a client-parseable SSE error event frame (without trailing \n\n). */
function buildErrorFrame(message: string): string {
  return `data: ${JSON.stringify({ type: "error", errorText: message })}`;
}
```
Use `errorText` as the field name — it matches the AI SDK v6 error part shape. Keep
the message generic ("upstream backend disconnected mid-stream") — do NOT leak the raw
upstream error object/stack to the client.

(D) Rework the `ReadableStream` `start(controller)` body to track terminal-frame
observation and emit an error event on disconnect:
- Declare `let sawTerminalFrame = false;` at the top of `start`.
- In BOTH the `done`-branch flush loop AND the normal `accumulator.push` loop, after a
  frame is transformed and enqueued, set `sawTerminalFrame = sawTerminalFrame ||
  isTerminalFrame(transformed)`. (Check the transformed frame, not the raw, so it
  reflects what the client actually receives.)
- In the `done` branch, AFTER the flush loop and BEFORE `controller.close()`:
  if `!sawTerminalFrame`, treat this as a truncated stream — enqueue an error frame:
  `controller.enqueue(encoder.encode(`${buildErrorFrame("upstream backend disconnected mid-stream")}\n\n`));`
  then still call `controller.close()` (the error event is now in-band, the stream is
  cleanly closed so the client can read it).
- In the `catch (err)` block: keep `console.error("[deepagents/server] mid-stream error", err)`.
  Then, BEFORE failing the stream, enqueue the error frame so the client receives a
  parseable event:
  `try { controller.enqueue(encoder.encode(`${buildErrorFrame("upstream backend disconnected mid-stream")}\n\n`)); } catch { /* controller already errored/closed */ }`.
  Then call `controller.close()` instead of `controller.error(err)` — the error is now
  delivered in-band as an SSE event, and closing (not erroring) lets the client read
  that final frame reliably. (The existing SRV-06 test only asserts `console.error`
  was called and tolerates a thrown OR clean drain, so switching to `controller.close()`
  keeps it green — confirm this when running tests.)
- In the `finally` block: add `abortController.abort();` as the FIRST statement so the
  upstream fetch connection is released on every exit path (clean finish, truncation,
  or thrown error). Keep the existing `markStreamDone(resumeId)` (guarded by
  `resumeId && isStreamReconnectEnabled()`) and `cleanupExpiredApprovals()` calls —
  these already run on the error path and satisfy registry cleanup.

(E) Guard the catch-block enqueue and the truncation enqueue with try/catch — if the
client has already disconnected, `controller.enqueue` can throw `TypeError: Invalid
state`; that must not mask the original failure or crash the finally block.

Do not change the response headers, status threading, transform pipeline order, or the
resumeId dedup logic.
  </action>
  <verify>
From `packages/server`: `npx vitest run src/handler.test.ts` — ALL tests pass,
including the 4 new mid-stream-disconnect tests from Task 1 and the pre-existing
SRV-06 ("calls controller.error() and logs on mid-stream ReadableStream error") and
"markStreamDone IS called in finally block even when mid-stream error fires" tests.
Then `npx vitest run` for the whole server package — full suite green. Then
`npx tsc --noEmit` (or `pnpm --filter @deepagents-nextjs/server typecheck`) — no type
errors. Confirm `grep -n "AbortController" src/handler.ts` and
`grep -n "type.*error" src/handler.ts` both return matches.
  </verify>
  <done>
`handler.ts` creates an `AbortController`, passes its `signal` to the upstream fetch,
and aborts it in the `finally` block. The streaming loop tracks whether a terminal
frame was seen and emits a parseable `data: {"type":"error",...}` SSE event to the
client both when `reader.read()` throws and when the stream ends without a terminal
frame. A clean finish emits no error event. The full server test suite and typecheck
pass.
  </done>
</task>

</tasks>

<verification>
- `npx vitest run` in `packages/server` — entire suite green (handler.test.ts +
  stream-registry.test.ts + all adapter tests). No pre-existing test regressed.
- `npx tsc --noEmit` in `packages/server` — clean.
- Mid-stream thrown error: client receives `data: {"type":"error","errorText":"..."}\n\n`.
- Mid-stream truncation (premature `done`, no `finish` frame): client receives the
  same error event.
- Clean finish (backend sends `{"type":"finish"}` then closes): no error event emitted.
- `AbortController` is created and `.abort()` is called in the `finally` block on every
  exit path.
- `markStreamDone(resumeId)` still runs on the mid-stream error path (resumeId unlocked,
  no permanent 409).
</verification>

<success_criteria>
- Issue #4 reproduction (start stream → kill backend mid-stream → client gets truncated
  data with no error) is fixed: the client now receives a parseable SSE error event
  before the stream closes.
- Upstream disconnect is detected in both forms — `reader.read()` throwing and
  `reader.read()` returning `done` without a terminal frame.
- The `AbortController` is aborted and the stream-registry entry is marked done on
  failure — no connection leak, no permanent resumeId lock.
- No regression: clean streams still close without an error event; all existing
  handler and registry tests pass.
- Out-of-scope items (client-side reconnection retry, backoff, non-SSE protocols) are
  NOT touched.
</success_criteria>

<output>
After completion, create
`.planning/quick/1-fix-streaming-mid-stream-backend-disconn/1-SUMMARY.md`
</output>
