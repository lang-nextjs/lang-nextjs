# Research Summary — v1.6 Production Readiness & Observability

**Project:** deepagents-nextjs
**Milestone:** v1.6 Production Readiness & Observability
**Research completed:** 2026-06-06
**Source files:** STACK-v1.6-PRODUCTION-READINESS.md, FEATURES-v1.6-PRODUCTION-READINESS.md, ARCHITECTURE-v1.6.md, PITFALLS-v1.6.md

---

## Executive Summary

v1.6 turns the pure-streaming SSE proxy into a production-ready platform via four locked pillars: **(1) vendor-neutral observability hooks**, **(2) health/readiness probes**, **(3) resilience controls** (rate limiting, circuit breaker, backpressure, timeout/abort), and **(4) deploy infrastructure + graceful shutdown**.

The design boundary holds: **zero new runtime dependencies** while staying **edge-runtime compatible**. Observability is callback-based (consumers wire their own OpenTelemetry/Sentry/Datadog). Resilience state is **consumer-provided** via async store interfaces (Redis, DynamoDB, in-memory), avoiding module-scope state that breaks serverless isolation. Health helpers and graceful shutdown follow the **copy-not-import pattern** already established by `SseFrameAccumulator`.

**Confidence:** HIGH on patterns/features; MEDIUM on resilience store implementation (flagged for first phase validation). Critical pitfalls cluster around edge timing-API availability, secret leakage through callbacks, callback safety in SSE streams, and graceful-shutdown limits on serverless.

---

## Stack — Zero New Runtime Dependencies

| Component | Technology | Runtime dep | Notes |
|-----------|-----------|-------------|-------|
| Observability hooks | TS callbacks (`onRequest`, `onError`, `onStreamEnd`, …) | None | Vendor-neutral; consumer integrates |
| Health/readiness probes | `fetch()` + `AbortSignal.timeout()` | None | Native Web APIs |
| Rate limiting | Token bucket (~50 LOC) | None | Built-in; consumer provides state store |
| Circuit breaker | State machine (CLOSED/OPEN/HALF_OPEN) | None | Basic built-in; optional `cockatiel@3.2.1` (Node-only) for advanced |
| Backpressure | Web Streams `.pause()/.resume()` / `pipeline()` | None | Native |
| Timeout/abort | `AbortController` + `AbortSignal.timeout()` | None | Node 17+, Deno, Cloudflare |
| Graceful shutdown | SIGTERM/SIGINT handlers | None | Node-only (N/A on edge) |

**Optional consumer integrations:** `@sentry/node`, `cockatiel`, Redis/DynamoDB for distributed resilience state.

**Anti-additions (do NOT add as runtime deps):** OpenTelemetry SDK, Pino/Winston loggers, `express-rate-limit`, any Node-only dep in the `/edge` package, DB client libs.

---

## Features — Three-Tier Strategy

**v1.6.0 MVP (table stakes):**
- `onRequest`, `onError`, `onStreamEnd` callbacks (frame/byte/duration metrics)
- Liveness + readiness probe helpers (`createLivenessProbe()`, `createReadinessProbe()`)
- Graceful SIGTERM handling + readiness 503 during drain
- Timeout/AbortSignal config option
- Rate limiting (token bucket, consumer-store based)
- Circuit breaker (state machine, consumer-store based)
- Configurable retry policy (expose existing `fetchWithRetry` via config)
- Deployment runbook documentation

**v1.6.x point releases (differentiators):** secret/PII redaction helpers, structured event types, adapter-level hooks (`onTransform`, `onHeartbeat`), request queue + backpressure pause, custom dependency checks in readiness, error-reporting adapter examples, canary health-gating utility.

**Deferred to v1.7+:** adaptive timeout, per-tool rate limits (MCP), multi-region failover readiness, observability sampling.

**Anti-features (do NOT build):** bundled OTel/Sentry SDKs, auto log rotation, Prometheus scrape endpoint, auto-retry on 4xx, adaptive rate limiting from backend headers, bulkhead isolation.

---

## Architecture — Additive, No Breaking Changes

**New modules in `packages/server/src/`:** `observability.ts`, `health.ts`, `resilience.ts`, `shutdown.ts`.

**Handler options gain only optional fields:**
```typescript
interface DeepAgentsHandlerOptions {
  // existing: backendUrl, adapter?, transforms?, getToken?, ...
  observability?: ObservabilityHooks;
  resilience?: ResilienceConfig;          // delegates to consumer stores
  onShutdown?: (ctx) => void | Promise<void>;
}
```

