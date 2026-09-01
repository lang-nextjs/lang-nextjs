# deepagents-nextjs

Profile: reference-template

## What This Is

One forkable reference implementation of the **LangChain agent ladder** — the five rungs a team climbs as an agent product matures, from a single LLM call to an autonomous software-developer agent. The repo shows all five rungs working against the same transport, in the same codebase, so the step from one rung to the next is a diff you can read rather than a rewrite you have to imagine.

It is a template to fork, not a dependency to install. `pnpm eject <rung>` (v2.0) deletes the other four rungs and leaves a coherent, self-contained repo for the one you chose.

The transport layer underneath — SSE proxying, adapters, typed messages, framework packages — is real, tested, and production-shaped. It is the substrate the ladder is taught on, not a separate product.

## Core Value

A developer can see all five rungs of the agent ladder running side by side against one transport, pick the rung that matches where their product actually is, eject the rest, and be left with a repo they own and understand end to end.

## The Agent Ladder

| #   | Rung                       | What it demonstrates                                         | Plane         |
| --- | -------------------------- | ------------------------------------------------------------ | ------------- |
| 1   | `langchain`                | Single-model calls, prompt/response, basic chains            | Python (v2.0) |
| 2   | `langgraph`                | Explicit graph state, branching, cycles, checkpointing       | Python (v2.0) |
| 3   | `deepagents`               | Planning + sub-agents + virtual filesystem over a graph      | Python (v2.0) |
| 4   | `open-swe`                 | Long-running async runs, approval gating, live run dashboard | TypeScript    |
| 5   | `software-developer-agent` | Autonomous code execution in ephemeral sandboxed workspaces  | TypeScript    |

The ladder is the product. The rungs are ordered by capability, and each one is a superset of the concerns below it — that ordering is the teaching, and it should survive any future reorganization of the repo.

**Language planes:** rungs 1–3 run in Python today (the `apps/django-backend` and `apps/fastapi-backend` reference stacks). Rungs 4–5 are TypeScript regardless of plane, per the ruling on #23. All five rungs ship in v2.0. A **second, TypeScript agent plane for rungs 1–3 is deferred to v2.1 — deferred, not cancelled.** What defers is a second language plane for the lower rungs, not any rung itself.

## Ejection

`pnpm eject <rung>` is the mechanism that makes this a template rather than a demo gallery. Given a rung, it removes the other four rungs' apps, backends, routes, docs and tests, and leaves a repo that builds, tests and runs clean with no dangling references to what it deleted.

Ejection is **v2.0 work — it does not exist yet.** It is recorded here because it is the load-bearing product decision, not because it is implemented.

## Current Milestone: v2.0 — Reference Template

**Goal:** Reframe the repo from a publishable package library into a forkable reference template for the five-rung agent ladder, and build the ejection mechanism that makes forking coherent.

v1.7 (Blazing Workspace Provider) shipped complete — 12/12 requirements, all phases 21–25 verified. See MILESTONES.md.

> **Scope note:** v2.0 requirements are not yet enumerated in a roadmap. This section records the milestone's _subject and boundaries_ as ruled to date; it does not stand in for `/nf:plan-phase` output. Requirements below remain the v1.7 set until a v2.0 roadmap lands.

## Current State (v1.7)

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

**Distribution status:** all 7 packages are unpublished, at 0.1.0, with zero external consumers. The OIDC npm publish workflow was deleted in #20; the packages are being marked private in #27. Nothing in this repo is consumed via npm.

## Requirements

