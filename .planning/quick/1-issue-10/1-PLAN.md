---
phase: 1-issue-10
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/server/src/adapters/langchain.ts
  - packages/server/src/adapters/langchain.test.ts
  - packages/server/src/handler.test.ts
autonomous: true
requirements:
  - BUG-10
formal_artifacts: none

must_haves:
  truths:
    - "Each request through langchainAdapter gets a fresh toolCallCounters Map starting at counter 0"
    - "Two concurrent requests with overlapping tool calls produce independent, non-colliding toolCallIds"
    - "textStarted state does not leak between requests"
    - "All existing ADVERSARIAL tests in langchain.test.ts pass (per-name counters, explicit id guard, [DONE] sentinel)"
    - "Handler-level concurrent request test passes with lc-search-0 on both sequential requests"
  artifacts:
    - path: "packages/server/src/adapters/langchain.ts"
      provides: "LangChain SSE adapter with per-request transform isolation"
      contains: "createLangchainTransform"
    - path: "packages/server/src/adapters/langchain.test.ts"
      provides: "Unit tests for langchainAdapter including adversarial counter isolation tests"
      min_lines: 100
    - path: "packages/server/src/handler.test.ts"
      provides: "Integration test for concurrent request isolation through handler"
      contains: "langchainAdapter"
  key_links:
    - from: "packages/server/src/handler.ts"
      to: "packages/server/src/adapters/langchain.ts"
      via: "effectiveAdapter.transforms getter"
      pattern: "effectiveAdapter\\.transforms"
    - from: "packages/server/src/adapters/langchain.ts"
      to: "langchainAdapter.transforms getter"
      via: "returns createLangchainTransform() per access"
      pattern: "get transforms"
---

<objective>
Fix langchainAdapter toolCallCounters state leak across concurrent requests.

Purpose: The langchainAdapter uses a closure-based toolCallCounters Map for generating deterministic toolCallIds. If this state persists across requests, request N receives toolCallIds offset by prior requests' counts instead of starting fresh at 0. This causes incorrect tool call deduplication on the client side.