**Request lifecycle:** onRequest → checkRateLimit → checkCircuitBreaker → AbortSignal.timeout → fetch (onFetchStart/End) → stream (onStreamStart) → transform loop (onTransform*) → onStreamEnd → cleanup.

**Transform contract unchanged** (`(frame) => frame | null`); existing adapters keep working.

**Framework/edge packages:** health helpers **copied** (not imported) to `sveltekit/remix/edge` to preserve the no-peerDep-leakage boundary; edge stays Web-API-only.

**Resilience state:** library holds **zero module-scope state**; consumer implements `RateLimitStore` / `CircuitBreakerStore` interfaces. Per-request context (sessionId) passed to hooks — HMR/serverless/edge safe.

---

## Top Pitfalls (with phase ownership)

1. **Edge timing-API availability** — `performance.now()`/`Date.now()` inconsistent on Cloudflare (pre-2025)/Deno. Guard with a safe-time util; test per platform. *(Phase 18)*
2. **Secret leakage via callbacks** — never pass raw frames/headers/tokens to observability callbacks; design event types to exclude raw data; document. *(Phase 18)*
3. **Callbacks throwing crash the stream** — wrap ALL callback invocations in try/catch, log-don't-rethrow. *(Phase 18)*
4. **Module-scope resilience state breaks serverless** — hard requirement: zero module state; delegate to consumer stores. *(Phase 18)*
5. **Unbounded backpressure buffering (OOM)** — use `pipeline()`/respect downstream; test slow-client memory. *(Phase 18)*
6. **AbortSignal incomplete cleanup (FD/socket leak)** — ensure timers/sockets close on abort; verify with `lsof` after N aborts. *(Phase 18)*
7. **Expensive readiness probes cascade failures** — readiness must be local/cheap (<10ms), no live backend round-trip by default. *(Phase 19)*
8. **Graceful shutdown impossible on serverless** — Vercel ~500ms window, Cloudflare no SIGTERM; document clearly, best-effort only, recommend client reconnection. *(Phase 19)*
9. **Health endpoints leak info** — minimal `{status}` only; separate public health from authenticated debug. *(Phase 19)*
10. **Canary/blue-green misconfig** — staging verification + traffic-split checklist. *(Phase 20)*

---

## Suggested Build Order — Phases 18–20

**Phase 18 — Observability + Health + Core Resilience:** hooks interface (try/catch wrapped), liveness/readiness factories (copied to framework/edge), `AbortSignal.timeout`, rate-limit + circuit-breaker store interfaces & check functions (early 429/503 rejection), example `/api/health` + `/api/ready`, unit tests. Validation gates: edge timing, callback-error containment, FD cleanup, transform statelessness.

**Phase 19 — Graceful Shutdown + Polish + Deploy Docs:** `createGracefulShutdown()` + readiness 503 during drain, shutdown limitation docs, secret-redaction helpers, structured event types, Kubernetes YAML + deployment runbook, load test (FD stable, latency). Validation gates: readiness <10ms under load, canary split verified in staging.

**Phase 20 — Launch:** error-reporting adapter examples (Sentry/Datadog), full E2E (observability→APM, resilience→fallback, shutdown→drain), v1.6.0 release + changelog/migration guide.

---

## Validation Gates / Research Flags

| Area | Validation | Phase | Severity |
|------|-----------|-------|----------|
| Edge timing API | measure `performance.now()` on Cloudflare/Deno/Vercel | 18 | HIGH |
| Callback error containment | callback throws every frame; stream still completes | 18 | CRITICAL |
| AbortSignal FD cleanup | 1000 aborts; FD count stable (`lsof`) | 18 | CRITICAL |
| Transform statelessness | code review + unit; no captured external state | 18 | MEDIUM |
| Readiness latency | <10ms @ 1000 concurrent | 19 | HIGH |
| Canary traffic split | staging: ~95/5 distribution over 100 reqs | 20 | MEDIUM |

**Standard patterns (skip deep research):** Kubernetes liveness/readiness semantics, circuit-breaker state machine, SIGTERM graceful shutdown, token-bucket rate limiting, Web Streams backpressure.

---

## Confidence Assessment

| Area | Level |
|------|-------|
| Stack (zero deps) | HIGH |
| Observability hooks | HIGH |
| Health probes | HIGH |
| Resilience controls | HIGH (impl details MEDIUM — store design) |
| Graceful shutdown | HIGH (serverless constraint documented) |
| Edge runtime constraints | HIGH |
| SSE callback safety | HIGH |
| Deployment patterns | MEDIUM (platform-specific) |

**Overall: HIGH on architecture/direction; MEDIUM on implementation specifics, resolved by Phase 18 validation gates.**
