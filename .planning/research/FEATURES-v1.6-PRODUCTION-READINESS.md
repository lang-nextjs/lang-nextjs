# Feature Research: v1.6 Production Readiness & Observability

**Domain:** TypeScript SSE proxy library for streaming LLM integrations (DeepAgents backend adapter)  
**Researched:** 2026-06-06  
**Confidence:** HIGH (Vercel AI SDK v6 docs verified; OpenTelemetry/Kubernetes patterns confirmed across multiple 2026 sources)

## Overview

This research catalogs production-readiness features for `@deepagents-nextjs/*` streaming proxy handlers. The v1.6 milestone adds four capability pillars: **Observability**, **Health & Readiness**, **Resilience**, and **Deploy Infrastructure**. Each feature is scoped to prevent runtime dependency bloat and edge-runtime compatibility.

---

## Pillar 1: Observability (Vendor-Neutral Callbacks & Events)

Observability is implemented as **zero-dependency callback hooks**. Consumers wire their own OpenTelemetry, Sentry, DataDog, or custom backends. The handler fires events at key lifecycle points; consumers decide how to pipe that data.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On | Notes |
|---------|--------------|------------|-----------|-------|
| **onRequest callback** | Handlers need to know requests arrived to instrument with request ID, start timestamp, client metadata | LOW | Handler instantiation | Signature: `(req: Request) => void`. Fires synchronously before backend fetch. Allows consumer to start tracing span, capture headers (user-agent, trace-id if provided), session/request ID. |
| **onError callback** | Critical for error tracking in prod; most errors occur mid-stream where traditional try/catch doesn't help | MEDIUM | SSE transform pipeline | Signature: `(error: Error, context: { requestId?, phase: 'fetch'\|'stream'\|'transform' }) => void`. Fires when backend is unreachable (502), mid-stream error (500), transform throws, or stream aborted. Allows Sentry/DataDog integration without parsing logs. |
| **onStreamEnd callback** | Needed to finalize metrics—duration, success/failure status, final token count | MEDIUM | Entire handler pipeline | Signature: `(result: { success: boolean; durationMs: number; framesSent: number; bytesSent: number; reason?: string }) => void`. Fires once at stream completion (client disconnect, backend close, or timeout). Required for cost calculation (tokens × price) and latency SLO tracking. |
| **Frame-level metrics** | Producers of streaming endpoints need per-frame visibility for quality-of-service analysis (how often do we send frames, how big are they) | LOW | SSE transform pipeline | Expose via callback context: `{ frameCount, byteCount, lastFrameMs }` updated on each frame emission. Allows consumers to sample frame size distribution or detect stalling. |
| **Duration tracking** | Time-series observability (latency percentiles, duration SLO bucketing) is the bare minimum for production dashboards | LOW | Handler/adapter execution | Capture: `startTimeMs`, `firstFrameMs`, `lastFrameMs`, `endTimeMs`. Allows P50/P95/P99 latency breakdowns without external timing. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|-----------|-------|
| **Secret/PII redaction helpers** | SSE payloads often contain tokens, user PII, or API keys in error messages. Redaction helpers prevent accidental leakage to centralized observability backends. | MEDIUM | Observability hooks | Export utility: `createRedactionFilter(patterns: RegExp[])` → `(str: string) => string`. Pre-built patterns for common secrets (Bearer tokens, `api_key=`, email addresses). Consumers opt-in by wrapping `onError` / `onStreamEnd` callbacks. Prevents Sentry/DataDog from seeing sensitive data. |
| **Structured event shape** | Different observability backends expect different field names. Exporting a TypeScript interface for event shape lets TypeScript consumers and code-generation tools consume events with confidence. | LOW | Callback signatures | Export types: `ObservabilityEvent`, `ErrorContext`, `StreamEndResult`. Allows consumers to build type-safe telemetry adapters (e.g., `toOtelEvent(event: ObservabilityEvent)`). |
| **Adapter-level hooks** | Hooks on adapters (not just handler) allow consumers to instrument LangGraph SSE parsing, frame reordering, or heartbeat injection separately. Useful for debugging which adapter phase caused latency. | MEDIUM | Adapter pattern (existing) | Add optional `onTransform`, `onHeartbeat` to adapter definition. LangGraph and langchain adapters expose step-level metrics (e.g., tool-call reordering time). |

### Anti-Features (What NOT to Build)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Built-in OpenTelemetry SDK** | "Let us not wire our own OTel backend" — simplicity appeal | Adds `@opentelemetry/*` deps (3–5 packages, ~100 KB bundle); breaks tree-shaking for consumers not using OTel. Couples library to OTel versioning. Edge runtimes (Cloudflare Workers) may not support OTel collector clients. | Consumer wires OTel integration. If common enough, publish separate `@deepagents-nextjs/otel-adapter` package as optional peer-compatible extension. |
| **Built-in Sentry/DataDog client** | "Ship Sentry integration out of the box" — vendor appeal | Each vendor SDK is heavyweight (~50–200 KB). Coupling to one vendor prevents others from using library. Vendor DSNs leak into environment config, not the library's domain. | Consumers call `Sentry.captureException(error)` inside `onError` callback. Library stays vendor-neutral. |
| **Automatic log rotation / buffering** | "Collect events locally, flush on schedule" — appealing for batching | Adds state management, memory overhead, retry complexity. SSE is already streaming; batching defeats the purpose. Observability system should handle backpressure. | Consumers implement batching in their callback. `onStreamEnd` is perfect hook for batch flush (one event per stream, coalesce multiple streams). |
| **Real-time metrics sink (Prometheus scrape endpoint)** | "Let's expose /metrics for Prometheus" — infrastructure appeal | Requires stateful metric registry (Prometheus client, Counter/Histogram objects). Tight coupling to Prometheus. Workers/edge runtimes may not have enough memory for metric cardinality. | Consumers expose their own `/metrics` endpoint using a separate Prometheus client library, fed by our callbacks. Library stays stateless. |

