# deepagents-nextjs

Profile: library

## What This Is

An open-source npm monorepo that bridges any DeepAgents-compatible backend (Django, FastAPI) with the Vercel AI SDK v6 in Next.js, SvelteKit, and Remix applications. It ships framework-specific scoped packages — `@deepagents-nextjs/server`, `@deepagents-nextjs/react`, `@deepagents-nextjs/sveltekit`, `@deepagents-nextjs/remix`, and `@deepagents-nextjs/test-utils` — with reference backend implementations proving the protocol is backend-agnostic.

## Core Value

A developer can wire up DeepAgents end-to-end in two lines of code — one server route, one hook — and get fully typed messages out of the box, in their framework of choice.

## Current Milestone: v1.7 Blazing Workspace Provider

**Goal:** Wire up the Blazing workspace sandbox provider so open-swe agents can execute code in ephemeral container workspaces backed by Blazing infrastructure — replacing the placeholder `BlazingSandbox` stub with a working integration against the real `/v1/workspace` REST API.

**Target features:**
- **Blazing REST API** — merge blazing PR #81 (7-endpoint `/v1/workspace` REST surface, already hardened with 56 tests)
- **BlazingSandbox adapter** — rewrite the TypeScript stub to match the real API contract (URL paths, DTO shapes, auth headers, error mapping)
- **Provider wiring** — connect `getSandbox()` so `BLAZING_API_URL` env var activates the real Blazing provider
- **Integration tests** — mock-based test suite validating all 7 endpoints + live local smoke against a running blazing instance

