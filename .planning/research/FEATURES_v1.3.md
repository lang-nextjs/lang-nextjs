# Feature Landscape: v1.3 Examples, Docs, Stream Reconnection & Edge Runtime

**Project:** deepagents-nextjs  
**Researched:** 2026-05-02  
**Mode:** Ecosystem  
**Confidence:** MEDIUM

---

## Executive Summary

v1.3 focuses on developer experience and production readiness. The six feature areas cluster into three concerns:

1. **Working examples** (SvelteKit/Remix apps, extended Next.js) — expected in production OSS; users learn by reading runnable code
2. **Documentation** (READMEs, test utilities guide, annotated quickstarts) — table stakes for framework adapter libraries; great docs reduce user friction and support issues
3. **Platform expansion** (edge runtime adapter, stream reconnection) — differentiators that push the library toward production-scale deployment patterns

Great OSS library examples follow a consistent pattern: minimal boilerplate, clear decision points (adapter swap, auth integration), and explicit feature demonstration. Package READMEs must be scannable, with immediate quickstart code; edge runtime adapters need abstraction layers to handle platform differences transparently; stream reconnection requires both automatic recovery and UI affordances (manual retry button).

---

## Table Stakes Features

### 1. Working Example Apps (SvelteKit + Remix)

**Why Expected:**
- Developers evaluating @deepagents-nextjs/sveltekit or @deepagents-nextjs/remix need proof the library works end-to-end
- Monorepo pattern (Turborepo + pnpm) requires visible, runnable output to be credible
- SvelteKit and Remix are distinct enough that a "works in Next.js" claim doesn't satisfy SvelteKit/Remix users