---

## Pillar 2: Health & Readiness (Liveness/Readiness Probes)

Health probes are reusable helpers exported from `@deepagents-nextjs/server`. They distinguish **liveness** (are you alive?) from **readiness** (can you serve traffic now?). Compatible with Kubernetes probes and Vercel deployment readiness checks.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On | Notes |
|---------|--------------|------------|-----------|-------|
| **Liveness probe helper** | Kubernetes and orchestrators require `/livez` endpoint. Liveness should answer: "Is the Node.js process still running and responsive?" | LOW | None (pure utility) | Export: `createLivenessProbe() → (req: Request) => Promise<Response>`. Returns 200 OK if process is up. Used by Kubernetes every 10–30s. Must be fast (~5ms). Simply responds 200. Can check: process not in shutdown, event loop responsive (no hung timers). |
| **Readiness probe helper** | Kubernetes and load balancers require `/readyz` endpoint. Readiness should answer: "Can you serve user requests right now?" | MEDIUM | Backend health check, dependency checks | Export: `createReadinessProbe(options: { checkDependencies?: { backend?: { url: string } }; isShuttingDown?: () => boolean }) → (req: Request) => Promise<Response>`. Returns 200 if: (1) not shutting down, (2) backend is reachable (optional HEAD/GET to backend health endpoint, default 5s timeout). Returns 503 if shutting down or backend unavailable. Allows orchestrator to stop routing traffic before server fully closes. |
| **Shutdown state signal** | Both probes need to know if server is shutting down to return appropriate status immediately. | LOW | Graceful shutdown handler | Export helper: `createShutdownState() → { signal: AbortSignal; isShuttingDown: () => boolean; markShuttingDown: () => void }`. Returns abort signal + boolean flag. Handler uses this to make readiness return 503 during SIGTERM drain window. |
| **Backend dependency check** | Readiness probe should optionally verify backend connectivity to avoid routing traffic to an instance whose upstream is down. | MEDIUM | HTTP fetch | Configurable in readiness options: `checkDependencies.backend = { url: string; timeout?: number }`. Default: HEAD request to `${url}/health` or `${url}/livez`. If HEAD fails, readiness returns 503. Allows fast-fail when backend is degraded. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|-----------|-------|
| **Custom dependency checks** | Some deployments depend on databases, caches, or third-party APIs. Readiness should allow consumers to add custom checks without modifying the library. | MEDIUM | Readiness probe helper | Export extensibility: `createReadinessProbe(options: { customChecks?: (() => Promise<boolean>)[] })`. Each check runs in parallel with timeout (default 2s). If any fails, readiness returns 503. Allows: "check Redis connection", "check DB pool", "check auth service". |
| **Dependency metadata in response** | Observability: expose which dependencies are healthy/unhealthy in the readiness response body. | MEDIUM | Readiness probe + custom checks | Optional `includeDetails: boolean` in options. If true, response body is JSON: `{ status: 'ready'\|'unavailable', dependencies: { backend: 'healthy', redis: 'unhealthy', reason: '...' } }`. Helps ops teams debug "why isn't this pod becoming ready?" |
| **Graceful drain window configuration** | Allow configurability of how long to wait for in-flight requests during SIGTERM before force-closing. | LOW | Shutdown state + graceful shutdown handler | Export: `createShutdownState(options: { drainTimeoutMs?: number = 30000 })`. During drain, readiness returns 503 but existing streams are allowed to complete. Closes remaining connections after timeout expires. |

### Anti-Features (What NOT to Build)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Health check polling inside library** | "Auto-poll backend every 30s and cache result" — caching appeal | Adds background task management, state, potential memory leaks. Couples health check frequency to library. If consumer has own cache (e.g., Kubernetes liveness already polling), creates redundancy. | Consumers call readiness probe synchronously on demand (Kubernetes does this). No polling needed. Probe checks backend on each request (fast due to keep-alive). |
| **Distributed health consensus** | "Report health to a central service" — coordination appeal | Out of scope for a library. This is orchestration. Adds network I/O to health checks (defeats purpose of fast 5ms latency). | Consumers use orchestrator's health aggregation (Kubernetes Endpoint slicing, load balancer health groups). |
| **Automatic circuit breaker based on health** | "If backend health check fails twice, auto-open the circuit" — resilience appeal | Health checks and circuit breakers are separate concerns. Conflates readiness (can you serve?) with fault tolerance (should you try?). Readiness is orchestrator's decision; circuit breaker is the handler's. | Implement circuit breaker separately (see Resilience pillar). Use readiness for orchestrator traffic control, circuit breaker for request-level fault tolerance. |

---

## Pillar 3: Resilience (Rate Limiting, Backpressure, Circuit Breaker, Timeout/Abort)