Output: Verified per-request isolation of toolCallCounters and textStarted state, with comprehensive concurrent request tests.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@packages/server/src/adapters/langchain.ts
@packages/server/src/adapters/langchain.test.ts
@packages/server/src/handler.ts
@packages/server/src/handler.test.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Verify per-request isolation and fix any remaining state leak</name>
  <files>
    packages/server/src/adapters/langchain.ts
    packages/server/src/handler.ts
  </files>
  <action>
    **Analysis of current state:**

    The code already has two isolation mechanisms:
    1. `langchainAdapter.transforms` is a **getter** (langchain.ts L199-204) that returns `[createLangchainTransform()]` on each access, creating a fresh closure with new `toolCallCounters` Map and `textStarted` state.
    2. `handler.ts` accesses `effectiveAdapter.transforms` **inside** the POST function (handler.ts L185-189), meaning the getter fires once per request.

    **Verification steps:**
    1. Confirm `langchainAdapter` uses a `get transforms()` getter, NOT a plain property. If it is a getter, the per-request isolation is correct.
    2. Confirm `handler.ts` evaluates `[...effectiveAdapter.transforms]` inside the returned POST function, not at `createDeepAgentsHandler` call time. The current code at L185 is inside the POST closure -- this is correct.
    3. Run the existing ADVERSARIAL tests in `langchain.test.ts` to determine which pass and which fail:
       - "singleton langchainAdapter counter bleeds across tests" (line 347)
       - "two tool_call frames with DIFFERENT tool names" (line 316)
       - "explicit tool_call_id must not advance implicit counter" (line 439)
       - "[DONE] sentinel must only pass through on bare data-only frames" (line 492)
    4. Run the handler-level concurrent request test (handler.test.ts line 1164)

    **If all tests pass:** The fix is already in place. No code changes needed to langchain.ts or handler.ts. Proceed to Task 2 to add the concurrent request tests described in the issue.

    **If any test fails:** Identify the root cause:
    - If `langchainAdapter.transforms` is NOT a getter (plain property), convert it to a getter: `get transforms() { return [createLangchainTransform()]; }`
    - If `allTransforms` evaluation is outside the POST function in handler.ts, move it inside
    - If `createLangchainTransform()` shares state via module-level variables, ensure Map and state are created inside the function body

    **Specific fix pattern if getter is missing:**
    ```ts
    export const langchainAdapter: SseAdapter = {
      name: "langchain",
      get transforms() {
        return [createLangchainTransform()];
      },
    };
    ```

    **Run:** `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/adapters/langchain.test.ts`
    **Run:** `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/handler.test.ts`
  </action>
  <verify>
    Run: `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/adapters/langchain.test.ts` and confirm all tests pass (including ADVERSARIAL tests).
    Run: `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/handler.test.ts -t "ADVERSARIAL: langchainAdapter"` and confirm the concurrent request test passes.
  </verify>
  <done>
    All ADVERSARIAL tests in langchain.test.ts pass. Handler-level concurrent request test passes. Per-request isolation verified: toolCallCounters Map and textStarted state are fresh on each request.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add concurrent request tests for overlapping tool call streams</name>
  <files>
    packages/server/src/handler.test.ts
    packages/server/src/adapters/langchain.test.ts
  </files>
  <action>
    Add two new test cases that exercise concurrent request isolation more rigorously:

    **Test 1 -- in handler.test.ts, inside the "resumeId deduplication" describe block:**
    Add a test named "concurrent parallel streams with overlapping tool calls produce independent toolCallIds":
    - Create a handler with `langchainAdapter`
    - Create TWO mock fetch responses, each containing the same tool_call frame (e.g., `event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"test"}}`)
    - Use a deferred promise pattern to simulate concurrent streams:
      ```
      let resolveStream2: () => void;
      const stream2Ready = new Promise<void>(r => { resolveStream2 = r; });
      ```
    - Start request 1, consume the response body fully
    - Start request 2, consume the response body fully
    - Assert BOTH outputs contain `"toolCallId":"lc-search-0"` (not lc-search-1 on the second)
    - This validates that two requests in flight at the same time each get their own counter starting at 0.

    **Test 2 -- in langchain.test.ts:**
    Add a test named "two independent transforms from consecutive getter accesses maintain isolated counters":
    - Get `const t1 = langchainAdapter.transforms[0]`
    - Get `const t2 = langchainAdapter.transforms[0]`
    - Feed a tool_call frame to t1 -- assert lc-search-0
    - Feed a tool_call frame to t1 again -- assert lc-search-1
    - Feed a tool_call frame to t2 -- assert lc-search-0 (NOT lc-search-2)
    - This validates the getter creates truly independent closures.

    Pattern for the handler-level concurrent test (adapt from existing test at line 1164):
    ```ts
    it("concurrent parallel streams with overlapping tool calls produce independent toolCallIds", async () => {
      const { langchainAdapter } = await import("./adapters/langchain");
      const toolCallBody = 'event: tool_call\ndata: {"tool_name":"search","tool_input":{"q":"test"}}\n\n';
      const handler = createDeepAgentsHandler({ backendUrl: "http://backend", adapter: langchainAdapter });

      async function drain(response: any): Promise<string> {
        const reader = response.body!.getReader();
        const dec = new TextDecoder();
        let out = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out += dec.decode(value, { stream: true });
        }
        return out;
      }

      // Start both requests concurrently (do NOT await sequentially)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse({ body: toolCallBody })));
      const p1 = handler(makeRequest()).then(r => drain(r));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse({ body: toolCallBody })));
      const p2 = handler(makeRequest()).then(r => drain(r));
      const [out1, out2] = await Promise.all([p1, p2]);

      expect(out1).toContain('"toolCallId":"lc-search-0"');
      expect(out2).toContain('"toolCallId":"lc-search-0"');
    });
    ```

    Note: Place the concurrent test in the "resumeId deduplication" describe block (where the existing sequential test lives) or in a new describe("concurrent request isolation") block.
  </action>
  <verify>
    Run: `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/handler.test.ts` -- all tests pass including new concurrent test.
    Run: `pnpm --filter @deepagents-nextjs/server test -- --run packages/server/src/adapters/langchain.test.ts` -- all tests pass including new getter isolation test.
  </verify>
  <done>
    New concurrent parallel streams test passes -- two overlapping requests each produce lc-search-0. New getter isolation test passes -- consecutive getter accesses produce independent counters. All existing tests remain green.
  </done>
</task>

</tasks>

<verification>
1. `pnpm --filter @deepagents-nextjs/server test -- --run` -- full server test suite passes (76+ tests)
2. Grep `get transforms` in langchain.ts confirms getter pattern exists
3. Grep `allTransforms` in handler.ts confirms evaluation is inside POST function
</verification>

<success_criteria>
- All tests in packages/server/src/adapters/langchain.test.ts pass (including ADVERSARIAL tests)
- All tests in packages/server/src/handler.test.ts pass (including concurrent request test)
- toolCallCounters Map is fresh per request (counter starts at 0 on each new request)
- textStarted state is fresh per request (no cross-request text block leaks)
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-10/1-SUMMARY.md`
</output>
