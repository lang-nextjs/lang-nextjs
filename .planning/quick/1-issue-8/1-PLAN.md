---
phase: quick-issue-8
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/server/src/stream-registry.ts
  - packages/server/src/stream-registry.test.ts
  - packages/server/src/handler.ts
  - packages/server/src/handler.test.ts
autonomous: true
requirements:
  - INTENT-01

formal_artifacts: none

must_haves:
  truths:
    - "Concurrent requests with the same resumeId cannot both register a stream — one gets 409"
    - "atomicRegisterIfAbsent rejects registration when an active (done=false) stream exists for the resumeId"
    - "atomicRegisterIfAbsent allows registration when no stream exists or the existing stream is done=true"
    - "Failed fetch (502 path) with reconnect enabled cleans up the registry entry — no permanent 409 lockout"
    - "All existing tests continue to pass unchanged"
  artifacts:
    - path: "packages/server/src/stream-registry.ts"
      provides: "atomicRegisterIfAbsent function combining lookup + conditional register"
      exports: ["atomicRegisterIfAbsent"]
    - path: "packages/server/src/handler.ts"
      provides: "Handler using atomic registration instead of separate lookup+register"
    - path: "packages/server/src/stream-registry.test.ts"
      provides: "Concurrency tests for atomicRegisterIfAbsent"
    - path: "packages/server/src/handler.test.ts"
      provides: "Concurrent request tests and fetch-failure cleanup tests"
  key_links:
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/stream-registry.ts"
      via: "import { atomicRegisterIfAbsent, markStreamDone, deleteStream }"
      pattern: "atomicRegisterIfAbsent"
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/stream-registry.ts"
      via: "deleteStream on fetch failure path"
      pattern: "deleteStream.*resumeId"
---

<objective>
Fix race condition in concurrent stream registration for the same resumeId.

Purpose: Between `lookupStream()` and `registerStream()` in handler.ts (lines 194-203), two concurrent requests with the same resumeId can both pass the check and both register, with the second overwriting the first. The fix introduces an atomic operation that combines the lookup and conditional register into a single synchronous Map interaction, eliminating the race window. Also fixes the fetch-failure leak where a 502 response leaves a `done=false` registry entry permanently blocking the resumeId.

Output: Atomic stream registration in stream-registry.ts, updated handler using it, concurrency tests proving the race is eliminated.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@packages/server/src/handler.ts
@packages/server/src/stream-registry.ts
@packages/server/src/stream-registry.test.ts
@packages/server/src/handler.test.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add atomicRegisterIfAbsent to stream-registry + concurrency tests</name>
  <files>
    packages/server/src/stream-registry.ts
    packages/server/src/stream-registry.test.ts
  </files>
  <action>
    In `stream-registry.ts`, add a new exported function `atomicRegisterIfAbsent`:

    ```ts
    export type RegisterResult =
      | { ok: true; streamId: string }
      | { ok: false; reason: "active" | "expired_during_call" };

    export function atomicRegisterIfAbsent(
      resumeId: string,
      streamId: string,
      stream?: ReadableStream
    ): RegisterResult {
      const registry = getRegistry();
      const existing = registry.get(resumeId);

      if (existing) {
        // Check TTL — if expired, evict and allow re-registration
        if (Date.now() - existing.createdAt > TTL_MS) {
          registry.delete(resumeId);
          // Fall through to register below
        } else if (!existing.done) {
          return { ok: false, reason: "active" };
        }
        // existing is done=true and within TTL — fall through to overwrite
      }

      registry.set(resumeId, {
        streamId,
        createdAt: Date.now(),
        done: false,
        stream,
      });
      return { ok: true, streamId };
    }
    ```

    This function is synchronous and runs in a single JavaScript tick. Since Node.js is single-threaded for synchronous code, no other async callback can interleave between the `.get()` check and the `.set()` call. This eliminates the race window.

    Also add a `RegisterResult` type export.

    In `stream-registry.test.ts`, add tests inside a new `describe("atomicRegisterIfAbsent", () => { ... })` block:

    1. "returns ok:true and registers when no existing entry" — call atomicRegisterIfAbsent("new-id", "s-1"), verify returns `{ ok: true, streamId: "s-1" }`, verify lookupStream("new-id") returns the record.

    2. "returns ok:false with reason:'active' when an active (done=false) stream exists" — registerStream("abc", "s-1"), then atomicRegisterIfAbsent("abc", "s-2"), verify returns `{ ok: false, reason: "active" }`, verify lookupStream still returns streamId "s-1" (not overwritten).

    3. "returns ok:true and overwrites when existing stream is done=true" — registerStream("abc", "s-1"), markStreamDone("abc"), then atomicRegisterIfAbsent("abc", "s-2"), verify returns `{ ok: true, streamId: "s-2" }`, verify lookupStream returns streamId "s-2" with done=false.

    4. "returns ok:true and registers when existing entry is TTL-expired (evicts then registers)" — registerStream("abc", "s-1"), vi.spyOn(Date, "now") to advance 6 minutes, then atomicRegisterIfAbsent("abc", "s-2"), verify returns ok:true, restore mocks, verify lookupStream returns "s-2".

    5. "stores optional ReadableStream on the record" — atomicRegisterIfAbsent("abc", "s-1", fakeStream), verify lookupStream("abc").stream is fakeStream.

    6. "simulates concurrent registration: 10 sequential calls to atomicRegisterIfAbsent with same resumeId — exactly 1 succeeds" — loop 10 times calling atomicRegisterIfAbsent("concurrent-test", `s-${i}`), collect results, verify exactly 1 returns ok:true and 9 return ok:false reason:"active".
  </action>
  <verify>
    cd /Users/jonathanborduas/code/lang-nextjs/.worktrees/8 && npx vitest run packages/server/src/stream-registry.test.ts --reporter=verbose 2>&1 | tail -40
  </verify>
  <done>
    - atomicRegisterIfAbsent exported from stream-registry.ts
    - RegisterResult type exported
    - All 6 new concurrency tests pass
    - All existing stream-registry tests still pass
  </done>