Resilience features are first-class configuration options on `createDeepAgentsHandler`. They're formalized versions of existing patterns (e.g., `fetchWithRetry`) and new primitives (rate limit, circuit breaker). Zero new runtime dependencies.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On | Notes |
|---------|--------------|------------|-----------|-------|
| **Timeout/AbortSignal on handler** | SSE streams can hang indefinitely if backend stalls. Timeout is critical for prod. Vercel edge functions have hard timeouts (10s–15s); handlers must respect them. | MEDIUM | Handler instantiation + stream pipeline | Add option: `createDeepAgentsHandler({ timeout?: number = 60000 })`. Passed to `fetch()` and stream consumption. Uses `AbortSignal.timeout()` (Node 17+) or manual `AbortController` with `setTimeout`. Returns 504 if backend request times out mid-stream. Aborts stream if no new frames arrive for `timeout` duration. |
| **Configurable retry policy** | Existing `fetchWithRetry` is internal; should be exposed as config to let consumers tune exponential backoff, max attempts, jitter. | LOW | Existing `fetchWithRetry` implementation | Export option: `retryPolicy?: { maxAttempts?: number = 3; initialDelayMs?: number = 100; maxDelayMs?: number = 10000; jitter?: boolean = true }`. Only retries on **fetch failures** (network, 5xx), not mid-stream errors (already too late). Makes exponential backoff and jitter configurable. |
| **Rate limiting (request-level)** | Users deploying under load need to shed traffic fairly when approaching backend rate limits or platform caps (e.g., OpenRouter 100 req/min). Token bucket is standard, sliding window is more accurate. | MEDIUM | Timer/state management | Add option: `rateLimit?: { algorithm: 'token-bucket' \| 'sliding-window'; rps?: number = 10; burst?: number = 20 }`. **Token bucket**: refills `rps` tokens/sec, max `burst` capacity. Each request costs 1 token; if empty, return 429 immediately. **Sliding window**: tracks request timestamps in last `1/rps` seconds; if count exceeds window limit, return 429. Sliding window more accurate but slightly higher memory for high throughput. |
| **Request queue + backpressure** | When rate limit is hit, consumers might prefer to queue requests (with timeout) rather than reject immediately. Allows graceful degradation under spike. | MEDIUM | Rate limiter + queue state | Add option: `requestQueue?: { enabled: boolean = false; maxQueueSize?: number = 100; queueTimeoutMs?: number = 30000 }`. If enabled and rate limit hit, push request to queue instead of 429. Process queue in FIFO order when tokens refill. If queue timeout expires, return 429. Prevents thundering herd. |
| **Circuit breaker on handler** | Backend might fail (degraded, overloaded, down). Circuit breaker stops hammering a dead service and fails fast. Must integrate with readiness probe. | MEDIUM | State machine + metrics | Add option: `circuitBreaker?: { failureThreshold: number = 5; resetTimeoutMs: number = 60000; halfOpenRequests?: number = 2 }`. **States**: CLOSED (normal) → OPEN (fail fast on errors) → HALF_OPEN (test recovery with 2 requests). Transitions: fail count ≥ threshold → OPEN; timeout expires → HALF_OPEN; half-open requests succeed → CLOSED. If OPEN, return 503 immediately without calling backend. Coordinates with readiness probe: when breaker is OPEN, readiness returns 503. |
| **Stream abort on client disconnect** | If client closes the connection (e.g., user navigates away), handler should detect and abort backend request immediately to save bandwidth/compute. | LOW | Request's AbortSignal | Use standard pattern: pass `request.signal` to `fetch()`. If client aborts (closes browser tab), `fetch()` is aborted, stream stops pulling from backend. No explicit feature needed; ensure existing `request.signal` is threaded through. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|-----------|-------|
| **Per-adapter resilience config** | Some adapters (e.g., LangGraph) parse structured events; others (deepagents) pass through raw SSE. Allow timeout/rate-limit per adapter. | MEDIUM | Adapter pattern + handler options | Add to adapter def: `resilience?: { timeout?: number; rateLimit?: {...} }`. Merge with handler-level config: adapter settings override global defaults for that adapter's requests. LangGraph adapter might have tighter timeout (events are small) vs raw SSE (frames vary). |
| **Adaptive timeout based on first-chunk latency** | Some backends are slow on first chunk (model load), fast after. Could detect slow backend and extend timeout dynamically. | HIGH | Timeout + observability hooks | Advanced feature: if first chunk takes >50% of timeout budget, extend remaining timeout. Requires tuning constants per backend. Risky (can mask actual hangs). Lower priority; defer to v1.7. |
| **Graceful backpressure via stream pause** | When rate limit queue is full, pause the backend stream (via `pause()` on response body ReadableStream) instead of dropping requests. | MEDIUM | Request queue + stream primitives | If queue is at max capacity, call `backendResponse.body.pause()` to halt backend frame consumption. Resume when queue drains. Prevents buffering entire backend response in memory. Requires careful async coordination. |
| **Per-tool rate limits (MCP integration)** | Different tools have different rate limits (e.g., web search vs database query). MCP tools could declare rate limit per tool. | HIGH | Resilience config + MCP tools | Out of scope for v1.6 (MCP is separate). Future: allow `tool.rateLimit = { rps: 5 }` on MCP tool definition; route tool invocations through tool-specific rate limiter. |

