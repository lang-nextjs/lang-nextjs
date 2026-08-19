---
phase: 01-streaming-malformed-sse-frame-crashes-tr
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/server/src/accumulator.ts
  - packages/server/src/accumulator.test.ts
  - packages/server/src/handler.ts
  - packages/server/src/handler.test.ts
autonomous: true
requirements:
  - BUG-06
formal_artifacts: none

must_haves:
  truths:
    - "Malformed SSE data line with invalid JSON does not crash the transform pipeline"
    - "A transform that throws an exception does not terminate the SSE stream"
    - "Oversized SSE frames are dropped before buffering to prevent memory exhaustion"
    - "Valid frames continue streaming after a malformed frame is skipped"
  artifacts:
    - path: "packages/server/src/accumulator.ts"
      provides: "SseFrameAccumulator with MAX_FRAME_BYTES guard and isFrameOversized export"
      min_lines: 57
    - path: "packages/server/src/handler.ts"
      provides: "applyTransforms wrapped in try/catch per frame; oversized frame guard in streaming loop"
      contains: "transform error"
    - path: "packages/server/src/accumulator.test.ts"
      provides: "Tests for frame size limit behavior"
      min_lines: 130
    - path: "packages/server/src/handler.test.ts"
      provides: "Tests for transform error isolation and oversized frame handling"
      min_lines: 1400
  key_links:
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/accumulator.ts"
      via: "isFrameOversized import, used in streaming loop before applyTransforms"
      pattern: "isFrameOversized"
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/transforms.ts"
      via: "try/catch wrapping applyTransforms per frame"
      pattern: "transform error.*skipping frame"
---

<objective>
Fix malformed SSE frame crashes in the transform pipeline.

The current pipeline has two crash vectors:
1. **Unhandled transform exceptions**: If any transform (built-in or user-provided) throws, the error propagates to the handler's streaming loop catch block which calls `controller.error(err)`, terminating the entire SSE stream for the client. A single bad frame kills the whole connection.
2. **Unbounded frame size**: `SseFrameAccumulator` has no frame size limit. A malicious or buggy backend can send an infinitely large frame (no `\n\n` boundary), causing unbounded memory growth.

Purpose: A single malformed frame must not crash the entire SSE connection. The pipeline must be resilient -- skip bad frames, log the error, and continue processing subsequent valid frames.
Output: Hardened accumulator with frame size limit, error-isolated transform pipeline, comprehensive tests.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@packages/server/src/accumulator.ts
@packages/server/src/handler.ts
@packages/server/src/transforms.ts
@packages/server/src/debug.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add frame size limit to SseFrameAccumulator</name>
  <files>packages/server/src/accumulator.ts, packages/server/src/accumulator.test.ts</files>
  <action>
In `packages/server/src/accumulator.ts`:

1. Add a `MAX_FRAME_BYTES` constant at module level, set to `1_000_000` (1MB). This is configurable enough for any legitimate SSE frame while preventing memory exhaustion. Document the rationale in a JSDoc comment: "Maximum buffered frame size in bytes (character count for UTF-8 single-byte). Frames exceeding this limit are discarded to prevent unbounded memory growth from malformed or malicious streams."

2. In the `push()` method, after `this.buffer += chunk`, add a guard: if `this.buffer.length > MAX_FRAME_BYTES`, reset `this.buffer` to empty string and return `[]` (discard the oversized partial frame silently). This prevents a stream with no `\n\n` boundary from consuming unbounded memory.

3. Export `MAX_FRAME_BYTES` as a named export so handler tests can reference it.

4. Add a new exported helper function `isFrameOversized(frame: string): boolean` that returns `frame.length > MAX_FRAME_BYTES`. The handler will use this to check complete frames before passing to transforms.

In `packages/server/src/accumulator.test.ts`:

Add a new `describe("frame size limit")` block with these tests:

1. `"push() discards buffer when it exceeds MAX_FRAME_BYTES (no boundary in stream)"` -- Push a chunk that makes the buffer exceed MAX_FRAME_BYTES (build a string of `'x'.repeat(MAX_FRAME_BYTES + 1)`). Verify `push()` returns `[]` and `flush()` returns `[]` (buffer was cleared).

2. `"push() keeps frames at exactly MAX_FRAME_BYTES"` -- Push a frame of exactly MAX_FRAME_BYTES followed by `\n\n`. Verify it returns the frame (not discarded).

3. `"push() handles oversized buffer followed by valid frames"` -- First push an oversized chunk (buffer gets cleared), then push a valid `"data: hello\n\n"` chunk. Verify the valid frame is returned correctly (buffer recovery after discard).

4. `"isFrameOversized returns true for frames exceeding MAX_FRAME_BYTES"` -- Unit test for the helper.

