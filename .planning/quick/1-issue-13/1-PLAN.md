---
phase: quick-issue-13
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - e2e/llm.spec.ts
  - .github/workflows/e2e.yml
  - playwright.config.ts
autonomous: true
requirements:
  - ISSUE-13

formal_artifacts: none

must_haves:
  truths:
    - "Real LLM SSE stream delivers text-delta frames through the full stack"
    - "Real LLM stream terminates cleanly with a finish frame and no error frames"
    - "Chat UI renders assistant message from real LLM output"
    - "LLM tests are gated behind OPENROUTER_API_KEY and skip gracefully when absent"
    - "LLM tests only run on main branch pushes, not on PRs"
  artifacts:
    - path: "e2e/llm.spec.ts"
      provides: "Real LLM E2E test suite with text streaming, completion, and UI verification"
      min_lines: 60
    - path: ".github/workflows/e2e.yml"
      provides: "New e2e-llm CI job gated on push to main with OPENROUTER_API_KEY secret"
      contains: "e2e-llm"
    - path: "playwright.config.ts"
      provides: "chromium-llm project matching llm.spec.ts"
      contains: "llm.spec"
  key_links:
    - from: "e2e/llm.spec.ts"
      to: "/api/chat/stream"
      via: "Playwright request.post() and page.goto()"
      pattern: "api/chat/stream"
    - from: ".github/workflows/e2e.yml"
      to: "e2e/llm.spec.ts"
      via: "pnpm e2e --project=chromium-llm"
      pattern: "chromium-llm"
    - from: ".github/workflows/e2e.yml"
      to: "OPENROUTER_API_KEY secret"
      via: "BACKEND_URL env pointing at Django with OPENROUTER_API_KEY"
      pattern: "OPENROUTER_API_KEY"
---

<objective>
Add an optional E2E test suite that validates real LLM output flowing through the full stack.

Purpose: Current E2E tests use mocked SSE streams or deterministic backends. No test validates actual LLM output (special characters, partial JSON, variable tool schemas) flowing through the system. This gap means parse failures in production that mocked tests never catch.

Output: A new `e2e/llm.spec.ts` test suite + a new `e2e-llm` CI job that runs only on main branch pushes, gated behind the existing `OPENROUTER_API_KEY` secret. Tests verify text streaming, completion detection, and clean stream closure.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@e2e/chat.spec.ts
@.github/workflows/e2e.yml
@playwright.config.ts
@apps/example/app/api/chat/stream/route.ts
@apps/example/app/api/chat/stream/route.mock.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create e2e/llm.spec.ts real LLM test suite</name>
  <files>e2e/llm.spec.ts</files>
  <action>
Create a NEW test file `e2e/llm.spec.ts` with a Playwright test suite that validates real LLM output flowing through the full DeepAgents stack.

The tests require a real backend (Django or FastAPI with an OPENROUTER_API_KEY). If `process.env.OPENROUTER_API_KEY` is not set, each test must call `test.skip()` with a clear message. This makes the suite safe to run locally without a key.

Follow the patterns from `e2e/chat.spec.ts` for SSE parsing (split on `\n\n`, parse JSON, filter by type). Use `request.post()` for API-level tests and `page.goto()` for UI tests.

Test cases (3 tests total):

1. **"LLM stream delivers text-delta frames through full stack"**
   - Use `request.post("/api/chat/stream", { data: { messages: [{ role: "user", content: "Say exactly: Hello from real LLM test" }] }, headers: { "Content-Type": "application/json" }, timeout: 60_000 })`
   - Parse SSE body, find `text-delta` frames
   - Assert `textDeltaFrames.length > 0`
   - Concatenate deltas and assert the combined text contains a word from the prompt (e.g., "Hello" or "LLM")
   - Gate: skip if no `OPENROUTER_API_KEY`

2. **"LLM stream terminates with finish frame and no error frames"**
   - Same POST request with content "Say the word banana"
   - Parse SSE body
   - Assert no frames with `type === "error"`
   - Assert last frame has `type === "finish"`
   - Assert finish frame has `finishReason` (truthy, typically "stop")
   - Gate: skip if no `OPENROUTER_API_KEY`

3. **"Chat UI renders assistant message from real LLM"**
   - Set `test.setTimeout(120_000)` (real LLM can be slow)
   - Navigate to `page.goto("/")`, wait for `networkidle`
   - Fill the textbox with "Reply with only the word testllm"
   - Press Enter
   - Wait for assistant message to appear: `page.locator('[data-role="assistant"], [data-testid="ai-message"], .ai-message').first()` to be visible with `{ timeout: 90_000 }`
   - Assert the assistant bubble contains some text (length > 0)
   - Gate: skip if no `OPENROUTER_API_KEY`

Each test should extract the skip logic into a helper at the top:
```ts
const hasApiKey = !!process.env.OPENROUTER_API_KEY;
```
Then use `test.skip(!hasApiKey, "OPENROUTER_API_KEY not set — skipping real LLM tests")` at the start of each test.

Add a `test.describe("DeepAgents E2E — Real LLM integration", ...)` wrapper.