### Anti-Features (What NOT to Build)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Automatic retry on 4xx errors** | "Retry auth failures" — recovery appeal | Wrong semantic. 401/403 won't be fixed by retry. Enables infinite retry loops on invalid auth. Should only retry 5xx and network errors. Retry on 4xx is either a bug or requires different handling (refresh token, re-auth). | Only retry on `fetch` failure, ECONNREFUSED, 5xx, ETIMEDOUT. Treat 4xx as client's problem. Consumers handle auth failures in middleware. |
| **Adaptive rate limiting based on HTTP headers** | "Respect Retry-After / RateLimit-Remaining headers from backend" — auto-tuning appeal | Couples library to backend's rate-limit scheme. Different backends use different headers (or none). Requires stateful parsing. If backend header is wrong, library trusts it. | Consumers implement custom rate limit override in `onError` callback: if they see `Retry-After`, update handler's rate limit config before next request. Library stays declarative. |
| **Bulkhead isolation (per-client rate limits)** | "Partition capacity per user" — fairness appeal | Requires identity context (user ID, API key) which handler doesn't have. Conflates handler-level rate limiting with user-level fairness. Typically done in API gateway or middleware. | Implement bulkhead in consuming app's routing layer (e.g., per-user handler instances, or middleware that tracks users). Library handles single-client rate limiting. |
| **Automatic fallback to cached response** | "If circuit breaker opens, return last-known-good response" — resilience appeal | Couples library to response caching (consumer doesn't always want stale data). TTL / staleness metadata needed. Adds state/complexity. For SSE, cached response is meaningless (streaming, not a one-shot response). | Consumers implement caching in their layer (e.g., next-app Cache API, Redis). If circuit breaker opens, they decide whether to return cached or fail. |

---

## Pillar 4: Deploy Infrastructure & Graceful Shutdown

Deploy patterns are formalized via helper exports, graceful shutdown integration, and runbook documentation (not code). Assumes Vercel + Kubernetes-compatible orchestration.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On | Notes |
|---------|--------------|------------|-----------|-------|
| **Graceful SIGTERM handler** | Kubernetes/Vercel sends SIGTERM on rolling redeploy. Handler must drain in-flight requests, stop accepting new ones, and exit cleanly. Missing = dropped requests, unhappy users. | MEDIUM | Server instantiation + HTTP server lifecycle | Export: `createGracefulShutdown(server: http.Server, options?: { drainTimeoutMs?: number = 30000; onShuttingDown?: () => void }) → AbortSignal`. On SIGTERM: (1) return 503 from readiness probe, (2) stop accepting new requests (`server.close()`), (3) wait for in-flight streams to finish (or timeout), (4) exit. Return AbortSignal that consumers can monitor for shutdown event. |
| **Drain in-flight requests** | During SIGTERM drain window, existing streams should complete. Don't abruptly close connections; let final frames flush. | MEDIUM | Graceful shutdown + readiness probe integration | Handler tracks active streams. On SIGTERM, sets `isShuttingDown = true`. Readiness probe returns 503 (orchestrator stops routing). Existing streams continue. After drain timeout, force-close remaining sockets. Consumers can hook via AbortSignal to finalize observability (flush telemetry) before exit. |
| **Readiness returns 503 during shutdown** | Orchestrators use readiness probe to decide traffic routing. During SIGTERM, readiness should return 503 to trigger pod/instance removal from load balancer before shutdown completes. | LOW | Readiness probe + shutdown state | Readiness helper integrates shutdown state: if `isShuttingDown()`, return 503 Service Unavailable. Propagates immediately. Orchestrator removes instance from endpoints. No new requests arrive. Existing requests drain. |
| **Documented graceful shutdown runbook** | Operators need to understand SIGTERM flow, drain timeout tuning, health check interaction. | LOW | Documentation only | Write `.planning/docs/DEPLOYMENT.md` (phase-specific, not code) covering: (1) SIGTERM → readiness 503 → client eviction → drain window → exit. (2) Setting `drainTimeoutMs` based on SLA (e.g., max stream duration). (3) Kubernetes `terminationGracePeriodSeconds` must be ≥ `drainTimeoutMs + 5s`. (4) Vercel `termination_grace_period_sec` equivalent. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|-----------|-------|
| **Canary/blue-green deploy health gating** | Blue-green deploys are safe only if the new version is healthy. Automate readiness + smoke-test validation before traffic switch. | MEDIUM | Readiness probe + deployment automation | Document + codify canary pattern: (1) Deploy new version (green). (2) Readiness endpoint must return 200 for N seconds before traffic shift. (3) Run smoke-test requests against green. (4) Monitor error rate for M seconds. (5) If errors > threshold, rollback; else shift 100% traffic. Implement in GitHub Actions / Vercel Deploy Hooks (automation, not library code). Export helper: `isHealthyEnoughForTrafficShift(readinessUrl: string, minHealthyDurationMs: number = 30000) → Promise<boolean>`. |
| **Error reporting integration hook** | Structured error context (from `onError` callback) should pipe to error tracking service with zero boilerplate. | LOW | Observability hooks + error reporting SDKs | Export example integrations: `toSentryEvent(error, context) → Sentry.CaptureException()`, `toDataDogEvent(error, context) → dd.logger.error()`. Document how to wire these into `onError` callback. Allows single-line setup: `onError: (err, ctx) => toSentryEvent(err, ctx)`. |
| **Deployment metrics dashboard query templates** | Operators want to see: error rate, p95 latency, rate-limit rejection rate during canary. | LOW | Observability hooks + monitoring tool knowledge | Provide example CloudWatch / DataDog / Prometheus queries in docs. E.g., CloudWatch Insights: `filter @message like /onStreamEnd.*success:false/ \| stats count() as errors by bin(5m)`. Consumers can use these as-is or adapt. |
| **Multi-region failover readiness check** | For global deployments, readiness should check regional backend availability. | MEDIUM | Readiness probe + multi-backend config | Extended readiness option: `checkDependencies: { backends: { primary: {...}, fallback: {...} } }`. If primary unavailable, check fallback. Readiness = (primary healthy OR fallback healthy). Allows seamless regional failover without manually redeploying. |

### Anti-Features (What NOT to Build)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Built-in deployment orchestration** | "Let the library manage blue-green switching" — convenience appeal | Couples library to deployment platform (Vercel, Kubernetes, ECS). Each platform has different APIs. Library can't know when to switch traffic. Belongs in CI/CD (GitHub Actions, Spinnaker, ArgoCD). | Export helpers (`isHealthyEnoughForTrafficShift`). Consumers wire into their deployment tooling. Library stays infrastructure-agnostic. |
| **Automatic rollback on high error rate** | "If error rate > 5% during canary, auto-rollback" — safety appeal | Requires domain knowledge (what IS a high error rate?). Different apps tolerate different thresholds. Overly aggressive rollback hides real issues. Orchestrator should decide. | Monitor observability data, alert ops, let ops decide on rollback. Library provides data, not policy. |
| **Built-in load test harness** | "Ship smoke tests" — validation appeal | Smoke tests are deployment-specific (which endpoints? which payloads?). Library can't know. Test harness adds maintenance burden. | Document smoke-test best practices + example queries. Consumers write their own tests for their specific scenarios. |
| **Secrets rotation / token refresh** | "Auto-refresh auth tokens on SIGTERM" — safety appeal | Auth token management is consumer's concern (middleware layer). Couples library to auth scheme. Different backends use different token formats. | Consumers implement token refresh in their `getToken()` function or middleware. Library just calls `getToken()` on each request. |

---

## Feature Dependencies & Ordering

```
Observability Hooks
    ├── onRequest → foundation for all tracing
    ├── onError ──→ requires SseFrameAccumulator error handling (existing)
    ├── onStreamEnd ──→ requires stream completion tracking
    └── Adapter-level hooks → requires Adapter pattern (existing)

Health & Readiness
    ├── Liveness probe ──→ requires process health check (low-level)
    ├── Readiness probe ──→ requires Liveness + optionally Backend health check
    └── Shutdown state signal ──→ foundation for graceful shutdown

Resilience
    ├── Timeout/AbortSignal ──→ foundation for all other resilience
    ├── Retry policy ──→ can use existing fetchWithRetry
    ├── Rate limiter ──→ independent of timeout
    ├── Request queue ──→ enhances Rate limiter
    ├── Circuit breaker ──→ enhances error handling; integrates with Readiness probe
    └── Stream backpressure ──→ enhances Request queue + Circuit breaker

Deploy Infrastructure
    ├── Graceful SIGTERM handler ──→ requires Shutdown state signal + Readiness
    ├── Drain window config ──→ enhances Graceful shutdown
    ├── Readiness + Shutdown integration ──→ combines Readiness probe + Shutdown state
    ├── Canary health gating ──→ requires Readiness probe + Observability hooks
    └── Error reporting hooks ──→ requires Observability hooks + external SDK

Conflicts/Constraints:
  - Circuit breaker state machine + Rate limiter queue: must coordinate transitions (if CB opens, drain queue or fail-fast?)
  - Timeout + Retry: max retry time = timeout (don't retry beyond deadline)
  - Shutdown + Request queue: if shutting down, queue new requests with failure or timeout immediately?
```

### Dependency Notes

- **Observability foundational**: All other pillars leverage observability hooks for metrics + debugging.
- **Health/Readiness prerequisite for graceful shutdown**: Shutdown handler integrates with readiness probe to signal orchestrator.
- **Timeout prerequisite for Retry + Circuit breaker**: Both resilience features depend on timeout configuration.
- **Rate limiter + Circuit breaker coordination**: Open/closed state must be visible to rate limiter (don't queue if CB open).
- **Shutdown + Drain**: Graceful shutdown is meaningless without drain window; configure together.

---

## Feature Complexity & Interdependencies

### Implementation Dependencies on Existing Code

| Feature | Depends On | How |
|---------|-----------|-----|
| `onRequest` callback | Handler instantiation | Hook into `createDeepAgentsHandler` before `fetch()` call |
| `onError` callback | SseFrameAccumulator (existing) | Hook into error catch blocks in transform pipeline |
| `onStreamEnd` callback | Stream consumption loop (existing) | Hook at end of `for await (const frame of stream)` |
| `onTransform` adapter hook | Adapter pattern (existing) | Optional callback on adapter definition; fire after each transform |
| `createLivenessProbe` | None | Pure utility; no dependencies |
| `createReadinessProbe` | HTTP fetch (built-in) | Uses `fetch()` for backend health check |
| `createShutdownState` | None | Pure state management utility |
| `timeout/AbortSignal` | Existing `fetch()` + stream pipeline | Thread `AbortSignal.timeout()` or `AbortController` through pipeline |
| `retryPolicy` config | Existing `fetchWithRetry` | Export existing logic as configurable option |
| `rateLimit` | Timer + state (built-in) | Implement token-bucket or sliding-window in handler |
| `requestQueue` | Rate limiter | Extend rate limiter with queue option |
| `circuitBreaker` | State machine + error tracking | New state machine; hooks into error callback |
| `createGracefulShutdown` | HTTP server lifecycle | Wrap `server.close()` and signal handlers |
| `streamBackpressure` | Request queue + stream `.pause()` | Integrate pause/resume into queue processing |
| Canary health gating | Readiness probe + HTTP fetch | Utility to poll readiness endpoint until healthy |
| Error reporting integration | Observability hooks + external SDK | Export adapters (pure functions mapping our events to Sentry/DD formats) |

---

## Confidence Assessment

| Area | Confidence | Evidence |
|------|------------|----------|
| **Observability hooks (callbacks)** | HIGH | Vercel AI SDK v6 docs confirm `onChunk`, `onStepFinish`, `onFinish` patterns. LiteLLM and Temporal SDKs use similar callback hooks. OpenTelemetry redaction processor is production-standard. |
| **Health/Readiness probes** | HIGH | Kubernetes official docs + Node.js reference architecture (nodeshift) standardize liveness/readiness semantics. 2026 guides (OneUptime, NodeShift) confirm current best practices. Probe endpoints (`/livez`, `/readyz`) are Kubernetes convention. |
| **Resilience patterns** | HIGH | Token-bucket vs sliding-window algorithms confirmed in Redis tutorials and 2026 comparison articles. Circuit breaker state machine (CLOSED/OPEN/HALF_OPEN) is industry-standard. Node.js backpressure patterns documented officially. |
| **Graceful shutdown** | HIGH | SIGTERM handling + drain window + readiness integration is 2026 standard for zero-downtime deploys. Node 18.2+ `closeIdleConnections()` confirmed in official Node.js docs. Kubernetes termination grace period interaction documented. |
| **Deploy strategies (canary/blue-green)** | HIGH | AWS, Flagger, and 2026 guides confirm canary/blue-green patterns. Health-check-gated traffic shifts are standard (AWS ALB readiness gates, Vercel Canary Deployments). |
| **SSE observability metrics** | MEDIUM | OneUptime blog confirms frame count, byte count, latency metrics for SSE. However, not all backends expose these metrics; sampling approach is safe. |
| **Adapter-level hooks** | MEDIUM | Pattern exists for LangGraph/LangChain adapters; enabling per-adapter observability is logical extension but not yet standard in other streaming libraries. |
| **Multi-region failover readiness** | MEDIUM | Pattern is common in infrastructure; library support is extension. Could be deferred to v1.7 if complexity is high. |

---

## Recommended MVP Definition

### Launch With (v1.6.0)

Minimum viable production-readiness. These are TABLE STAKES, not differentiators.

- [ ] **Observability hooks**: `onRequest`, `onError`, `onStreamEnd` with `{ frameCount, bytesSent, durationMs }` context
- [ ] **Health probes**: `createLivenessProbe()` + `createReadinessProbe(options)` helpers
- [ ] **Graceful shutdown**: `createGracefulShutdown(server)` + readiness integration (returns 503 during drain)
- [ ] **Timeout/AbortSignal**: Handler option `timeout: number` with `AbortSignal.timeout()` or manual `AbortController`
- [ ] **Rate limiting**: Handler option `rateLimit: { algorithm, rps, burst }` with token-bucket or sliding-window
- [ ] **Circuit breaker**: Handler option `circuitBreaker: { failureThreshold, resetTimeoutMs }` with CLOSED/OPEN/HALF_OPEN states
- [ ] **Retry policy**: Export existing `fetchWithRetry` as `retryPolicy` option; configurable backoff, jitter, max attempts
- [ ] **Deployment runbook**: Document graceful SIGTERM flow, Kubernetes config, Vercel termination settings
- [ ] **Documentation**: API reference for each hook, probe, and handler option; examples in example app

### Add After Initial Release (v1.6.x)

Once core is stable and users validate patterns:

- [ ] **Secret redaction helpers**: Export `createRedactionFilter()` + pre-built regex patterns for tokens/PII
- [ ] **Structured event types**: Export `ObservabilityEvent`, `ErrorContext`, `StreamEndResult` TypeScript interfaces
- [ ] **Adapter-level hooks**: `onTransform` and `onHeartbeat` callbacks on adapter definitions
- [ ] **Request queue + backpressure**: `requestQueue: { enabled, maxQueueSize, timeoutMs }` option; pause/resume stream integration
- [ ] **Custom dependency checks**: `createReadinessProbe(options: { customChecks?: (() => Promise<boolean>)[] })`
- [ ] **Error reporting adapters**: Example functions for Sentry, DataDog, custom backends
- [ ] **Canary health gating**: Export `isHealthyEnoughForTrafficShift(readinessUrl, minDurationMs)` utility
- [ ] **Dependency metadata in responses**: Optional `{ status, dependencies: { backend, ...} }` JSON response from probes

### Future Consideration (v1.7+)

Features requiring deeper validation or introducing complexity:

- [ ] **Adaptive timeout** based on first-chunk latency (risky, needs tuning)
- [ ] **Graceful backpressure via stream pause** (requires async coordination; lower priority)
- [ ] **Per-tool rate limits** (MCP integration; out of scope for handler)
- [ ] **Per-adapter resilience config** (useful but lower priority; global config sufficient for now)
- [ ] **Multi-region failover readiness** (extends readiness; can defer)
- [ ] **Observability filtering/sampling** (to reduce cardinality in high-volume scenarios)
- [ ] **Metrics export to Prometheus** (deferred; consumer-implemented via callbacks is better)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Phase | Priority |
|---------|------------|---------------------|-------|----------|
| Observability hooks (onRequest, onError, onStreamEnd) | HIGH | MEDIUM | v1.6 | P1 |
| Liveness/readiness probes | HIGH | MEDIUM | v1.6 | P1 |
| Graceful SIGTERM shutdown + readiness integration | HIGH | MEDIUM | v1.6 | P1 |
| Timeout/AbortSignal on handler | HIGH | LOW | v1.6 | P1 |
| Rate limiting (token-bucket or sliding-window) | HIGH | MEDIUM | v1.6 | P1 |
| Circuit breaker (CLOSED/OPEN/HALF_OPEN) | HIGH | MEDIUM | v1.6 | P1 |
| Retry policy (configurable backoff) | HIGH | LOW | v1.6 | P1 |
| Deployment runbook (SIGTERM, Kubernetes, Vercel) | HIGH | LOW | v1.6 | P1 |
| Secret/PII redaction helpers | MEDIUM | MEDIUM | v1.6.x | P2 |
| Structured event types (TypeScript interfaces) | MEDIUM | LOW | v1.6.x | P2 |
| Adapter-level hooks (onTransform, onHeartbeat) | MEDIUM | MEDIUM | v1.6.x | P2 |
| Request queue + backpressure | MEDIUM | MEDIUM | v1.6.x | P2 |
| Custom dependency checks in readiness | MEDIUM | LOW | v1.6.x | P2 |
| Error reporting adapters (Sentry, DataDog examples) | MEDIUM | LOW | v1.6.x | P2 |
| Canary health gating utility | MEDIUM | LOW | v1.6.x | P2 |
| Adaptive timeout based on latency | LOW | HIGH | v1.7+ | P3 |
| Per-tool rate limits (MCP) | LOW | HIGH | v1.7+ | P3 |
| Multi-region failover readiness | LOW | MEDIUM | v1.7+ | P3 |
| Graceful backpressure via stream pause | MEDIUM | HIGH | v1.7+ | P3 |

**Priority key:**
- **P1**: Must have for v1.6 launch. Core production-readiness. Unlocks deployment patterns.
- **P2**: Should have in v1.6.x point releases. Value-add; not blocking launch.
- **P3**: Future consideration (v1.7+). Nice-to-have; can defer if v1.6 ships on time.

---

## Observable Behavior Mapping

Each feature is testable via observable behavior. Examples:

| Feature | Observable Behavior | Test |
|---------|---------------------|------|
| `onRequest` fires | Callback invoked before backend fetch | Mock `onRequest`; assert called with `request` object |
| `onError` fires with phase context | Error callback includes `{ error, context: { phase: 'fetch'\|'stream'\|'transform' } }` | Trigger error in each phase; assert callback phase matches |
| `onStreamEnd` fires with final metrics | Callback includes `{ success, durationMs, framesSent, bytesSent }` | Complete stream; assert all metrics present and numeric |
| Liveness probe responds 200 | GET `/livez` returns 200 OK in <10ms | HTTP GET; assert status 200, latency <10ms |
| Readiness probe returns 503 during shutdown | Trigger shutdown; readiness returns 503 | Call `markShuttingDown()`; GET readiness; assert 503 |
| Readiness checks backend health | Readiness fails if backend unreachable | Mock backend as unreachable; GET readiness; assert 503 |
| Timeout aborts stuck request | Handler aborts after `timeout` ms of inactivity | Freeze backend response; assert handler aborts after timeout |
| Rate limiter rejects on threshold | Request rejected with 429 when bucket empty | Exhaust tokens; send request; assert 429 |
| Circuit breaker opens on threshold | CB transitions to OPEN after N errors | Trigger N errors; assert next request fails immediately with 503 (not 502) |
| Graceful shutdown drains requests | In-flight streams complete during drain window | Send stream; trigger SIGTERM; assert stream completes before exit |
| Retry policy respects max attempts | Retries stop after `maxAttempts` | Mock transient error; assert retried exactly N times |
| Adapter-level hook fires | onTransform fires after each adapter transform | Register onTransform hook; assert called per frame |
| Request queue accepts when rate-limited | Queue builds up as tokens are exhausted; drains as tokens refill | Exhaust tokens, send requests, assert queued; wait for refill, assert dequeued |
| Custom dependency check blocks readiness | Readiness fails if custom check fails | Register custom check that returns false; GET readiness; assert 503 |
| Error reporting adapter formats event | Sentry/DataDog adapter outputs correct shape | Map error to adapter; assert JSON shape matches expected integration format |

---

## Consumer Use Cases

### 1. **Observability Consumer: Error Tracking Integration**

**"I want to send handler errors to Sentry without modifying my app code."**

```typescript
createDeepAgentsHandler({
  backendUrl,
  onError: (error, context) => {
    Sentry.captureException(error, {
      tags: { phase: context.phase, requestId: context.requestId },
      extra: { handler: 'deepAgents' }
    });
  },
  onStreamEnd: (result) => {
    if (!result.success) {
      Sentry.captureMessage(`Stream failed: ${result.reason}`, 'error');
    }
  }
});
```

**Observable behavior:** Errors appear in Sentry dashboard with phase context.

### 2. **Resilience Consumer: Load Shedding**

**"Under spike load, shed traffic fairly with rate limiting and queue, then fail gracefully."**

```typescript
createDeepAgentsHandler({
  backendUrl,
  rateLimit: { algorithm: 'token-bucket', rps: 10, burst: 20 },
  requestQueue: { enabled: true, maxQueueSize: 100, queueTimeoutMs: 30000 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60000 }
});
```

**Observable behavior:** Normal load flows through; spike sheds with queue + rate limiting; degraded backend opens circuit breaker.

### 3. **Deployment Consumer: Kubernetes Readiness**

**"I want my Pod to be marked ready only when healthy, and to drain gracefully on redeploy."**

```typescript
const { isShuttingDown } = createShutdownState({ drainTimeoutMs: 30000 });
const readiness = createReadinessProbe({
  checkDependencies: { backend: { url: 'http://backend:8000' } },
  isShuttingDown
});

app.get('/readyz', readiness);
createGracefulShutdown(server, { drainTimeoutMs: 30000 });
```

**Observable behavior:** Pod healthy → traffic routed; SIGTERM → readiness 503 → graceful drain → exit.

### 4. **Observability Consumer: Metrics Dashboard**

**"I want to track latency percentiles, error rates, and request counts per deployment."**

```typescript
createDeepAgentsHandler({
  backendUrl,
  onStreamEnd: (result) => {
    if (result.success) {
      cloudwatch.putMetricData({
        MetricName: 'LatencyMs',
        Value: result.durationMs
      });
    }
  }
});
```

**Observable behavior:** Metrics flow to CloudWatch → P50/P95/P99 latency dashboards, error rate SLO tracking.

---

## Sources

### Observability & Callbacks
- [Vercel AI SDK Core: Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [LiteLLM Custom Callbacks Documentation](https://docs.litellm.ai/docs/observability/custom_callback)
- [Temporal TypeScript SDK Observability](https://docs.temporal.io/develop/typescript/observability)
- [How to Monitor Server-Sent Events Stream Lifecycle and Delivery Latency - OneUptime](https://oneuptime.com/blog/post/2026-02-06-sse-stream-lifecycle-opentelemetry/view)

### Health Checks & Readiness Probes
- [How to Implement Health Checks and Readiness Probes in Node.js for Kubernetes - OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-health-checks-kubernetes/view)
- [Configure Liveness, Readiness and Startup Probes - Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [GitHub - gajus/lightship: Readiness, liveness and startup checks](https://github.com/gajus/lightship)

### Resilience Patterns
- [Advanced API Rate Limiting: Sliding Windows, Token Buckets (2026) - DEV Community](https://dev.to/young_gao/advanced-api-rate-limiting-sliding-windows-token-buckets-and-distributed-counters-5afa)
- [Rate Limiting Algorithms: Token Bucket vs Sliding Window - Arcjet Blog](https://blog.arcjet.com/rate-limiting-algorithms-token-bucket-vs-sliding-window-vs-fixed-window/)
- [Resilient Node.js Microservices with Circuit Breakers - The Basic Tech Info](https://www.thebasictechinfo.com/node-js-frameworks/resilient-node-js-microservices-with-circuit-breakers-retries-and-rate-limiting-production-guide/)
- [Circuit Breaker Pattern (2026) - Layra4.dev](https://layra4.dev/pattern/circuit-breaker)
- [Backpressuring in Streams - Node.js v24.14.1 Documentation](https://nodejs.org/learn/modules/backpressuring-in-streams)

### Graceful Shutdown & Deployment
- [Node.js Graceful Shutdown: SIGTERM, Connection Draining, Kubernetes - DEV Community](https://dev.to/axiom_agent/nodejs-graceful-shutdown-the-right-way-sigterm-connection-draining-and-kubernetes-fp8)
- [How to Build a Graceful Shutdown Handler in Node.js - OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view)
- [How to Implement Blue-Green and Canary Deployment Strategies - OneUptime](https://oneuptime.com/blog/post/2026-02-20-blue-green-canary-deployments/view)
- [How to Use Pod Readiness Gates for Custom Health Conditions - OneUptime](https://oneuptime.com/blog/post/2026-02-09-pod-readiness-gates-custom-health/view)

### Secret Redaction & PII Protection
- [How to Redact Sensitive Data from Logs in OpenTelemetry - OneUptime](https://oneuptime.com/blog/post/2026-02-06-redact-sensitive-data-pii-opentelemetry-pipeline/view)
- [Mastering the OpenTelemetry Redaction Processor - Dash0](https://www.dash0.com/guides/opentelemetry-redaction-processor)

### Error Reporting & Integration
- [Sentry vs Datadog: Error Tracking vs APM Compared (2026) - Nurbak](https://nurbak.com/en/blog/sentry-vs-datadog/)
- [Datadog vs. Sentry: a side-by-side comparison for 2026 - Better Stack Community](https://betterstack.com/community/comparisons/datadog-vs-sentry/)

---

*Feature research for: TypeScript SSE proxy library with production-readiness*  
*Researched: 2026-06-06*  
*Overall confidence: HIGH*