</task>

<task type="auto">
  <name>Task 2: Update handler to use atomic registration + cleanup on fetch failure + handler tests</name>
  <files>
    packages/server/src/handler.ts
    packages/server/src/handler.test.ts
  </files>
  <action>
    **handler.ts changes:**

    1. Update imports: Replace `lookupStream, registerStream` with `atomicRegisterIfAbsent`. Keep `markStreamDone`. Add `deleteStream` import.

       Change line 17-21 from:
       ```ts
       import {
         lookupStream,
         registerStream,
         markStreamDone,
       } from "./stream-registry";
       ```
       To:
       ```ts
       import {
         atomicRegisterIfAbsent,
         markStreamDone,
         deleteStream,
       } from "./stream-registry";
       ```

    2. Replace the non-atomic dedup block (lines 194-203):
       ```ts
       // BEFORE:
       if (resumeId && isStreamReconnectEnabled()) {
         const existing = lookupStream(resumeId);
         if (existing && !existing.done) {
           return new NextResponse(
             "stream already in progress for this resumeId",
             { status: 409 }
           );
         }
         registerStream(resumeId, crypto.randomUUID());
       }
       ```
       With:
       ```ts
       // AFTER:
       let registeredResumeId: string | undefined;
       if (resumeId && isStreamReconnectEnabled()) {
         const result = atomicRegisterIfAbsent(
           resumeId,
           crypto.randomUUID()
         );
         if (!result.ok) {
           return new NextResponse(
             "stream already in progress for this resumeId",
             { status: 409 }
           );
         }
         registeredResumeId = resumeId;
       }
       ```

    3. In the fetch failure catch block (around line 258-264), add cleanup for the registered entry:
       ```ts
       } catch (err) {
         // Clean up registry entry if we registered but fetch failed — prevents permanent 409 lockout
         if (registeredResumeId) {
           deleteStream(registeredResumeId);
         }
         console.error(
           "[deepagents/server] backend fetch failed after retries",
           err
         );
         return new NextResponse("upstream error", { status: 502 });
       }
       ```

    4. Update the `finally` block inside ReadableStream (around line 329-331) to use `registeredResumeId` instead of `resumeId` for the markStreamDone call:
       ```ts
       if (registeredResumeId && isStreamReconnectEnabled()) {
         markStreamDone(registeredResumeId);
       }
       ```

    **handler.test.ts changes:**

    1. Update the vi.mock for stream-registry to include `atomicRegisterIfAbsent` and `deleteStream`:
       ```ts
       vi.mock("./stream-registry", () => ({
         atomicRegisterIfAbsent: vi.fn(),
         markStreamDone: vi.fn(),
         deleteStream: vi.fn(),
       }));
       ```
       Remove `lookupStream` and `registerStream` from the mock.

    2. Update imports to match:
       ```ts
       import {
         atomicRegisterIfAbsent,
         markStreamDone,
         deleteStream,
       } from "./stream-registry";
       ```
       Remove lookupStream and registerStream imports.

    3. Add mock aliases:
       ```ts
       const mockAtomicRegister = vi.mocked(atomicRegisterIfAbsent);
       const mockDeleteStream = vi.mocked(deleteStream);
       ```

    4. Update ALL existing tests that reference `mockLookupStream` or `mockRegisterStream`:
       - Tests that set `mockLookupStream.mockReturnValue(undefined)` should instead set `mockAtomicRegister.mockReturnValue({ ok: true, streamId: "test-stream-id" })`.
       - Tests that set `mockLookupStream.mockReturnValue({ streamId: "...", done: false, ... })` should instead set `mockAtomicRegister.mockReturnValue({ ok: false, reason: "active" })`.
       - Tests that asserted `mockRegisterStream` calls should assert `mockAtomicRegister` calls instead.
       - Tests that asserted `mockLookupStream` calls should assert `mockAtomicRegister` calls instead.
       - Remove all references to `mockLookupStream` and `mockRegisterStream`.

       Specific test mappings:
       - "when ENABLE_STREAM_RECONNECT=true but X-Resume-Id header is absent" — remove lookupStream assertions, verify atomicRegisterIfAbsent not called (same semantics).
       - "when ENABLE_STREAM_RECONNECT is false (default)" — same, verify atomicRegister not called.
       - "no existing stream" — mockAtomicRegister returns `{ ok: true, streamId: "..." }`, assert calledWith("res-abc", expect.any(String)).
       - "existing ACTIVE stream" — mockAtomicRegister returns `{ ok: false, reason: "active" }`, assert 409.
       - "existing done=true stream" — mockAtomicRegister returns `{ ok: true, streamId: "..." }`, assert not 409.
       - "after stream completes" — first call mockAtomicRegister ok:true, after stream drain check markStreamDone called.
       - "markStreamDone IS called in finally block even when mid-stream error" — mockAtomicRegister ok:true, verify markStreamDone called.
       - "when fetch fails (502 path)" — mockAtomicRegister ok:true, verify deleteStream called with the resumeId (this fixes the documented gap in the test at line 986). Also verify markStreamDone NOT called (correct — deleteStream is the cleanup, not markStreamDone).

    5. Add a NEW test in the "resumeId deduplication" describe block:
       ```
       it("concurrent requests for the same resumeId: first registers, second gets 409 (no race window)", async () => {
         mockIsStreamReconnectEnabled.mockReturnValue(true);
         // Simulate: first call succeeds, second call fails (active)
         mockAtomicRegister
           .mockReturnValueOnce({ ok: true, streamId: "s-1" })
           .mockReturnValueOnce({ ok: false, reason: "active" });
         vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse({ body: "data: hi\n\n" })));

         const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
         const response1 = await handler(makeRequest({ headers: { "x-resume-id": "res-race" } }));
         expect(response1.status).not.toBe(409);

         const response2 = await handler(makeRequest({ headers: { "x-resume-id": "res-race" } }));
         expect(response2.status).toBe(409);
       });
       ```

    6. Add a NEW test for fetch-failure cleanup:
       ```
       it("when fetch fails (502 path), deleteStream is called to clean up the registry entry — no permanent 409 lockout", async () => {
         mockIsStreamReconnectEnabled.mockReturnValue(true);
         mockAtomicRegister.mockReturnValue({ ok: true, streamId: "s-1" });
         vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
         const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

         const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
         const response = await handler(makeRequest({ headers: { "x-resume-id": "res-502-cleanup" } }));

         expect(response.status).toBe(502);
         expect(mockDeleteStream).toHaveBeenCalledWith("res-502-cleanup");
         expect(mockMarkStreamDone).not.toHaveBeenCalled();
         consoleSpy.mockRestore();
       });
       ```
  </action>
  <verify>
    cd /Users/jonathanborduas/code/lang-nextjs/.worktrees/8 && npx vitest run packages/server/src/handler.test.ts packages/server/src/stream-registry.test.ts --reporter=verbose 2>&1 | tail -60
  </verify>
  <done>
    - handler.ts uses atomicRegisterIfAbsent instead of separate lookupStream+registerStream
    - handler.ts calls deleteStream on fetch failure to prevent permanent 409 lockout
    - handler.ts uses registeredResumeId for markStreamDone (not raw resumeId)
    - All existing handler tests updated and passing
    - New concurrent request test passes (first ok, second 409)
    - New fetch-failure cleanup test passes (deleteStream called)
    - All stream-registry tests pass (including new atomicRegisterIfAbsent tests)
    - Zero references to the old separate lookupStream/registerStream pattern in handler.ts
  </done>
</task>

</tasks>

<verification>
  # Full test suite for the server package must pass
  cd /Users/jonathanborduas/code/lang-nextjs/.worktrees/8 && npx vitest run packages/server/src/ --reporter=verbose

  # Verify no references to the old race-prone pattern remain in handler.ts
  grep -n "lookupStream\|registerStream" packages/server/src/handler.ts
  # Expected: no matches (both replaced by atomicRegisterIfAbsent)

  # Verify atomicRegisterIfAbsent is exported from stream-registry
  grep -n "export.*atomicRegisterIfAbsent" packages/server/src/stream-registry.ts
</verification>

<success_criteria>
  - atomicRegisterIfAbsent combines lookup + conditional register into a single synchronous Map operation
  - No race window exists between checking and registering a stream
  - Handler uses atomicRegisterIfAbsent exclusively (no separate lookupStream/registerStream)
  - Fetch failure (502) calls deleteStream to prevent permanent 409 lockout
  - All existing tests pass with updated mocks
  - New concurrency tests pass (10-call test proves exactly 1 succeeds)
  - New fetch-failure cleanup test passes
  - grep confirms zero references to old lookupStream/registerStream pattern in handler.ts
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-8/1-SUMMARY.md`
</output>