> **KNOWN AND DELIBERATE: `ADAPT-03` and `ADAPT-04` each name TWO different requirements** —
> one from v1.2, one from v1.5. The milestone is shown inline on those rows.
>
> **This is not "the duplication is fine."** It is that the duplication already happened and
> every available repair costs more than it recovers. Renumbering the v1.5 pair makes every
> v1.5 document citing ADAPT-03 resolve to the v1.2 requirement; renumbering the v1.2 pair does
> the same in reverse. **Either way one archive lies silently — the reference still resolves,
> just to the wrong thing.** An ambiguity a reader can see beats a wrong answer they cannot.
>
> Requirement ids are historical keys and are not rewritten (#207). A duplicated key is not an
> exception to that rule — it is the case that most tempts you to break it.
>
> `pnpm traceability` allowlists exactly these two and **refuses any NEW duplicate.**

### Validated

- ✓ **PKG-01** — pnpm workspaces + Turborepo with correct build order — v1.0
- ✓ **PKG-02** — dual ESM/CJS tsup output with correct `exports` field and `.d.ts` files — v1.0
- ✓ **SRV-01** — `createDeepAgentsHandler` returns a Next.js App Router POST handler from `backendUrl` alone, with `getToken`, `transforms` and `adapter` all optional — verified by `packages/server/src/readme-quickstart.test.ts` "exact snippet compiles, runs, and returns a handler function" — v1.0
- ✓ **SRV-02** — SSE proxy with `x-vercel-ai-ui-message-stream: v1` header — v1.0 — verified by `packages/server/src/handler.test.ts` "forwards x-vercel-ai-ui-message-stream header from backend"
- ✓ **SRV-03** — configurable `transforms[]` pipeline, `(frame) => frame | null` — v1.0 — verified by `packages/server/src/stream-transform.core.test.ts` "drops a frame when a transform returns null"
- ✓ **SRV-04** — `defaultTransforms` strips `messageId` from `finish` events — v1.0 — verified by `packages/server/src/transforms.test.ts` "strips messageId from finish SSE frames"
- ✓ **SRV-05** — `SseFrameAccumulator` handles frames split across TCP chunks — v1.0 — verified by `packages/server/src/accumulator.test.ts` "push() handles frame split across two chunks (TCP split edge case)"
- ✓ **SRV-06** — 502 on unreachable backend, 500 on mid-stream error — v1.0
- ✓ **RCT-01** — `useDeepAgentsChat({ sessionId, endpoint })` returns typed messages + controls — v1.0 — verified by `packages/react/src/hook.test.ts` "returns messages, sendMessage, status, error"
- ✓ **RCT-02** — `(UserMessage | AIMessage | ToolCallMessage | ErrorMessage)[]` discriminated union — v1.0 — verified by `packages/react/src/types.test.ts` "Message discriminated union narrows correctly by type field"
- ✓ **RCT-03** — Zod schemas for `data-plan`, `data-task`, `data-file`, `data-approval` — v1.0 — verified by `packages/react/src/schemas.test.ts` "G2 — every declared part has a fixture, so none is silently skipped"
- ✓ **RCT-04** — React and Zod as `peerDependencies`, no duplicate instances — v1.0
- ✓ **EX-01** — `apps/example/` streams from mock backend, no real DeepAgents required — v1.0 — verified by `apps/example/example.test.ts` "accumulates messages from SSE stream"
- ✓ **E2E-01** — `apps/django-backend/` emits DeepAgents SSE wire format via StreamingHttpResponse — verified by `apps/django-backend/tests/test_response_wire_format.py` "test_the_frames_actually_reach_the_client" — v1.1
- ✓ **E2E-02** — `apps/fastapi-backend/` and `apps/django-backend/` each answer a streamed chat request with `content-type: text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`, and a frame sequence that validates against `docs/sse-frame-schema.json` and terminates in a `finish` frame — v1.1
- ✓ **E2E-03** — `apps/example/`'s chat route proxies to a configured backend — `FASTAPI_URL` or `DJANGO_URL` when set, otherwise `BACKEND_URL` used as the complete endpoint URL — and serves the in-process mock route when none of the three is set — v1.1
- ✓ **E2E-04** — the Playwright suite drives `POST /api/chat/stream` and receives at least one `text-delta` frame — v1.1 — verified by `e2e/shared/chat.spec.ts` "SSE stream delivers at least one text-delta frame"
- ✓ **E2E-12** — the `finish` frame reaches the client with no `messageId` — v1.1 — verified by `e2e/shared/chat.spec.ts` "finish frame has no messageId on the client side (defaultTransforms stripped it)"
- ✓ **E2E-13** — the stream closes with no error frame — v1.1 — verified by `e2e/shared/chat.spec.ts` "stream closes cleanly — no error frames"
- ✓ **E2E-05** — CI `e2e-django` + `e2e-fastapi` jobs run on every SAME-REPO PR (and every push to main) — v1.1. They are skipped on fork PRs, which cannot reach the secrets they need; `e2e-fork-coverage` reports that absence rather than leaving two jobs quietly missing from a green check list (#218).
- ✓ **ADAPT-01** — `adapter` option to `createDeepAgentsHandler`; pipeline `[...adapter.transforms, ...options.transforms]` — v1.2 — verified by `packages/server/src/adapter-pipeline-order.test.ts` "records both stages, so the order is in the result rather than inferred"
- ✓ **ADAPT-02** — `deepagentsAdapter` as default; `defaultTransforms` kept as `@deprecated` alias — v1.2
- ✓ **ADAPT-03** (v1.2) — `langGraphAdapter` normalizes LangGraph `astream_events v2` → AI SDK v6 — verified by `packages/server/src/adapters/langgraph.test.ts` "first on_chat_model_stream emits text-start + text-delta as a compound frame" — v1.2
- ✓ **ADAPT-04** (v1.2) — `langchainAdapter` normalizes LangChain native SSE → AI SDK v6 — v1.2 — verified by `packages/server/src/adapters/langchain.test.ts` "converts all four token frames from fixture correctly"
- ✓ **STR-02** — the retry policy waits `initialDelayMs * 2^attempt` between attempts — v1.2 — verified by `packages/server/src/handler.test.ts` "waits initialDelayMs \* 2^attempt between retries (exponential backoff)"
- ✓ **STR-03** — a failure after the stream has opened is not retried; only the initial `fetch()` is — v1.2 — verified by `packages/server/src/handler.test.ts` "does not retry mid-stream failures — only initial fetch() is retried (SRV-RETRY)"
- ✓ **DX-01** — `DEBUG=deepagents:sse` SSE frame logging to stderr — v1.2 — verified by `packages/server/src/handler.test.ts` "calls console.error when DEBUG=deepagents:sse and frame has data line"
- ✓ **DX-02** — `createMockDeepAgentsServer()` in `@deepagents-nextjs/test-utils` — v1.2 — verified by `packages/test-utils/src/public-api.test.ts` "exports the full documented surface: createMockDeepAgentsServer named export + options type"
- ✓ **DX-03** — `useDeepAgentsChat<TData>()` generic + `CustomDataParts<TData>` mapped type — v1.2
- ✓ **AUTH-01** — `getCookieToken(cookieName)` returns `getToken`-compatible function — v1.2 — verified by `packages/server/src/public-api.test.ts` "getCookieToken is a factory returning a (NextRequest) => string|null"
- ✓ **FWK-01** — `@deepagents-nextjs/sveltekit` exposes a handler that answers with `content-type: text/event-stream` — v1.2 — verified by `packages/sveltekit/src/handler.test.ts` "handler returns Response with content-type: text/event-stream"
- ✓ **FWK-03** — `@deepagents-nextjs/sveltekit` exposes a reactive store that accumulates messages from SSE data frames — v1.2 — verified by `packages/sveltekit/src/store.test.ts` "store accumulates messages from SSE data frames"
- ✓ **FWK-02** — `@deepagents-nextjs/remix` exposes a handler that answers with `content-type: text/event-stream` — v1.2 — verified by `packages/remix/src/handler.test.ts` "handler returns Response with content-type: text/event-stream"
- ✓ **FWK-04** — `@deepagents-nextjs/remix` exposes a `useDeepAgentsChat` hook that accumulates messages from SSE data frames — v1.2 — verified by `packages/remix/src/hook.test.ts` "hook accumulates messages from SSE data: frames"

### Validated (v1.5)

- ✓ **ADAPT-03** (v1.5) — `openSweAdapter` emits SSE heartbeat frames every 15–30s on idle to prevent timeout — verified by `packages/server/src/adapters/openSweHeartbeat.test.ts` "emits a heartbeat comment frame when upstream is idle beyond intervalMs" — v1.5
- ✓ **ADAPT-04** (v1.5) — Parallel tool calls reordered correctly by `tool_call_id` before emission — v1.5 — verified by `packages/server/src/adapters/openSwe.test.ts` "drains a [c,a,b] arrival permutation of three different tools in start order a,b,c"
- ⚠ **ADAPT-05** — Approval gating: `data-approval-required` frame; the STREAM pauses until
  explicit approve/reject. The run does NOT pause — the tool executes upstream and the
  transform withholds its frames, not its effect. Marked satisfied in v1.5 on evidence that
  three symbols were exported; see #450 — v1.5
- ✓ **ADAPT-06** — FastAPI backend approval gate: a gated tool's SIDE EFFECT is withheld until a decision arrives, and released when the decision is approve. Distinct from ADAPT-05, which is the proxy withholding FRAMES downstream of a tool that already ran; this is the backend's own gate, upstream, withholding the effect itself — v2.0 — verified by `apps/fastapi-backend/tests/test_approval_withholds.py` "test_an_approved_call_is_then_executed"
- ✓ **DASH-01** — `POST /api/open-swe/runs` accepts task description, returns `run_id` — v1.5 — verified by `apps/open-swe/app/api/open-swe/runs/route.test.ts` "returns 201 with run_id when task is valid"
- ✓ **DASH-02** — `GET /api/open-swe/runs` returns run list with status, time, task — v1.5
- ✓ **DASH-03** — `GET /api/open-swe/runs/[runId]/stream` delivers live SSE agent output — v1.5 — verified by `apps/open-swe/app/api/open-swe/runs/[runId]/stream/route.test.ts` "DELIVERS the agent output: the SSE payload reaches the caller, not just the headers"
- ✓ **DASH-04** — Tool call card expansion shows full input/output JSON — v1.5 — verified by `apps/open-swe/components/ToolCard.test.tsx` "shows input and output payload when expanded"
- ✓ **DASH-05** — two concurrent run views do not cross-wire their `EventSource` connections; an event delivered to one view does not appear in the other — v1.5 — verified by `e2e/rungs/open-swe/open-swe.spec.ts` "DASH-05: concurrent run pages do not leak events between streams"
- ✓ **DASH-07** — `GET /api/open-swe/runs/[runId]/stream` serves two concurrent runs without delivering either run's events to the other — v1.5
- ✓ **MCP-01** — `trigger_task` MCP tool returns `run_id` immediately — verified by `packages/mcp/src/index.test.ts` "MCP-01 trigger_task returns IMMEDIATELY — one request, while the run is still not complete" — v1.5
- ✓ **MCP-02** — `list_runs` MCP tool returns structured run array — verified by `packages/mcp/src/index.test.ts` "MCP-02 list_runs returns a structured array of runs, not a text blob" — v1.5
- ✓ **MCP-03** — `get_run_status` MCP tool returns status without polling — verified by `packages/mcp/src/index.test.ts` "MCP-03 get_run_status returns the status WITHOUT POLLING — exactly one GET, no loop" — v1.5
- ✓ **MCP-04** — `cancel_run` MCP tool returns cancellation confirmation — verified by `packages/mcp/src/index.test.ts` "MCP-04 cancel_run POSTs the cancellation and returns the resulting status" — v1.5
- ✓ **E2E-11** — `retry()` after mid-stream interruption resumes without duplication — verified by `e2e/shared/reconnect.spec.ts` "real mid-stream socket abort: hook leaves streaming state, then retry against healthy server recovers without duplicating partial content" — v1.5
- ✓ **CI-01** — `pnpm test:e2e` + GitHub Actions e2e job on every PR — v1.5

### Active (v2.0 — Reference Template)

<!-- Scoped requirements to be defined in REQUIREMENTS.md; populated by roadmap. -->

- [ ] Five-rung ladder present and runnable in one repo
- [ ] `pnpm eject <rung>` leaves a coherent, building, passing repo
- [ ] UI components sufficient to demonstrate each rung
- [ ] Packages marked private; publish path fully retired (#27)

### Retired

Withdrawn requirements are kept rather than deleted. A charter edited without provenance is
worse than one contradicted — the contradiction is at least visible — so these stay on the
record with the decision that removed them. **They are not tracked, not validated, and not
expected to become true.** They carry no ✓ because nothing verifies them and nothing is meant
to: a citation would need a test, and there is nothing to test.

- **PKG-03** — Changesets + OIDC npm publish workflow — **retired in #20.** The publish
  workflow was deleted; packages go private in #27.
- **PKG-04** — `publint` and `attw` pass in CI — **retired in #20** alongside PKG-03; devDeps
  removed in #2. Verified on `main`: neither tool is a dependency, a script, or named in any
  workflow. Nothing runs them, so nothing passes them — which the row asserted while still
  carrying a ✓.

### Out of Scope

> **Changed in v2.0.** Two long-standing exclusions — chat UI components, and CLI/init scaffolding — were **removed**, because the v2.0 milestone builds exactly those things. See **Charter Provenance** below for who decided this and on what basis. Do not treat the removal as editorial cleanup.

- DeepAgents backend itself — the agent frameworks are upstream; this repo integrates and teaches them
- Pages Router support — App Router only; Pages Router is legacy
- WebSocket transport — SSE is the DeepAgents protocol
- **npm publishing and release engineering** — retired in #20, packages private in #27; this is a template to fork, not a package to install
- **A TypeScript agent plane for rungs 1–3** — deferred to v2.1, not cancelled

## Context

- Extracted from an existing production project (`stsfront`) where the glue was built organically
- The core mismatch: DeepAgents backends send `messageId` in SSE `finish` events; AI SDK v6 rejects it — `defaultTransforms` fixes this
- Both reference backends use LangGraph (`create_react_agent`) with `astream_events v2` — the LangGraph pattern is now the canonical integration point
- The transform pipeline follows the Open/Closed Principle: ship known fixes as defaults, let consumers extend for future backend quirks
- Target audience — **changed in v2.0**: teams choosing where on the agent ladder their product belongs, who intend to fork and own the code. Previously: developers installing packages into an existing app.
- LLM routing via `openrouter/free` (auto-routes to best available free model; overridable via `OPENROUTER_MODEL`)
- Stream reconnection (STR-01) deferred to v1.3 — depends on AI SDK upstream bugs #6502 and #9707

## Constraints

- **Tech stack**: pnpm workspaces + Turborepo; TypeScript; Zod v4; AI SDK v6 (`ai`, `@ai-sdk/react`)
- **Server package**: Pure Node.js, no React dependency — importable in server environments without client-side bloat
- **React package**: Peer-depends on React 18/19 and AI SDK v6
- **Framework packages**: Each framework package avoids importing from `@deepagents-nextjs/react` or `next` — `SseFrameAccumulator` copied to prevent peerDep leakage
- **Compatibility**: Next.js App Router (v14+), SvelteKit, Remix — Node runtime for all packages

### Package boundaries are load-bearing pedagogy — do not "simplify" them

The package split survives the reframe **deliberately and in full**. Retiring the release process did not retire the architecture; those are separate decisions and only the first was made.

Two boundaries in particular are teaching, not packaging overhead:

- **`server` has no React dependency.** This is what lets the transport be imported in a server-only environment without client bloat. Collapsing it into a single package would erase the demonstration.
- **`sveltekit` and `remix` copy `SseFrameAccumulator` rather than importing it from `server`.** This is not duplication by accident. It is what prevents the `next` peerDep from leaking into non-Next.js framework packages, and the copy is the point being made.

A future contributor will look at an unpublished monorepo, see seven packages with no npm consumers, and reasonably propose merging them. That proposal should be declined with reference to this section. The packages are unpublished; they are not vestigial.

## Key Decisions

| Decision                                                                                                      | Rationale                                                                                                                                                                           | Outcome                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Profile `library` → `reference-template` (v2.0)**                                                           | All 7 packages unpublished at 0.1.0 with zero external consumers; publish workflow deleted (#20), packages going private (#27). The artifact people take is the repo, not a tarball | — New — see Charter Provenance                                                   |
| **Product is the five-rung agent ladder, ejectable to one rung**                                              | The step between rungs is the thing teams get wrong; showing all five against one transport makes the step legible                                                                  | — New — v2.0 subject                                                             |
| **Package boundaries kept despite retiring publishing**                                                       | `server` having no React dep, and the `SseFrameAccumulator` copy, are the demonstration — not release plumbing                                                                      | ✓ Kept deliberately                                                              |
| **TypeScript agent plane for rungs 1–3 deferred to v2.1**                                                     | Rungs 4–5 are TypeScript regardless (#23); a second language plane for the lower rungs is additive and can follow                                                                   | — Deferred, not cancelled                                                        |
| Monorepo with scoped packages (`@deepagents-nextjs/server` + `@deepagents-nextjs/react` + framework packages) | Mirrors AI SDK's own structure; avoids bundling React in server environments                                                                                                        | ✓ Good — clean separation, no duplicate React                                    |
| Configurable transforms pipeline                                                                              | Reduces maintenance burden; consumers extend without waiting for package release                                                                                                    | ✓ Good — Open/Closed; messageId strip proved in E2E                              |
| Handler factory pattern (`createDeepAgentsHandler`)                                                           | One-line server setup; idiomatic App Router pattern                                                                                                                                 | ✓ Good — confirmed in example app and framework packages                         |
| `SseTransform = (frame) => frame \| null` — null drops the frame                                              | Simple, composable, easy to test in isolation                                                                                                                                       | ✓ Good — stateless and independently testable                                    |
| `"type": "commonjs"` + `outExtension` in tsup                                                                 | Makes `.js` = CJS and `.mjs` = ESM; required for publint to pass                                                                                                                    | ✓ Good — publint clean                                                           |
| No root `vitest.workspace.ts`                                                                                 | Deprecated in Vitest 3.2+; per-package configs correct with Turborepo                                                                                                               | ✓ Good                                                                           |
| `moduleResolution: bundler` in tsconfig.base.json                                                             | No `.js` extensions required on imports; compatible with tsup                                                                                                                       | ✓ Good                                                                           |
| Manual DATABASE_URL parser in Django backend                                                                  | Avoids dj-database-url dependency                                                                                                                                                   | ✓ Good — fewer deps                                                              |
| LangGraph `astream_events v2` for SSE streaming                                                               | Standard LangGraph pattern; works identically in Django and FastAPI                                                                                                                 | ✓ Good — backend-agnostic confirmed                                              |
| Lazy `_get_graph()` in Django vs lifespan in FastAPI                                                          | Django: per-request (avoids import cost); FastAPI: startup (reused across requests)                                                                                                 | ✓ Good — appropriate to each framework                                           |
| `head.repo.full_name == repository` for external PR skip                                                      | No `environment:` protection rules needed (requires paid plans for private repos)                                                                                                   | ✓ Good — fork-safe, no paid plan required                                        |
| `openrouter/free` as default LLM router                                                                       | Auto-routes to best available free model; no manual model pinning                                                                                                                   | ✓ Good — resilient to individual model deprecations                              |
| Named adapter bundles (`SseAdapter = { name, transforms }`)                                                   | Composable, testable, consumer-replaceable; default adapter is deepagentsAdapter                                                                                                    | ✓ Good — langGraphAdapter/langchainAdapter ship independently                    |
| Adapter pipeline order `[...adapter.transforms, ...options.transforms]`                                       | Adapter normalizes first, user overrides after — predictable ordering                                                                                                               | ✓ Good — matches mental model                                                    |
| `fetchWithRetry` internal to handler (not exported)                                                           | Retry is handler-level concern; consumers configure via options, not by calling utility                                                                                             | ✓ Good — simpler API surface                                                     |
| SseFrameAccumulator copied to sveltekit/remix (not imported from server)                                      | Prevents `next` peerDep from leaking into non-Next.js framework packages                                                                                                            | ✓ Good — clean package boundaries; now also pedagogy (see Constraints)           |
| SvelteKit/Remix handlers have NO default adapter (clean proxy)                                                | Server handler defaults to deepagentsAdapter; framework packages are transparent proxies                                                                                            | ✓ Good — consistent with design intent                                           |
| Remix hook uses native `fetch()` + ReadableStream (NOT `useFetcher`)                                          | `useFetcher` buffers full response before resolving — cannot stream SSE                                                                                                             | ✓ Good — SSE streaming requires streaming reader                                 |
| `queueMicrotask` in SvelteKit store StartStopNotifier                                                         | Svelte's writable calls start function synchronously — defer to let subscribers see idle state first                                                                                | ✓ Good — state machine integrity                                                 |
| STR-01 deferred to v1.3                                                                                       | AI SDK bugs #6502 and #9707 confirmed open 2026-05-02; conditional requirement                                                                                                      | — Pending — re-evaluate at v1.3 kickoff                                          |
| MCP tools extend packages/mcp (not new package)                                                               | Avoids package proliferation; tools follow existing `server.tool()` registration pattern                                                                                            | ✓ Good — all 4 tools fit cleanly into existing createDeepAgentsMcpServer factory |
| `encodeURIComponent(runId.trim())` in MCP tool URL paths                                                      | Prevents path injection attacks (e.g., `run/evil` → `run%2Fevil`)                                                                                                                   | ✓ Good — security property verified by test                                      |
| backendRequest throws on non-ok responses                                                                     | 502 test assertions pass naturally without explicit error handling in tools                                                                                                         | ✓ Good — consistent with existing proxy pattern                                  |
| AbortError returns `isError: true` (not rethrow) in MCP tools                                                 | MCP callers receive structured errors; unhandled throws bypass the tool response envelope                                                                                           | ✓ Good — agent-friendly error surface                                            |

## Charter Provenance

**This section exists because the charter's Out of Scope list was changed, and a charter edited without provenance is worse than a charter contradicted — the contradiction is at least visible.** What follows records what changed, on whose authority, and what was assumed, so that a reader who disagrees can find the decision rather than infer it.

### What changed

| Field        | Before                                                             | After                                                               |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Profile      | `library`                                                          | `reference-template`                                                |
| Product      | Publishable npm packages bridging DeepAgents backends to AI SDK v6 | One forkable reference implementation of the five-rung agent ladder |
| Out of Scope | Excluded "Full chat UI components" and "CLI/init scaffolding"      | Both exclusions **removed** — they are what v2.0 builds             |
| Audience     | Developers installing packages into an existing app                | Teams choosing a rung, forking, and owning the code                 |

### Why it changed

The principal stated new intent for the project: that its value is as a forkable reference implementation of the agent ladder rather than as a set of installable packages. The supporting facts were independently verifiable and were verified — all 7 packages sit at 0.1.0, unpublished, with zero external consumers; the OIDC publish workflow was deleted in #20; the packages are being made private in #27. With publishing retired, the library framing described a distribution model the project no longer has.

The immediate trigger for editing the charter rather than deferring it: the existing Out of Scope list **forbids the v2.0 milestone**. It excluded UI components and scaffolding, which are precisely what v2.0 builds. Every other v2.0 issue technically contradicted the charter until this landed, and the next person to read it would have been correct to object.

### How it reached this file, and by whom

- The principal's intent was relayed to the working sessions via the **PRODUCT** session. It is a relay, not a direct quote captured in this repo.
- **The user was AFK when parts of this were decided.** Scope calls made during that window were made by agent sessions on the user's behalf, not confirmed by the user in the moment.
- **ARCHITECT [34d4ad]** ruled that recording provenance in the charter is required, on the reasoning quoted at the head of this section.
- **TEAMLEAD** scoped and assigned the charter edit as issue #3, wave 1 P0.
- **DEV** drafted this text. No code was changed in the same PR.

### What is assumed

If the principal returns meaning something narrower than what is written above, these are the assumptions to challenge first — each was inferred from relayed intent, not confirmed directly:

1. **That "reference template" means all five rungs ship in one repo**, rather than five separate repos or a single rung with documentation describing the others.
2. **That ejection is per-rung** — `pnpm eject <rung>` keeps exactly one rung — rather than cumulative (keep rungs 1..N).
3. **That removing the UI-components exclusion authorizes building product-quality UI**, not merely minimal demo scaffolding. The milestone reads as the former; the charter previously forbade both.
4. **That retiring publishing is permanent**, not a pause while billing is resolved. Note the v1.6 record lists publish as blocked on org GitHub Actions billing — a reader could reasonably interpret the retirement as temporary. #20 and #27 were read as intentional retirement.
5. **That deferring the TypeScript agent plane to v2.1 is acceptable** rather than required in v2.0.

Assumptions 3 and 4 carry the most risk. If the principal intended a narrower reading of either, the affected v2.0 issues should be re-scoped before implementation rather than after.

### What was explicitly NOT done here

Renaming `createDeepAgentsHandler`, `DeepAgentsHandlerOptions`, `createDeepAgentsResumeHandler`, or the `@deepagents-nextjs/*` packages is part of issue #3 per ARCHITECT's ruling, but touches 289 of ~414 tracked files. With three agents editing concurrently in other worktrees, TEAMLEAD split it into a follow-up PR after wave 1 lands. This PR is charter text only.

---

_Last updated: 2026-08-24 — v2.0 reframe: profile `library` → `reference-template`; UI-component and scaffolding exclusions removed; provenance recorded (issue #3)._
