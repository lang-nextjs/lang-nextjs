# Milestones

## v1.6 Production Readiness & Observability (Shipped: 2026-06-06)

**Phases:** 18–20 (3 phases, 9 plans)

**Requirements:** OBS-01..05, PROBE-01..05, RESIL-01..06, OPS-01..05 — all 21 complete

**Key accomplishments:**
- **Observability (OBS-01..05)** — vendor-neutral lifecycle callback hooks (`onRequest`/`onFetchStart`/`onFetchEnd`/`onStreamStart`/`onStreamEnd`/`onError`) on the handler firing with timing + frame/byte counts; every callback wrapped in `fireHook()` try-catch so a throwing/rejecting consumer hook never aborts the SSE stream; scalar-only context types (no auth headers/tokens/bodies reach callbacks); `getSafeCurrentTime()` edge-safe timing; types copied (not imported) into sveltekit/remix/edge
- **Health & readiness (PROBE-01..05)** — stateless `createHealthProbe` (liveness) + `createReadinessProbe` (503 on drain/dependency-down), cheap-by-default, minimal/no-leak responses; copied across framework + edge packages
- **Resilience (RESIL-01..06)** — consumer-provided `RateLimitStore`/`CircuitBreakerStore` interfaces (zero module-scope state); over-limit→429 and OPEN-breaker→503 before any fetch; per-request timeout with full resource cleanup; pull-based Web-Streams backpressure; config-driven retry that never retries mid-stream
- **Graceful shutdown (OPS-01)** — opt-in `createGracefulShutdown()` factory: SIGTERM → flips readiness to 503 → drains in-flight streams up to a configurable timeout with a safety exit; injectable `onExit`; Node-only
- **Deploy docs (OPS-03/OPS-04)** — `docs/DEPLOYMENT-RUNBOOK.md` + `docs/GRACEFUL-SHUTDOWN.md`; Phase 17 canary formalized as a health-gated rollout with a real `/api/ready` route wired to `createReadinessProbe`
- **Launch (OPS-02/OPS-05)** — `docs/ERROR-REPORTING.md` (Sentry/Datadog via `onError`, no SDK bundled) + SDK-free example route; E2E tests for the three production flows (observability→sink, resilience 429/503, SIGTERM drain) + bounded resource-stability test; staged v1.6 minor changeset + `docs/MIGRATION-v1.6.md`

**Locked constraints upheld:** zero new runtime dependencies · edge-runtime compatibility preserved (Web-API-only) · telemetry is vendor-neutral hooks (no OpenTelemetry) · zero module-scope resilience state (consumer-provided stores).

**Test suite:** 461 server tests (was 397 pre-v1.6) + 170 open-swe tests; 4 packages typecheck clean.

**Verification:** Phase 18 (5/5 criteria), Phase 19 (3/3), Phase 20 (3/3) — all goal-backward verified.

**Deferred:** actual npm publish (`changeset version` + `changeset publish`) — release is staged; publish blocked on org GitHub Actions billing (OIDC publish workflow can't run). Packages remain at 0.1.0 until published. The true 1000-abort `lsof` FD stress test deferred in favor of a bounded in-process no-leak proxy (CI-flakiness avoidance).

---

## v1.1 Reference Backend Stacks (Shipped: 2026-04-30)

**Phases:** v1.1-01 (1 phase, 4 plans)
**Git range:** d9dd18a → 7913b53
**Files changed:** 44 files, ~3.2K net insertions
**Timeline:** 2026-04-29 → 2026-04-30 (2 days)

**Key accomplishments:**
- Django 5 async SSE backend with postgres + redis Docker Compose stack; emits DeepAgents wire format including `messageId` in finish event for defaultTransforms testing
- FastAPI SSE backend with lifespan-initialized LangGraph graph and single-container Docker Compose; no database required
- Shared Playwright E2E suite (5 tests) proving SSE delivery, `defaultTransforms` messageId strip, and clean stream close against both backends
- GitHub Actions CI with independent `e2e-django` and `e2e-fastapi` jobs; fork-safe via `head.repo.full_name` guard — no paid-plan `environment:` protection rules needed
- Human verification complete: all 5 E2E tests pass live against both backends with `openrouter/free` routing

**Requirements:** E2E-01, E2E-02, E2E-03, E2E-04, E2E-05 — all complete

---

## v1.0 Core Packages (Shipped: 2026-04-29)

**Phases:** v1.0-01 through v1.0-05 (5 phases, 18 plans)
**Timeline:** 2026-04-29

**Key accomplishments:**
- pnpm + Turborepo monorepo with correct server → react → example build order and dual ESM/CJS output
- `@deepagents-nextjs/server` — `createDeepAgentsHandler()`, SSE transform pipeline, `defaultTransforms`, `SseFrameAccumulator`
- `@deepagents-nextjs/react` — `useDeepAgentsChat()`, typed message union, Zod schemas for `data-*` parts
- `apps/example/` — Next.js app demonstrating end-to-end streaming against a mock SSE backend
- Changesets + OIDC npm publish workflow; `publint` and `attw` CI gates

**Requirements:** PKG-01, PKG-02, SRV-01–06, RCT-01–04, EX-01, PKG-03, PKG-04 — all complete

---

## v1.2 Adapters, DX Tooling, and Framework Support (Shipped: 2026-05-02)

**Phases:** v1.2-01 through v1.2-05 (5 phases, 16 plans)
**Git range:** 7c57150 → 797fc45
**Files changed:** 115 files, +17,522 / -1,077 lines
**Timeline:** 2026-05-01 → 2026-05-02 (2 days)
**Test suite:** 271 tests (server 104, react 104, test-utils 8, sveltekit 25, remix 30)

**Key accomplishments:**
- Named backend adapters — `deepagentsAdapter`, `langGraphAdapter` (astream_events v2 → AI SDK v6), `langchainAdapter` (LangChain native SSE → AI SDK v6); retry policy with exponential backoff, mid-stream failures not retried
- DX tooling — `DEBUG=deepagents:sse` SSE frame logging, `createMockDeepAgentsServer()` in new `@deepagents-nextjs/test-utils` package, `getCookieToken()` cookie auth helper
- `useDeepAgentsChat<TData>()` generic — `CustomDataParts<TData>` mapped type narrows `data-*` message variants at compile time; zero-generic call backward-compatible
- `@deepagents-nextjs/sveltekit` — new framework package; `createDeepAgentsHandler(RequestEvent)` + reactive writable store; adversarial-hardened (25 tests), publint + attw green
- `@deepagents-nextjs/remix` — new framework package; `createDeepAgentsHandler(ActionFunctionArgs)` + `useDeepAgentsChat` hook on native `fetch()` + ReadableStream (NOT useFetcher); adversarial-hardened (30 tests), publint + attw green

**Requirements:** ADAPT-01–04, STR-02, DX-01–03, AUTH-01, FWK-01, FWK-02 — all complete (11/11)
**Deferred:** STR-01 (stream reconnection via `experimental_resume`) — AI SDK bugs #6502/#9707 open; deferred to v1.3
**Audit:** `tech_debt` — no blockers; 4 minor documentation/test items

---


## v1.5 open-swe Integration Layer (Shipped: 2026-05-08)

**Phases completed:** 21 phases, 65 plans, 12 tasks

**Key accomplishments:**
- ESM-only edge package README with EXPERIMENTAL Cloudflare caveat + CI guards for no Node.js built-ins and no cross-package server import
- Approval route factory (GET/POST) closes the bidirectional control channel; full ADAPT-05 API exported from server package with README docs

---