**Design boundary:** This milestone covers both repos (blazing + lang-nextjs) as one milestone. The blazing REST API is already built (PR #81); the work here is landing it and consuming it correctly from TypeScript.

## Current State (v1.5)

- `@deepagents-nextjs/server` — `createDeepAgentsHandler()`, SSE transform pipeline, named adapters (`deepagentsAdapter`, `langGraphAdapter`, `langchainAdapter`, `openSweAdapter`), retry policy, `getCookieToken()`, debug logging, approval gating (`createApprovalGatingTransform`, `createApprovalRoutes`), SSE heartbeat (`createHeartbeatStream`)
- `@deepagents-nextjs/react` — `useDeepAgentsChat<TData>()`, typed message union + `CustomDataParts<TData>` generic, Zod schemas
- `@deepagents-nextjs/sveltekit` — SvelteKit handler + reactive writable store
- `@deepagents-nextjs/remix` — Remix handler + streaming React hook
- `@deepagents-nextjs/edge` — `createDenoHandler()` + `createCloudflareHandler()` (EXPERIMENTAL) using Web Streams API only
- `@deepagents-nextjs/test-utils` — `createMockDeepAgentsServer()` for consumer test suites
- `packages/mcp` — MCP server with `trigger_task`, `list_runs`, `get_run_status`, `cancel_run` tools
- `apps/example/` — live example app, mock + real backend modes, adapter swap UI
- `apps/open-swe/` — Next.js dashboard: task submission, run list, live streaming, tool card visualization
- `apps/django-backend/` + `apps/fastapi-backend/` — reference implementations
- CI — `ci.yml` (build/test/typecheck/validate + dist leak guards) + `e2e.yml` (mocked 4-server suite + django + fastapi)
- Test suite: 584 unit tests across 6 packages + 19 E2E Playwright tests across 4 projects

## Requirements

### Validated

- ✓ **PKG-01** — pnpm workspaces + Turborepo with correct build order — v1.0
- ✓ **PKG-02** — dual ESM/CJS tsup output with correct `exports` field and `.d.ts` files — v1.0
- ✓ **SRV-01** — `createDeepAgentsHandler({ backendUrl, getToken?, transforms? })` in one line — v1.0
- ✓ **SRV-02** — SSE proxy with `x-vercel-ai-ui-message-stream: v1` header — v1.0
- ✓ **SRV-03** — configurable `transforms[]` pipeline, `(frame) => frame | null` — v1.0
- ✓ **SRV-04** — `defaultTransforms` strips `messageId` from `finish` events — v1.0
- ✓ **SRV-05** — `SseFrameAccumulator` handles frames split across TCP chunks — v1.0
- ✓ **SRV-06** — 502 on unreachable backend, 500 on mid-stream error — v1.0
- ✓ **RCT-01** — `useDeepAgentsChat({ sessionId, endpoint })` returns typed messages + controls — v1.0
- ✓ **RCT-02** — `(UserMessage | AIMessage | ToolCallMessage | ErrorMessage)[]` discriminated union — v1.0
- ✓ **RCT-03** — Zod schemas for `data-plan`, `data-task`, `data-file`, `data-approval` — v1.0
- ✓ **RCT-04** — React and Zod as `peerDependencies`, no duplicate instances — v1.0
- ✓ **EX-01** — `apps/example/` streams from mock backend, no real DeepAgents required — v1.0
- ✓ **PKG-03** — Changesets + OIDC npm publish workflow — v1.0
- ✓ **PKG-04** — `publint` and `attw` pass in CI — v1.0
- ✓ **E2E-01** — `apps/django-backend/` emits DeepAgents SSE wire format via StreamingHttpResponse — v1.1
- ✓ **E2E-02** — `apps/fastapi-backend/` emits same SSE wire format via StreamingResponse — v1.1
- ✓ **E2E-03** — `apps/example/` uses `createDeepAgentsHandler` when `BACKEND_URL` set; mock preserved — v1.1
- ✓ **E2E-04** — Playwright E2E suite validates SSE delivery + messageId strip + clean close — v1.1
- ✓ **E2E-05** — CI `e2e-django` + `e2e-fastapi` jobs run on every PR — v1.1
- ✓ **ADAPT-01** — `adapter` option to `createDeepAgentsHandler`; pipeline `[...adapter.transforms, ...options.transforms]` — v1.2
- ✓ **ADAPT-02** — `deepagentsAdapter` as default; `defaultTransforms` kept as `@deprecated` alias — v1.2
- ✓ **ADAPT-03** — `langGraphAdapter` normalizes LangGraph `astream_events v2` → AI SDK v6 — v1.2
- ✓ **ADAPT-04** — `langchainAdapter` normalizes LangChain native SSE → AI SDK v6 — v1.2
- ✓ **STR-02** — retry policy with exponential backoff; mid-stream failures not retried — v1.2
- ✓ **DX-01** — `DEBUG=deepagents:sse` SSE frame logging to stderr — v1.2
- ✓ **DX-02** — `createMockDeepAgentsServer()` in `@deepagents-nextjs/test-utils` — v1.2
- ✓ **DX-03** — `useDeepAgentsChat<TData>()` generic + `CustomDataParts<TData>` mapped type — v1.2
- ✓ **AUTH-01** — `getCookieToken(cookieName)` returns `getToken`-compatible function — v1.2
- ✓ **FWK-01** — `@deepagents-nextjs/sveltekit` handler + reactive store — v1.2
- ✓ **FWK-02** — `@deepagents-nextjs/remix` handler + `useDeepAgentsChat` hook — v1.2

### Validated (v1.5)

- ✓ **ADAPT-03** — `openSweAdapter` emits SSE heartbeat frames every 15–30s on idle to prevent timeout — v1.5
- ✓ **ADAPT-04** — Parallel tool calls reordered correctly by `tool_call_id` before emission — v1.5
- ✓ **ADAPT-05** — Approval gating: `data-approval-required` frame; run pauses until explicit approve/reject — v1.5
- ✓ **DASH-01** — `POST /api/open-swe/runs` accepts task description, returns `run_id` — v1.5
- ✓ **DASH-02** — `GET /api/open-swe/runs` returns run list with status, time, task — v1.5
- ✓ **DASH-03** — `GET /api/open-swe/runs/[runId]/stream` delivers live SSE agent output — v1.5
- ✓ **DASH-04** — Tool call card expansion shows full input/output JSON — v1.5
- ✓ **DASH-05** — Concurrent stream isolation — no event leakage between run views — v1.5
- ✓ **MCP-01** — `trigger_task` MCP tool returns `run_id` immediately — v1.5
- ✓ **MCP-02** — `list_runs` MCP tool returns structured run array — v1.5
- ✓ **MCP-03** — `get_run_status` MCP tool returns status without polling — v1.5
- ✓ **MCP-04** — `cancel_run` MCP tool returns cancellation confirmation — v1.5
- ✓ **E2E-11** — `retry()` after mid-stream interruption resumes without duplication — v1.5
- ✓ **CI-01** — `pnpm test:e2e` + GitHub Actions e2e job on every PR — v1.5

### Active (v1.7 — Blazing Workspace Provider)

<!-- Scoped requirements defined in REQUIREMENTS.md; populated by roadmap. -->

- [ ] Blazing `/v1/workspace` REST API merged and available
- [ ] BlazingSandbox TypeScript adapter matching real API contract
- [ ] Provider factory wired (BLAZING_API_URL activates Blazing provider)
- [ ] Integration test coverage (mock + live local)

### Out of Scope

- Full chat UI components — transport + types only; UI is the consumer's responsibility
- DeepAgents backend itself — this is the frontend glue layer only
- Pages Router support — App Router only; Pages Router is legacy
- CLI/init scaffolding — handler factory covers one-line setup without it
- WebSocket transport — SSE is the DeepAgents protocol

## Context

- Extracted from an existing production project (`stsfront`) where the glue was built organically
- The core mismatch: DeepAgents backends send `messageId` in SSE `finish` events; AI SDK v6 rejects it — `defaultTransforms` fixes this
- Both reference backends use LangGraph (`create_react_agent`) with `astream_events v2` — the LangGraph pattern is now the canonical integration point
- The transform pipeline follows the Open/Closed Principle: ship known fixes as defaults, let consumers extend for future backend quirks
- Target audience: developers already using or evaluating DeepAgents as their AI backend (Next.js, SvelteKit, Remix)
- LLM routing via `openrouter/free` (auto-routes to best available free model; overridable via `OPENROUTER_MODEL`)
- Stream reconnection (STR-01) deferred to v1.3 — depends on AI SDK upstream bugs #6502 and #9707

## Constraints

- **Tech stack**: pnpm workspaces + Turborepo; TypeScript; Zod v4; AI SDK v6 (`ai`, `@ai-sdk/react`)
- **Server package**: Pure Node.js, no React dependency — importable in server environments without client-side bloat
- **React package**: Peer-depends on React 18/19 and AI SDK v6
- **Framework packages**: Each framework package avoids importing from `@deepagents-nextjs/react` or `next` — SseFrameAccumulator copied to prevent peerDep leakage
- **Compatibility**: Next.js App Router (v14+), SvelteKit, Remix — Node runtime for all v1.x packages

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Monorepo with scoped packages (`@deepagents-nextjs/server` + `@deepagents-nextjs/react` + framework packages) | Mirrors AI SDK's own structure; avoids bundling React in server environments | ✓ Good — clean separation, no duplicate React |
| Configurable transforms pipeline | Reduces maintenance burden; consumers extend without waiting for package release | ✓ Good — Open/Closed; messageId strip proved in E2E |
| Handler factory pattern (`createDeepAgentsHandler`) | One-line server setup; idiomatic App Router pattern | ✓ Good — confirmed in example app and framework packages |
| `SseTransform = (frame) => frame \| null` — null drops the frame | Simple, composable, easy to test in isolation | ✓ Good — stateless and independently testable |
| `"type": "commonjs"` + `outExtension` in tsup | Makes `.js` = CJS and `.mjs` = ESM; required for publint to pass | ✓ Good — publint clean |
| No root `vitest.workspace.ts` | Deprecated in Vitest 3.2+; per-package configs correct with Turborepo | ✓ Good |
| `moduleResolution: bundler` in tsconfig.base.json | No `.js` extensions required on imports; compatible with tsup | ✓ Good |
| Manual DATABASE_URL parser in Django backend | Avoids dj-database-url dependency | ✓ Good — fewer deps |
| LangGraph `astream_events v2` for SSE streaming | Standard LangGraph pattern; works identically in Django and FastAPI | ✓ Good — backend-agnostic confirmed |
| Lazy `_get_graph()` in Django vs lifespan in FastAPI | Django: per-request (avoids import cost); FastAPI: startup (reused across requests) | ✓ Good — appropriate to each framework |
| `head.repo.full_name == repository` for external PR skip | No `environment:` protection rules needed (requires paid plans for private repos) | ✓ Good — fork-safe, no paid plan required |
| `openrouter/free` as default LLM router | Auto-routes to best available free model; no manual model pinning | ✓ Good — resilient to individual model deprecations |
| Named adapter bundles (`SseAdapter = { name, transforms }`) | Composable, testable, consumer-replaceable; default adapter is deepagentsAdapter | ✓ Good — langGraphAdapter/langchainAdapter ship independently |
| Adapter pipeline order `[...adapter.transforms, ...options.transforms]` | Adapter normalizes first, user overrides after — predictable ordering | ✓ Good — matches mental model |
| `fetchWithRetry` internal to handler (not exported) | Retry is handler-level concern; consumers configure via options, not by calling utility | ✓ Good — simpler API surface |
| SseFrameAccumulator copied to sveltekit/remix (not imported from server) | Prevents `next` peerDep from leaking into non-Next.js framework packages | ✓ Good — clean package boundaries |
| SvelteKit/Remix handlers have NO default adapter (clean proxy) | Server handler defaults to deepagentsAdapter; framework packages are transparent proxies | ✓ Good — consistent with design intent |
| Remix hook uses native `fetch()` + ReadableStream (NOT `useFetcher`) | `useFetcher` buffers full response before resolving — cannot stream SSE | ✓ Good — SSE streaming requires streaming reader |
| `queueMicrotask` in SvelteKit store StartStopNotifier | Svelte's writable calls start function synchronously — defer to let subscribers see idle state first | ✓ Good — state machine integrity |
| STR-01 deferred to v1.3 | AI SDK bugs #6502 and #9707 confirmed open 2026-05-02; conditional requirement | — Pending — re-evaluate at v1.3 kickoff |
| MCP tools extend packages/mcp (not new package) | Avoids package proliferation; tools follow existing `server.tool()` registration pattern | ✓ Good — all 4 tools fit cleanly into existing createDeepAgentsMcpServer factory |
| `encodeURIComponent(runId.trim())` in MCP tool URL paths | Prevents path injection attacks (e.g., `run/evil` → `run%2Fevil`) | ✓ Good — security property verified by test |
| backendRequest throws on non-ok responses | 502 test assertions pass naturally without explicit error handling in tools | ✓ Good — consistent with existing proxy pattern |
| AbortError returns `isError: true` (not rethrow) in MCP tools | MCP callers receive structured errors; unhandled throws bypass the tool response envelope | ✓ Good — agent-friendly error surface |

---
*Last updated: 2026-06-08 — started v1.7 Blazing Workspace Provider milestone*