5. `"isFrameOversized returns false for frames at or below MAX_FRAME_BYTES"` -- Unit test for the helper.
  </action>
  <verify>`npx vitest run packages/server/src/accumulator.test.ts --reporter=verbose` passes all tests including new frame-size-limit tests</verify>
  <done>SseFrameAccumulator discards oversized partial frames, isFrameOversized exported, 5 new tests pass</done>
</task>

<task type="auto">
  <name>Task 2: Wrap applyTransforms in try/catch and add oversized frame guard in handler</name>
  <files>packages/server/src/handler.ts, packages/server/src/handler.test.ts</files>
  <action>
In `packages/server/src/handler.ts`:

1. Import `isFrameOversized` from `./accumulator` alongside `SseFrameAccumulator`.

2. In the `applyTransforms` function body, wrap the entire loop in a try/catch:
   ```typescript
   function applyTransforms(transforms: SseTransform[], frame: SseFrame): SseFrame | null {
     let current: SseFrame | null = frame;
     try {
       for (const t of transforms) {
         if (current === null) return null;
         current = t(current);
       }
       return current;
     } catch (err) {
       console.error("[deepagents/server] transform error, skipping frame:", err);
       // Return the original frame unchanged so the stream continues
       // (transforms may have partially modified it, but the original is safer)
       return frame;
     }
   }
   ```
   This ensures that if ANY transform throws (user-provided or built-in), the pipeline logs the error and passes the original untransformed frame through rather than crashing the stream. This is a fail-open policy: better to forward a raw frame than to terminate the entire connection.

3. In the streaming loop (both the `done` flush path and the normal `push()` path), before calling `applyTransforms`, add a guard:
   ```typescript
   // Skip oversized frames to prevent transform pipeline from processing unreasonably large payloads
   if (isFrameOversized(frame)) {
     console.error(`[deepagents/server] oversized frame (${frame.length} bytes), skipping`);
     continue; // or skip in the flush loop
   }
   ```
   In the `done` flush path, use `if (isFrameOversized(frame)) { console.error(...); continue; }` in the for-of loop.
   In the normal `push()` path, use `if (isFrameOversized(frame)) { console.error(...); continue; }` in the for-of loop.

In `packages/server/src/handler.test.ts`:

Add new tests inside the existing `describe("createDeepAgentsHandler")` block:

1. `"transform that throws does not crash the stream; valid frames before and after still arrive"` -- Create a handler with a transform that throws on frames containing "BAD" but passes through others. Send a stream with 3 frames: `data: {"type":"text","text":"before"}\n\n`, `data: BAD\n\n`, `data: {"type":"text","text":"after"}\n\n`. Verify the output contains both "before" and "after" frames, and the console.error spy was called with the transform error message. The "BAD" frame should still appear as raw since it falls back to the original frame (fail-open).

2. `"transform that throws on every frame does not crash the stream; all frames pass through as-is"` -- Create a handler where every transform throws. Send 2 valid SSE frames. Verify both frames appear in the output untransformed, and console.error was called twice.

3. `"oversized frame is skipped and does not reach transforms"` -- Send a stream with 2 frames: one oversized frame (exceeds MAX_FRAME_BYTES) followed by a normal frame `data: hello\n\n`. Use a spy transform that tracks which frames it saw. Verify: (a) the spy only saw the normal frame, (b) the output contains "hello" but not the oversized content, (c) console.error was called with "oversized frame".

4. `"oversized frame in flush path (no trailing newline) is skipped"` -- Send a stream where the last chunk has no trailing `\n\n` and the content exceeds MAX_FRAME_BYTES, followed by a normal stream close. Verify the oversized flushed frame is skipped.

5. `"existing 17 accumulator tests still pass unchanged"` -- This is verified by the <verify> step running all tests.
  </action>
  <verify>`npx vitest run packages/server/src/handler.test.ts packages/server/src/accumulator.test.ts packages/server/src/transforms.test.ts --reporter=verbose` passes all tests</verify>
  <done>applyTransforms catches transform exceptions and logs them (stream continues), oversized frames are skipped in both push and flush paths, 4 new handler tests pass alongside all existing tests</done>
</task>

</tasks>

<verification>
1. `npx vitest run packages/server/src/ --reporter=verbose` -- All existing + new tests pass (0 failures)
2. `grep -c "isFrameOversized" packages/server/src/handler.ts` returns >= 2 (import + usage)
3. `grep -c "transform error" packages/server/src/handler.ts` returns >= 1 (error log in applyTransforms catch)
4. `grep "MAX_FRAME_BYTES" packages/server/src/accumulator.ts` returns the constant definition
</verification>

<success_criteria>
- A transform throwing an exception no longer terminates the SSE stream
- Oversized frames (>1MB) are silently discarded before buffering or transforming
- All 17 existing accumulator tests pass unchanged
- All existing handler tests pass unchanged
- 5 new accumulator tests for frame size limits pass
- 4 new handler tests for error isolation pass
</success_criteria>

<output>
After completion, create `.planning/quick/1-streaming-malformed-sse-frame-crashes-tr/1-SUMMARY.md`
</output>