Do NOT import any new dependencies beyond `@playwright/test`.
  </action>
  <verify>
    grep -c "test(" e2e/llm.spec.ts  # should be 3 tests
    grep "OPENROUTER_API_KEY" e2e/llm.spec.ts  # skip gate present
    grep "text-delta" e2e/llm.spec.ts  # streaming verification
    grep "finish" e2e/llm.spec.ts  # completion detection
    grep "data-role.*assistant" e2e/llm.spec.ts  # UI rendering check
  </verify>
  <done>
e2e/llm.spec.ts exists with 3 tests: text streaming verification, clean completion, and UI rendering. All tests skip gracefully when OPENROUTER_API_KEY is absent. No new dependencies added.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add chromium-llm project to playwright.config.ts and e2e-llm job to CI workflow</name>
  <files>playwright.config.ts, .github/workflows/e2e.yml</files>
  <action>
**Part A: playwright.config.ts**

Add a new project entry `chromium-llm` to the `projects` array, AFTER the existing `open-swe` project. This project uses the same device as `chromium` but restricts testMatch to only `llm.spec.ts`:

```ts
{
  name: "chromium-llm",
  use: { ...devices["Desktop Chrome"] },
  testMatch: /llm\.spec\.ts/,
},
```

The existing `chromium` project's testMatch already restricts it to specific files (`nextjs.spec.ts`, `nextjs-extra.spec.ts`, `reconnect.spec.ts`, `chat.spec.ts`) so `llm.spec.ts` will NOT be picked up by any existing project. Verify this after the change.

**Part B: .github/workflows/e2e.yml**

Add a new job `e2e-llm` AFTER the existing `e2e-fastapi` job. Key design decisions:

- Trigger: `push` to `main` only (NOT on pull_request) — avoids cost and flakes on PRs
- Condition: `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`
- Secret: Uses `OPENROUTER_API_KEY` (already exists as a repo secret, used by Django/FastAPI jobs)
- Backend: Starts Django backend via docker compose (same as `e2e-django` job, since Django is the most battle-tested backend)
- Frontend: Starts `apps/example` on port 3001 with `BACKEND_URL=http://localhost:8002/api/chat/stream/` pointing at Django
- Test command: `pnpm e2e --project=chromium-llm` (only runs llm.spec.ts)
- Timeout: Generous timeouts for LLM responses (120s per test already set in spec)
- Artifact upload on failure
- Cleanup with `docker compose down -v` on `always()`

The job should mirror the structure of `e2e-django` (same checkout/setup/build/compose steps) but with these differences:
- `if` condition limits to push-to-main only
- Runs `pnpm e2e --project=chromium-llm` instead of the grep-invert command
- No need for `PLAYWRIGHT_BASE_URL` override since we use the same port 3001 as the chromium project's default for this context — but set it explicitly for clarity: `PLAYWRIGHT_BASE_URL: http://localhost:3001`

Also update the `e2e-mocked` job comment (the step that says "Run mocked E2E tests") to mention it does NOT run LLM tests: update the step name or comment to clarify `chromium-llm` project is excluded from this job (it naturally is since `pnpm test:e2e` without `--project` runs all projects, but `llm.spec.ts` tests skip without the key anyway). No functional change needed in the mocked job — just a comment for clarity is optional.
  </action>
  <verify>
    # playwright.config.ts: chromium-llm project exists
    grep "chromium-llm" playwright.config.ts
    # playwright.config.ts: testMatch for llm.spec.ts
    grep "llm\\.spec\\.ts" playwright.config.ts
    # e2e.yml: new job exists
    grep "e2e-llm:" .github/workflows/e2e.yml
    # e2e.yml: push-only condition
    grep "push.*main" .github/workflows/e2e.yml | head -5
    # e2e.yml: runs chromium-llm project
    grep "chromium-llm" .github/workflows/e2e.yml
    # e2e.yml: OPENROUTER_API_KEY secret used
    grep "OPENROUTER_API_KEY" .github/workflows/e2e.yml | wc -l  # should be 3 (django, fastapi, llm)
  </verify>
  <done>
playwright.config.ts has a new `chromium-llm` project that only matches llm.spec.ts. e2e.yml has a new `e2e-llm` job that runs only on push to main, boots Django + Next.js, and runs the real LLM test suite. Existing jobs are unaffected.
  </done>
</task>

</tasks>

<verification>
1. grep "test(" e2e/llm.spec.ts — confirms 3 test functions defined
2. grep "chromium-llm" playwright.config.ts — new project registered
3. grep "e2e-llm" .github/workflows/e2e.yml — new CI job exists
4. grep "pull_request" does NOT appear in the e2e-llm job block — main-branch-only confirmed
5. Existing `chromium` project testMatch does NOT include llm.spec.ts — no double-running
</verification>

<success_criteria>
- e2e/llm.spec.ts exists with 3 tests (text streaming, clean completion, UI rendering)
- All tests skip gracefully when OPENROUTER_API_KEY is absent
- playwright.config.ts has chromium-llm project restricted to llm.spec.ts
- e2e.yml has e2e-llm job running only on push to main with OPENROUTER_API_KEY secret
- No existing CI jobs are modified or broken
- No new npm dependencies added
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-13/1-SUMMARY.md`
</output>
