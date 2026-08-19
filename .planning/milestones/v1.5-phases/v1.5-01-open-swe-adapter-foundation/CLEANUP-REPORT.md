# Cleanup Report — Phase v1.5-01

## Summary
Total: 4 findings (1 high, 2 medium, 1 low)

## Findings

### High Severity

1. **openSwe.ts:91-92** — Over-defensive nullish coalescing
   - **Description**: `const chunk = (parsed.data?.chunk as Record<string, unknown>) ?? {};` applies `??` after a type-unsafe cast. The cast to `Record<string, unknown>` already succeeds regardless of the value; the `?? {}` is redundant defensive coding that masks intent.
   - **Suggested Fix**: Change to `const chunk = parsed.data?.chunk as Record<string, unknown> | undefined;` and handle undefined explicitly in the next line check, or use `.data?.chunk as Record<string, unknown>` and let it be `undefined` if missing (then check `chunk?.content`).

### Medium Severity

2. **openSwe.test.ts:347** — Dead shared transform instance across tests
   - **Description**: `const transform = createOpenSweTransform();` declared at module scope inside the describe block for pass-through tests. All pass-through tests reuse the same instance, creating implicit state coupling across tests. The test "passes through [DONE] frame unchanged" and others run against the same stateful transform, potentially leaking state from prior tests.
   - **Suggested Fix**: Move the transform instantiation into each test's `it()` block (or use `beforeEach()`) to ensure isolation. Current pattern works because the tests don't emit tool start/end events (which modify state), but violates the isolation principle documented in earlier tests ("no inter-request state leakage").

3. **openSweHeartbeat.ts:73-75** — Dead cancel() method with empty implementation
   - **Description**: The `cancel()` method in ReadableStream.start() has no effect. Cancellation is already handled by `finally` block cleanup (releaseLock + close). The comment states propagation happens "automatically" but the empty method implies future work that never materializes.
   - **Suggested Fix**: Either remove the empty `cancel()` method entirely (ReadableStream will use default behavior), or implement explicit upstream reader cancellation if needed: `cancel() { reader.cancel(); }` (though this still propagates via releaseLock).

### Low Severity

4. **openSwe.ts:158** — Non-null assertion on guaranteed expression
   - **Description**: `if (framesToEmit.length === 1) return framesToEmit[0]!;` uses a non-null assertion (`!`) on `framesToEmit[0]` after checking `framesToEmit.length === 1`. TypeScript guarantees the value is defined; the `!` is unnecessary noise.
   - **Suggested Fix**: Remove the `!` operator: `return framesToEmit[0];` TypeScript will infer non-null after the length check.

## Patterns Reviewed

- **Unused imports**: None detected. All imports (SseFrame, SseTransform, SseAdapter) are actively used.
- **Dead branches**: None in main code paths. Comments in langgraph.ts (lines 65-69) document future work clearly marked as NOT present in fixture.
- **Inconsistent naming**: None detected. Both openSwe and langchain adapters follow consistent naming (toolCallId, toolName, input, output). Consistent use of `queueKey` and `toolCallId` patterns.
- **Type system trust**: openSweHeartbeat.ts properly trusts ReadableStream<Uint8Array> contract; no over-defensive checks there.

## Verdict
**MINOR ISSUES**

The codebase is clean and intentional. The three findings are:
- One defensive null-coalescing pattern that could be clearer (line 91-92)
- One test isolation violation that is harmless for current tests but violates documented principles (line 347)
- One dead cancel method that is truly inert (line 73-75)
- One gratuitous non-null assertion (line 158)

None block functionality. Recommend addressing during code review cleanup pass before merging v1.5-01 to main, or defer to v1.5-02 if velocity is critical.

### Recommended Quick Fixes (5 minutes)
1. openSwe.ts line 158: remove `!`
2. openSwe.test.ts line 347: move transform into each test function
3. openSweHeartbeat.ts line 73-75: delete `cancel()` method entirely
4. openSwe.ts line 91-92: clarify intent (prefer explicit undefined handling)