**What Great Looks Like:**
- **apps/sveltekit-example/** — A minimal SvelteKit chat UI that:
  - Uses `createDeepAgentsHandler` in a `+server.ts` route
  - Demonstrates reactive store from `@deepagents-nextjs/sveltekit`
  - Shows typical SvelteKit patterns (SvelteKit-idiomatic store binding, +page.svelte layout)
  - Can target both mock and real backends (environment variable gated, like apps/example)
  - Includes `src/lib/api.ts` with typed calls to the DeepAgents route
  - Has a single route (e.g., `/chat`) with no complex UI — focus on library integration, not design

- **apps/remix-example/** — A minimal Remix chat UI that:
  - Uses `createDeepAgentsHandler` in an action and loader
  - Demonstrates `useDeepAgentsChat` hook from @deepagents-nextjs/remix
  - Shows typical Remix patterns (action-driven form, hook integration)
  - Can target both mock and real backends (same pattern as SvelteKit)
  - Includes minimal route structure (`routes/chat.tsx` or similar)
  - SSE streaming via native `fetch()` + `ReadableStream` (NOT `useFetcher`, which buffers)

**Complexity:** Medium (each ~200 LOC)

**Dependencies:**
- Requires v1.2 packages to be fully built and published
- Does NOT require edge runtime adapter to exist
- Can proceed in parallel with documentation

**Success Criteria:**
- Both apps build, start locally, and stream from mock backend
- Both can target real backend when `BACKEND_URL` is set
- E2E tests in `e2e/` expand to cover both (3–5 Playwright tests per app)
- Each app has a `README.md` explaining how to run it locally

---

### 2. Extended apps/example (Multi-Adapter Demo + Auth + Custom Schemas)

**Why Expected:**
- The existing apps/example only shows basic chat; doesn't demonstrate v1.2 features
- Developers need to see how to swap adapters (langGraphAdapter vs langchainAdapter)
- `getCookieToken` and `useDeepAgentsChat<TData>` with custom schemas are not yet visible
- `DEBUG=deepagents:sse` logging is powerful but undiscovered without a demo

**What Great Looks Like:**
- **Adapter swap UI** — Toggle between `deepagentsAdapter`, `langGraphAdapter`, and `langchainAdapter`:
  - Store the selected adapter in URL query (`?adapter=langGraph`) or localStorage
  - Switch handler at request time via `createDeepAgentsHandler({ adapter: ... })`
  - Demonstrate that each adapter normalizes to identical AI SDK v6 SSE output
  - Include brief explanatory text about when to use each (e.g., "langGraphAdapter for LangGraph backends, langchainAdapter for LangChain native streaming")

- **Auth integration demo** — Show `getCookieToken`:
  - Add a mock "login" state (e.g., button that sets a fake auth cookie)
  - Pass `getToken: getCookieToken('auth_token')` to handler
  - Log the token value to browser console to show it's being extracted
  - Explain in UI: "This demo simulates an auth token in cookies — replace with your real auth mechanism"

- **Custom data schema** — Demonstrate `useDeepAgentsChat<TData>`:
  - Define a simple custom schema (e.g., `CustomDataParts<{ plan: string; status: "pending" | "complete" }>`)
  - Use it in the hook: `useDeepAgentsChat<{ plan: string; status: "pending" | "complete" }>(...)`
  - Show typed access to custom data in the UI (e.g., render `message.data.plan` with full TypeScript autocomplete)
  - Include Zod schema definition as visible code in the UI or docs link

- **Debug logging** — Add CLI env var instructions:
  - Show: "Run with `DEBUG=deepagents:sse npm run dev` to see SSE frame logs in terminal"
  - Add a toggle in UI to enable/disable client-side logging via `console.log`
  - Log frame timestamps and frame type to make SSE pipeline transparent

**Complexity:** Medium (expands apps/example by ~100–150 LOC)

**Dependencies:**
- Requires v1.2 packages fully functional
- Requires langGraphAdapter and langchainAdapter to be merged into server package
- Can proceed in parallel with SvelteKit/Remix examples

**Success Criteria:**
- Can swap adapters via UI and confirm all three work identically
- Auth token extracted from cookies without errors
- Custom schema types work in `useDeepAgentsChat` hook with full IDE autocomplete
- Debug logging visible in terminal when `DEBUG=deepagents:sse` is set

---

### 3. Package READMEs + Annotated Quickstarts

**Why Expected:**
- 271 tests exist; docs do not proportionally exist
- Every package in the monorepo needs a README explaining what it does, who should use it, and a working 5–10 line example
- Framework adapters (SvelteKit, Remix) are opaque without docs — developers need to know: "Does this hook call my server route automatically?"

**What Great Looks Like:**

Each README (`packages/*/README.md`) follows this structure with sections: one-liner description, Installation, Quick Start (annotated code), API Reference, Examples, Troubleshooting, and See Also links.

**Package-Specific Content:**

- **@deepagents-nextjs/server**
  - Handler factory pattern (`createDeepAgentsHandler`)
  - Adapter option and default transforms
  - Optional custom transforms
  - Retry policy and HTTP error codes
  - Example: Django FastAPI backends

- **@deepagents-nextjs/react**
  - Hook signature and return type
  - Discriminated union message types
  - `CustomDataParts<TData>` generic
  - Example: Basic chat, custom data rendering

- **@deepagents-nextjs/sveltekit**
  - Handler differences from server (RequestEvent param)
  - Reactive writable store API
  - Store subscription and state machine
  - Example: Route setup, store binding in component

- **@deepagents-nextjs/remix**
  - Handler differences from server (ActionFunctionArgs param)
  - Hook API (identical to @deepagents-nextjs/react)
  - SSE streaming with native fetch (NOT useFetcher)
  - Example: Route setup, hook usage in action/loader

- **@deepagents-nextjs/test-utils**
  - `createMockDeepAgentsServer()` factory
  - Mock frame generation API
  - Integration with Vitest
  - Example: Test file using the mock server

**Complexity:** Low (documentation; ~1500 total LOC across all READMEs)

**Dependencies:**
- Must document existing v1.2 API (no new implementation required)
- Requires example apps to exist (for cross-linking)

**Success Criteria:**
- Each package README is immediately scannable (header, install, quick start visible above fold)
- Quickstart code is copy-paste-able and runs without modification
- API docs are accurate (match implemented code)
- Cross-links between READMEs are correct

---

### 4. Consumer Test Suite Example

**Why Expected:**
- @deepagents-nextjs/test-utils exists and is tested internally; no user has seen it in action
- Developers building on deepagents-nextjs need a template for testing their own handlers
- The mock server API is powerful but undocumented through real-world use

**What Great Looks Like:**
- **docs/test-example.test.ts** or **packages/test-utils/examples/chat.test.ts** — A real Vitest file that:
  - Sets up `createMockDeepAgentsServer()` in `beforeEach()`
  - Writes 2–3 test cases covering:
    1. Basic message streaming (user sends text, AI responds)
    2. Custom data handling (message includes custom data part)
    3. Error recovery (mock server returns error mid-stream)
  - Uses Vitest's `describe()`, `it()`, `expect()` patterns
  - Demonstrates assertion patterns (check final message type, data values, error presence)
  - Includes comments explaining what each test validates

- **docs/TESTING.md** — A guide that:
  - Explains when to use @deepagents-nextjs/test-utils (unit-testing handlers and hooks)
  - Shows how to set up test file with imports
  - Walks through the test example step by step
  - Includes common patterns (mocking custom data, simulating errors)

**Complexity:** Low–Medium (~200 LOC code + ~300 LOC docs)

**Dependencies:**
- Requires @deepagents-nextjs/test-utils fully functional
- No other v1.3 features required
- Can proceed in parallel with READMEs

**Success Criteria:**
- Test file runs with `npm run test` in test-utils package
- All assertions pass
- TESTING.md is clear enough for a new user to write their own tests

---

## Differentiators

### 5. Edge Runtime Adapter (@deepagents-nextjs/edge)

**Why Valuable (Not Table Stakes):**
- Cloudflare Workers and Deno Deploy are becoming deployment targets for AI applications
- Current packages only support Node.js runtime
- Developers deploying to edge need the SSE proxy/handler to work there
- Edge runtime support is a credibility signal: "Production ready, not just Next.js"

**What Great Looks Like:**

A new package `@deepagents-nextjs/edge` that:

- **Exports a handler factory** similar to server but for edge runtimes
  - Input: `Request` object (not Node.js http.IncomingMessage)
  - Output: `Response` object (standard Web API)
  - Same `adapter` option, same `transforms` pipeline

- **Handles streaming with ReadableStream** (not Node.js streams):
  - Edge runtimes use Web APIs (ReadableStream) not Node streams
  - SSE frame accumulation still needed (split TCP chunks issue exists at edge too)

- **Platform abstraction** — Same code deploys to:
  - Cloudflare Workers (fetch handler)
  - Deno Deploy (fetch handler)
  - Vercel Edge Functions (fetch handler)
  - Patterns follow tRPC Fetch Adapter and Hono

**Complexity:** Medium (new package, ~800 LOC: handler, ReadableStream adapter, types, tests)

**Dependencies:**
- Must not depend on Node.js-specific APIs (fs, crypto module, etc.)
- Can depend on Web Standard APIs (fetch, ReadableStream, TextEncoder, crypto.subtle)
- Reuse SSE frame accumulation logic (port to edge-compatible version)
- Can use same transform pipeline as server package

**Success Criteria:**
- Handler builds and passes @deepagents-nextjs/edge package checks (publint, attw)
- Example Cloudflare Workers app in docs that uses the handler
- Unit tests for edge-specific code (ReadableStream handling)
- CI validates builds for edge runtime (no Node-specific code leaks)

**Deferred Details:**
- Exact platform selection (Cloudflare Workers? Deno Deploy? Both? Just document the pattern?) — flag for phase-specific research
- Whether to include example worker app in examples (depends on team capacity)

---

### 6. Stream Reconnection (STR-01 / experimental_resume)

**Why Valuable (Not Table Stakes):**
- Mobile networks drop frequently; reconnection is a real UX need
- AI SDK v6 has resume stream support
- Users expect chat to recover gracefully, not require page refresh

**What Great Looks Like:**

- **Server-side:** Handler persists active stream ID (e.g., in memory, Redis, or database depending on consumer's infrastructure)
  - When client reconnects with `Last-Event-ID` header (standard SSE), check if stream is still active
  - If active: resume from that point
  - If not: return 204 No Content (or 404) to signal client to start fresh
  - Store must be keyed by `sessionId` + `requestId` to avoid collisions

- **Hook-side:** `useDeepAgentsChat` accepts `experimental_resume: true`
  - On mount, checks if there's an active stream for this sessionId
  - If yes: resumes silently
  - If no: starts fresh stream

- **UI affordances:**
  - **Automatic recovery** — Stream drops → hook auto-reconnects silently (no UI change if < 2 seconds)
  - **Manual retry button** — Shows only if auto-reconnect fails 2+ times
    - Button text: "Continue generating"
    - Triggers `reload()` to restart from last message boundary
  - **Visual feedback** — Shows reconnection state briefly ("Reconnecting…" message or loading indicator)

- **Error states:**
  - Network gone for > 30 seconds: Show "Connection lost. Try again?" button
  - Server has no record of stream: Show "Your session expired. Restart conversation?" button
  - Partial message received: Keep partial on screen, append completed message on reconnect

**Complexity:** High (both server-side persistence + client-side state management, ~600 LOC new hook code, ~200 LOC server integration)

**Dependencies:**
- **BLOCKED:** Requires AI SDK bug fixes upstream (#6502, #9707)
- Current AI SDK v6 does NOT reliably support resume streams; conditional on upstream fix
- Can prototype with mock backend before upstream fix lands

**Success Criteria:**
- Hook accepts `experimental_resume` option without errors
- Client auto-reconnects when network drops
- Manual retry button appears when auto-reconnect exhausted
- Partial messages are not lost on reconnect
- E2E tests cover reconnection scenarios (simulate network drop)

**Research Flag (Phase-Specific):**
- Check AI SDK issues #6502 and #9707 at v1.3 kickoff
- If not fixed: Document as "experimental" and require consumer opt-in
- If fixed: Promote from experimental to stable in v1.4

---

## Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full chat UI components (buttons, avatars, styling) | Transport + types only; UI is consumer's responsibility | Document clear patterns in example apps; let consumers design UI |
| Automatic component generation from schemas | Adds coupling between data schemas and UI components | Example apps show manual rendering patterns; consumers extend |
| WebSocket support | DeepAgents protocol is SSE-only; complexity not justified | Document why SSE is the right choice for this use case |
| Streaming to localStorage or state persistence | Provider-specific concern; beyond library scope | Document pattern in testing guide; consumers implement |
| CLI scaffolding or init tools | Handler factory covers one-line setup | Link to example apps as templates; don't add tool maintenance burden |
| Pages Router support for Next.js | App Router is standard; Pages Router is legacy | Clearly state "App Router only" in docs |

---

## Feature Dependencies

Extended example apps and documentation depend on v1.2 packages being fully built. SvelteKit/Remix example apps can proceed in parallel with documentation. Edge runtime adapter is optional and can be deferred. Stream reconnection is blocked on upstream AI SDK bug fixes and is experimental.

Execution order should prioritize extended apps/example (lowest risk), then package READMEs (no code dependency), then SvelteKit/Remix examples (new but using tested code), then test utilities guide, then edge runtime (if doing), then stream reconnection (conditional).

---

## MVP Recommendation

**v1.3 Phase 1 (must-have for release):**
1. Extended apps/example with adapter swap + auth + custom schemas
2. Package READMEs for all 5 existing packages
3. Consumer test suite example + TESTING.md guide
4. apps/sveltekit-example (minimal chat UI)
5. apps/remix-example (minimal chat UI)
6. E2E tests covering all three apps (Playwright)

**v1.3 Phase 2 (nice-to-have, defer if time-constrained):**
1. Edge runtime adapter (@deepagents-nextjs/edge)
2. Stream reconnection (if AI SDK upstream fixes are ready)

**Rationale:**
- Phase 1 completes the documentation and example story; users can learn by reading code
- Phase 1 doesn't require new framework/runtime abstractions (lower risk)
- Phase 2 adds platform coverage (edge) and reliability (reconnection); both require external dependencies or high complexity
- Deferring Phase 2 doesn't block 1.3 release; both are "nice-to-have" — Phase 1 is the critical path

---

## Confidence Assessment

| Area | Level | Reasoning |
|------|-------|-----------|
| Table stakes identification | HIGH | OSS library conventions for examples/docs are well-established; web search confirmed patterns across Vercel AI SDK, Hono, tRPC |
| Example app structure | MEDIUM | SvelteKit/Remix conventions are documented; but deepagents-nextjs-specific patterns (adapter demo, auth integration) require validation in implementation |
| Package README expectations | MEDIUM | npm best practices are clear; but deepagents-nextjs API surface is unique (transforms pipeline, custom data schemas) — will refine during writing |
| Consumer test patterns | MEDIUM | Vitest patterns are standard; but createMockDeepAgentsServer API requires validation against real usage (not just unit tests) |
| Edge runtime | MEDIUM | tRPC fetch adapter and Hono patterns are proven; but SSE-specific stream accumulation in edge environment needs validation (streaming ReadableStream behavior differs from Node) |
| Stream reconnection | MEDIUM | AI SDK v6 resume streams documented but bugs #6502/#9707 are blockers; UI affordances (manual retry button) are standard but experimental_resume behavior needs validation |

---

## Gaps to Address

- **Phase-specific research needed:**
  - Which edge runtimes to target first (Cloudflare Workers? Deno Deploy? Both?)? Depends on target audience
  - Stream reconnection: Is `experimental_resume` the right abstraction, or does it need consumer persistence layer?
  - Should test example be in docs/ or in test-utils package? Depends on publishing strategy

- **Deferred validation:**
  - Edge runtime SSE accumulation behavior in edge runtimes (only validate in implementation)
  - Custom schema rendering patterns (will emerge during extended app/example building)
  - Actual reconnection timing/backoff strategy (AI SDK bug fixes needed first)

- **Dependency assumptions:**
  - AI SDK v6 bug fixes (#6502, #9707) — need to re-verify at v1.3 kickoff
  - Whether consumers will actually want edge runtime support (may be overestimated; could be Phase 2+ only)

---

## Sources

- [Vercel AI SDK Documentation](https://ai-sdk.dev/docs/introduction)
- [Vercel AI SDK - Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
- [Vercel AI SDK - Error Handling](https://ai-sdk.dev/docs/ai-sdk-ui/error-handling)
- [tRPC Fetch Adapter](https://trpc.io/docs/server/adapters/fetch)
- [Hono - Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Server-Sent Events Best Practices](https://shopify.engineering/server-sent-events-data-streaming)
- [MDN - Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [SvelteKit Project Structure](https://kit.svelte.dev/docs/project-structure)
- [npm Package README Documentation](https://docs.npmjs.com/about-package-readme-files/)
- [OSS Documentation Best Practices](https://programming.dev/post/47812236)
- [Turborepo - SvelteKit Examples](https://turborepo.dev/docs/guides/frameworks/sveltekit)
- [Edge Computing with Cloudflare Workers](https://www.postry.com.br/en/blog/edge-computing-cloudflare-workers-guide)
- [Stream Reconnection and Automatic Retry Patterns](https://getstream.io/blog/websocket-sse/)
- [Vitest Testing Framework](https://vitest.dev/guide/)
