# Phase 18: Observability + Health + Core Resilience - Research

**Researched:** 2026-06-06  
**Domain:** Vendor-neutral observability hooks, health/readiness probes, and stateless resilience controls for edge-safe SSE streaming  
**Confidence:** HIGH on architecture and patterns; MEDIUM on implementation specifics (flagged for early validation)

## Summary

Phase 18 ships the production-readiness foundation for deepagents-nextjs: **observability hooks**, **health/readiness probes**, and **core resilience controls** (rate limiting, circuit breaker, backpressure, timeout/abort). The design maintains the zero-new-runtime-dependencies constraint while ensuring edge-runtime compatibility and stateless serverless isolation.

This research codifies findings from SUMMARY-v1.6.md, ARCHITECTURE-v1.6.md, and PITFALLS-v1.6.md into a planner-actionable specification. Phase 18 addresses 16 requirements (OBS-01..05, PROBE-01..05, RESIL-01..06) in a single atomic phase because observability, health, and resilience are tightly coupled at the handler lifecycle level and share the same edge-safety validation gates.

**Primary recommendation:** Build observability hook interface and handler integration first (Week 1), validate edge timing-API availability and callback error containment immediately, then proceed to probes and resilience controls in parallel (Weeks 2–3). Reserve Week 4 for integration testing and FD/resource cleanup validation under load.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OBS-01 | Consumer can register lifecycle hooks (`onRequest`, `onFetchStart`/`onFetchEnd`, `onStreamEnd`, `onError`) with timing, frame-count, byte-count metadata | Hooks interface design; handler integration points per ARCHITECTURE-v1.6.md; lifecycle points documented |
| OBS-02 | A consumer hook that throws is caught and never aborts or corrupts SSE stream | All callback invocations wrapped in try-catch; promise rejections handled; tested per pitfall #3 |
| OBS-03 | Observability events exclude secrets — no raw auth headers, tokens, or request bodies passed to callbacks | FrameObservation type design excludes raw data; secret filtering documented; header stripping pattern shown |
| OBS-04 | Timing metrics use edge-safe time source (works on Node, Deno, Cloudflare) without crashes | Timing API pitfall documented; safe timing helper utility recommended; per-platform requirements listed |
| OBS-05 | Observability hooks available from server package and framework/edge packages via copy pattern | Copy-not-import pattern (like SseFrameAccumulator) validated; framework packages (sveltekit, remix, edge) listed |
| PROBE-01 | Consumer can create stateless liveness probe returning `200 {status:"ok"}` | `createHealthProbe()` factory design; minimal response pattern documented |
| PROBE-02 | Consumer can create readiness probe returning `503` when draining or dependency unavailable, `200` otherwise | `createReadinessProbe()` design; local-only check pattern; integration with shutdoun hooks |
| PROBE-03 | Readiness probe supports optional, fast, consumer-supplied dependency checks (cheap by default) | Optional `checks` parameter on factory; timeout defaults (5s per check); caching pattern for external checks |
| PROBE-04 | Probe helpers usable across Next.js App Router, SvelteKit, Remix, and edge runtimes | Copy pattern eliminates Next.js dep; Web API only in edge package; framework package distribution strategy |
| PROBE-05 | Health/readiness responses minimal, leak no internal info (version, backend URL, env) by default | Minimal response type: `{ status: "..." }` only; separate authenticated debug endpoint recommended; security pitfall documented |
| RESIL-01 | Consumer can configure per-request timeout aborting upstream fetch, fully releasing timers/sockets | AbortController + AbortSignal.timeout() integration; comprehensive cleanup on abort; FD leak pitfall documented |
| RESIL-02 | Consumer can enable rate limiting (token bucket) backed by consumer-provided store; 429 response | RateLimitStore interface; check() before fetch; record() after allowed; token bucket algorithm referenced |
| RESIL-03 | Consumer can enable circuit breaker (CLOSED/OPEN/HALF_OPEN) backed by consumer-provided store; 503 response | CircuitBreakerStore interface; getState() and recordEvent() methods; state machine transitions documented |
| RESIL-04 | Handler applies backpressure, does not buffer unbounded memory on slow client | Pipeline() with backpressure handling; backpressure pitfall documented; memory-bounded streaming required |
| RESIL-05 | All resilience features hold zero module-scope state — correct under serverless/edge isolation | Consumer-provided stores (no module state); per-request context only; serverless isolation pitfall documented |
| RESIL-06 | Retry policy (existing `fetchWithRetry`) configurable via handler options, mid-stream failures never retried | Expose `retry` option structure via handler config; clarify that mid-stream failures follow different error handling |

## User Constraints (from locked decisions)

### Locked Decisions

1. **Zero new runtime dependencies** — Observability is callback hooks (no OpenTelemetry SDK), resilience uses consumer-provided stores (no Express, Cockatiel, Pino). This is a hard boundary for edge runtime and bundle size.

2. **Edge-runtime compatibility preserved** — No Node-only APIs in `/edge` package. Observability hooks are async callbacks (edge-safe). Health probes use only fetch() API. Resilience uses AbortController (available in edge). Graceful shutdown is Node.js-only (not needed in edge).

3. **Vendor-neutral observability** — Hooks are callback interfaces. Consumer wires to their APM/logging system (Datadog, Sentry, OpenTelemetry, custom). Library does NOT bundle SDK for any vendor.

4. **Zero module-scope resilience state** — Rate limiter, circuit breaker, backpressure state are delegated to consumer-provided async stores (Redis, DynamoDB, in-memory, etc.). This ensures correct behavior under serverless/edge invocation isolation.

5. **Stateless handler transforms** — Transform contract remains `(frame: SseFrame) => SseFrame | null` (or array). Observability bookkeeping is callback-based, not state captured in closures. Enables transform reuse and testing.

6. **Copy-not-import pattern for distribution** — Health probe helpers are copied (not imported) to framework packages (sveltekit, remix, edge) like SseFrameAccumulator. Avoids peerDep leakage and Next.js runtime dependency in edge.

7. **Fail-open callback error handling** — If a callback (observability, resilience store, or shutdown hook) throws or rejects, the error is logged but does NOT crash the stream. Stream continues to completion. This is CRITICAL for SSE safety.

### Claude's Discretion

- **Safe timing utility export** — Should the library export a helper like `getSafeCurrentTime()` that guards `performance.now()` availability? Recommended: YES, export it; consumers will use it for metrics.
- **Cached readiness checks** — Should readiness probe implementation include optional caching of external checks (30s TTL)? Recommended: YES, caching pattern shown in example, optional for consumers.
- **Observability sampling** — Should the library support sampling hooks (fire every Nth request) to reduce APM cost at scale? Deferred to v1.6.x, not in Phase 18 scope.

### Deferred Ideas (OUT OF SCOPE)

- Observability sampling or adaptive hook firing
- Per-tool rate limits (MCP scope)
- Multi-region circuit-breaker consistency
- Adaptive timeout based on first-chunk latency
- Built-in Prometheus scrape endpoint
- Bundled Sentry/Datadog SDKs
- Library-managed distributed resilience state persistence
- Auto-rollback or auto-remediation on error rate spikes

---

## Standard Stack

### Core

| Technology | Version/Source | Purpose | Why Standard |
|-----------|---|---|---|
| Observability: Callbacks | TypeScript interfaces (no dep) | Fire at lifecycle points (request, fetch, stream, transform, error, end) | Vendor-neutral; consumers control integration; zero runtime cost if unused |
| Health probes: fetch() + AbortSignal | Web Standard APIs | Check handler liveness and backend connectivity | Native to all runtimes (Node, Deno, Cloudflare, browser); no abstraction layer needed |
| Rate limiting: Token bucket | Embedded algorithm (~40 LOC) | Track and enforce request rate limits | Simple, stateless algorithm; consumer provides store for persistence |
| Circuit breaker: State machine | Embedded state machine (CLOSED/OPEN/HALF_OPEN) | Prevent cascading failures to backend | Standard pattern (proven in resilience4j, Polly, cockatiel); consumer provides store |
| Backpressure: Node.js streams.pipeline() or ReadableStream | Web Standard APIs | Apply backpressure when downstream is slow | Native support; prevents unbounded buffering; handlers leverage existing stream code |
| Timeout/abort: AbortController + AbortSignal.timeout() | Web Standard APIs (Node 17+, Deno, Cloudflare) | Cancel request if latency exceeds timeout | Native API; works across all runtimes; integrates with fetch() natively |
| Graceful shutdown: Node.js process.on('SIGTERM') | Node.js built-in | Handle server shutdown signals | Standard Node.js pattern; serverless runtime limitation documented |

### Supporting

| Pattern | Scope | Purpose | When to Use |
|---------|-------|---------|------------|
| Error containment (try-catch) | All callback invocations | Ensure observer errors don't crash stream | Every observability hook, resilience check, shutdown handler |
| Per-request context | sessionId, timestamps, frame counts | Enable stateless observability metrics | All lifecycle hooks; passed as parameters, not stored |
| Consumer-provided store interfaces | RateLimitStore, CircuitBreakerStore | Support pluggable resilience backends | Mandatory for rate limit and circuit breaker config |
| Secret filtering | Header stripping pattern | Exclude auth, cookies from callback context | Security requirement for OBS-03 |
| Edge-safe time source | Guarded performance.now() fallback | Account for missing timing APIs on some edge platforms | Required in observability callback examples |

### Installation

No new npm packages required. Framework packages (sveltekit, remix, edge) copy probe code from server; no imports.

```typescript
// Handler integration (existing signature extended)
import { createDeepAgentsHandler } from '@deepagents-nextjs/server';

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  
  // NEW: Observability hooks (v1.6)
  observability: {
    onRequest: ({ sessionId, backendUrl, timestamp }) => { /* ... */ },
    onError: ({ type, error, durationMs, sessionId }) => { /* ... */ },
    onStreamEnd: ({ success, frameCount, byteCount, durationMs }) => { /* ... */ },
  },
  
  // NEW: Resilience controls (v1.6)
  resilience: {
    rateLimitStore: myRedisStore,
    circuitBreakerStore: myDynamodbStore,
    timeoutMs: 30000,
  },
  
  // NEW: Shutdown hook (v1.6)
  onShutdown: ({ reason, signal }) => { /* ... */ },
});
```

---

## Architecture Patterns

### Recommended Project Structure (Additions)

```
packages/server/src/
├── observability.ts        # NEW: ObservabilityHooks interface + types
├── health.ts               # NEW: createHealthProbe, createReadinessProbe
├── resilience.ts           # NEW: RateLimitStore, CircuitBreakerStore interfaces + check functions
├── shutdown.ts             # NEW: createShutdownOrchestrator, installShutdownHandler
├── handler.ts              # MODIFIED: add hooks firing + resilience checks + timeout/abort
├── index.ts                # MODIFIED: export new types + functions
│
packages/sveltekit/src/
├── health.ts               # NEW (copied from server)
├── handler.ts              # MODIFIED: same hooks + resilience support
│
packages/remix/src/
├── health.ts               # NEW (copied from server)
├── handler.ts              # MODIFIED: same hooks + resilience support
│
packages/edge/src/
├── health.ts               # NEW (copied from server, Web API only)
├── handler.ts              # MODIFIED: same hooks + resilience support (no SIGTERM)
│
apps/example/
├── app/api/health/route.ts        # NEW: liveness check endpoint
├── app/api/ready/route.ts         # NEW: readiness check endpoint
├── instrumentation.ts             # NEW: graceful shutdown setup
│
apps/open-swe/
├── instrumentation.ts             # NEW: graceful shutdown setup
```

### Pattern 1: Observability Hooks (Lifecycle-Based Instrumentation)

**What:** Fire async callbacks at key handler lifecycle points. Each callback receives context (sessionId, timing, metadata) but NO raw request/response bodies or tokens. Errors in callbacks are caught and logged; they never interrupt the stream.

**When to use:** Every request needs observability: measure latency, count frames, detect errors. Callbacks are vendor-neutral so consumer chooses integration (Datadog, Sentry, custom logging, etc.).

**Example:**

```typescript
// Source: ARCHITECTURE-v1.6.md, handler integration

export interface ObservabilityHooks {
  onRequest?: (context: {
    sessionId: string;
    backendUrl: string;
    timestamp: number;
  }) => void | Promise<void>;

  onFetchStart?: (context: {
    backendUrl: string;
    timeoutMs?: number;
    timestamp: number;
  }) => void | Promise<void>;

  onFetchEnd?: (context: {
    backendUrl: string;
    status?: number;
    bytesReceived: number;
    durationMs: number;
    error?: Error;
    timestamp: number;
  }) => void | Promise<void>;

  onStreamStart?: (context: {
    backendUrl: string;
    status: number;
    timestamp: number;
  }) => void | Promise<void>;

  onTransformBegin?: (context: {
    frameIndex: number;
    frameBytes: number;
    timestamp: number;
  }) => void | Promise<void>;

  onTransformEnd?: (context: {
    frameIndex: number;
    dropped: boolean;
    outputCount: number;
    durationMs: number;
    timestamp: number;
  }) => void | Promise<void>;

  onError?: (context: {
    type: "fetch" | "stream" | "transform" | "rate-limit" | "circuit-breaker";
    error: Error;
    durationMs: number;
    frameIndex?: number;
    sessionId: string;
    timestamp: number;
  }) => void | Promise<void>;

  onStreamEnd?: (context: {
    success: boolean;
    frameCount: number;
    byteCount: number;
    durationMs: number;
    error?: Error;
    timestamp: number;
  }) => void | Promise<void>;
}

// Handler integration: wrap every hook invocation in try-catch
try {
  await hooks.onRequest?.({
    sessionId,
    backendUrl: options.backendUrl,
    timestamp: startedAt,
  });
} catch (e) {
  console.error("onRequest hook failed:", e);
  // Continue — error does NOT abort handler
}
```

**Why this pattern:** Callbacks decouple observability from the handler. Consumer chooses where metrics go (APM, logging, custom endpoint). No bundled SDK = lean, edge-compatible, vendor-neutral.

### Pattern 2: Health Probes (Reusable Liveness/Readiness Factories)

**What:** Two helper functions (`createHealthProbe`, `createReadinessProbe`) that return status objects. Liveness is minimal (handler alive?). Readiness includes optional dependency checks and returns 503 when dependencies unavailable.

**When to use:** Kubernetes/load-balancer health checks, canary promotion gates, manual status checks.

**Example:**

```typescript
// Source: ARCHITECTURE-v1.6.md, health.ts

export async function createHealthProbe(
  checks: Array<{
    name: string;
    check: () => Promise<boolean>;
    timeoutMs?: number;
  }>
): Promise<{ ok: boolean; checks: Record<string, boolean>; timestamp: number }> {
  const results: Record<string, boolean> = {};
  const timestamp = Date.now();

  await Promise.all(
    checks.map(async (c) => {
      try {
        const raceResult = await Promise.race([
          c.check(),
          new Promise<false>((_, reject) =>
            setTimeout(
              () => reject(new Error("Health check timeout")),
              c.timeoutMs ?? 5000
            )
          ),
        ]);
        results[c.name] = raceResult;
      } catch (e) {
        results[c.name] = false;
      }
    })
  );

  return {
    ok: Object.values(results).every((v) => v === true),
    checks: results,
    timestamp,
  };
}

export async function createReadinessProbe(config: {
  backendUrl: string;
  getToken?: (req: NextRequest) => Promise<string | null | undefined> | string | null | undefined;
  timeoutMs?: number;
}): Promise<{ ready: boolean; backend: boolean; timestamp: number }> {
  const timestamp = Date.now();

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? 5000
    );

    const headers: Record<string, string> = {};
    const token = await config.getToken?.();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(config.backendUrl, {
      method: "HEAD",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    return {
      ready: response.ok,
      backend: response.ok,
      timestamp,
    };
  } catch (e) {
    return {
      ready: false,
      backend: false,
      timestamp,
    };
  }
}

// Usage in app endpoint
export const GET = async (req: NextRequest) => {
  const health = await createHealthProbe([
    {
      name: "handler",
      check: async () => true, // Always passes
    },
  ]);

  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
  });
};
```

**Why this pattern:** Probes are simple, reusable, and follow Kubernetes conventions. Minimal response prevents info disclosure. Copied to framework packages avoids Next.js dep.

### Pattern 3: Resilience Controls (Consumer-Provided Store Pattern)

**What:** Rate limiting, circuit breaker, backpressure, and timeout checks integrated into handler. All state is consumer-provided via async store interfaces. Zero module-scope state (serverless-safe).

**When to use:** Production deployments under load. Rate limit to protect backend. Circuit breaker to prevent cascading failures. Backpressure to prevent OOM on slow clients.

**Example:**

```typescript
// Source: ARCHITECTURE-v1.6.md, resilience.ts

export interface RateLimitStore {
  check: (key: string) => Promise<boolean>;
  record: (key: string, windowMs: number) => Promise<void>;
}

export interface CircuitBreakerStore {
  getState: (key: string) => Promise<"closed" | "open" | "half-open">;
  recordEvent: (
    key: string,
    outcome: "success" | "failure",
    resetAfterMs?: number
  ) => Promise<void>;
}

export interface ResilienceConfig {
  rateLimitStore?: RateLimitStore;
  rateLimitKey?: (req: NextRequest) => string;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;

  circuitBreakerStore?: CircuitBreakerStore;
  circuitBreakerKey?: (req: NextRequest) => string;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerResetMs?: number;

  backpressureStore?: RateLimitStore;
  backpressureKey?: (req: NextRequest) => string;
  backpressureMax?: number;
  backpressureRejectAfterMs?: number;

  timeoutMs?: number;
}

// Handler integration: check before fetch
if (resilience.rateLimitStore) {
  const key = resilience.rateLimitKey?.(req) ?? sessionId;
  const allowed = await resilience.rateLimitStore.check(key);
  if (!allowed) {
    await hooks.onError?.({
      type: "rate-limit",
      error: new Error("Rate limited"),
      durationMs: Date.now() - startedAt,
      sessionId,
      timestamp: Date.now(),
    });
    return NextResponse.json(
      { error: "Rate limited" },
      { status: 429 }
    );
  }
  await resilience.rateLimitStore.record(
    key,
    resilience.rateLimitWindowMs ?? 60000
  );
}

// Consumer implementation (in-memory)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export const inMemoryRateLimitStore: RateLimitStore = {
  check: async (key: string) => {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      return true;
    }
    return entry.count < 100;
  },
  record: async (key: string, windowMs: number) => {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
    }
  },
};
```

**Why this pattern:** Consumer-provided stores support all backends (Redis, DynamoDB, in-memory, etc.). No module-scope state = works under serverless isolation. Checks return early (429/503) before expensive fetch.

### Pattern 4: Graceful Shutdown (Optional Orchestrator)

**What:** Listen to Node.js SIGTERM/SIGINT signals, flip readiness to 503, drain in-flight streams, then exit. Optional because serverless has limited shutdown window (documented).

**When to use:** Node.js server deployments that need to gracefully handle rolling restarts. NOT usable on Cloudflare Workers (no SIGTERM) or Vercel (500ms window only). Document limitations clearly.

**Example:**

```typescript
// Source: ARCHITECTURE-v1.6.md, shutdown.ts

export function createShutdownOrchestrator(config: {
  graceMs?: number;
  onDrain?: () => Promise<void>;
}): ShutdownOrchestrator {
  let shutdownStarted = false;
  const drainPromises: Promise<void>[] = [];

  return {
    onSignal: async (signal: NodeJS.Signals) => {
      if (shutdownStarted) return;
      shutdownStarted = true;

      console.log(`Received ${signal}, starting graceful shutdown...`);

      // Flip readiness to 503
      readinessDraining = true;

      // Call custom drain
      if (config.onDrain) {
        await Promise.race([
          config.onDrain(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, config.graceMs ?? 30000)
          ),
        ]);
      }

      // Wait for pending requests
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, config.graceMs ?? 30000)
      );
      await Promise.race([Promise.all(drainPromises), timeout]);

      console.log("Shutdown complete");
      process.exit(0);
    },
  };
}

export function installShutdownHandler(
  orchestrator: ShutdownOrchestrator
): void {
  process.on("SIGTERM", () => orchestrator.onSignal("SIGTERM"));
  process.on("SIGINT", () => orchestrator.onSignal("SIGINT"));
}

// Usage in instrumentation.ts
export const register = async () => {
  const orchestrator = createShutdownOrchestrator({
    graceMs: 30000,
    onDrain: async () => {
      cleanupExpiredApprovals();
      cleanupStreamRegistry();
    },
  });

  installShutdownHandler(orchestrator);
};
```

**Why this pattern:** Optional (not forced on consumers). Composable (custom drain logic). Best-effort only (serverless limitations documented).

### Anti-Patterns to Avoid

1. **Synchronous hook invocations:** Never fire hooks without `await`; next line may execute before callback completes. Always wrap in try-catch.

2. **Hard-coded resilience state:** Never store rate-limit or circuit-breaker state at module scope. Breaks serverless isolation. Delegate to consumer-provided async stores.

3. **Mixing observability with business logic:** Hooks are read-only telemetry. Do NOT make business decisions based on hook return values. Hooks cannot gate requests (that's resilience controls' job).

4. **Shutdown logic in handler factory:** Never install signal handlers inside the factory. Register signals at app startup (instrumentation.ts), not per-handler.

5. **Modal/combined health endpoints:** Liveness and readiness serve different purposes. Separate endpoints so Kubernetes can distinguish "is process alive?" from "can it serve traffic?". Never combine them.

6. **Expensive checks in readiness probes:** Readiness must complete <10ms. External dependency checks (backend connectivity) should be cached with TTL or skipped entirely in readiness path.

7. **Leaking secrets in probe responses:** Health/readiness responses must be minimal: `{ status: "..." }` only. Never include version, env vars, backend URLs, or internal info.

8. **Unbounded backpressure buffering:** Always use `pipeline()` or respect downstream readiness. Manual read/write loops must check backpressure signals. Test memory under slow-client load.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Timing measurements on edge | Custom timing API wrapper | Export safe timing helper; guard performance.now() availability | Edge runtimes have inconsistent timing APIs (Cloudflare pre-2025 lacks perf.now); guarding is non-trivial |
| Rate limiting | Custom in-memory rate limiter | Consumer-provided async store interface (tokens/Redis/DynamoDB) | Token bucket semantics are simple but state persistence is complex; consumer's backend is the right layer |
| Circuit breaker state | Hardcoded CLOSED/OPEN logic | Consumer-provided async store with state machine | State transitions (closed→open on failures, open→half-open on timeout) need persistence across requests |
| Backpressure | Manual read/write loops | Node.js `pipeline()` or ReadableStream backpressure signals | Missing backpressure causes unbounded buffering (OOM); pipeline() handles it automatically |
| AbortSignal cleanup | Ignore abort errors | Comprehensive finally block cleanup (abort controller, timers, sockets) | Incomplete cleanup causes FD leaks under load (verified with lsof testing) |
| Callback error handling | Let exceptions propagate | Try-catch wrapper + log, continue stream | Uncaught callback errors crash SSE stream mid-response (client gets truncated data) |
| Health endpoint response | Return full app state | Minimal `{ status: "..." }` only | Rich health responses expose internal architecture (version, env, dependencies) for attack surface scanning |
| Graceful shutdown | Process-level SIGTERM handling in handler | Optional orchestrator at app startup (instrumentation.ts) | SIGTERM should be app-wide, not per-handler; helps avoid double-registration and signal handler leaks |

**Key insight:** The patterns above (timing guards, store interfaces, callback wrapping, minimal probes) exist because streaming SSE, edge runtimes, and stateless serverless create failure modes that aren't obvious in traditional server code. These aren't premature optimization — they're correctness requirements.

---

## Common Pitfalls

### Pitfall 1: Edge Timing-API Availability Mismatch

**What goes wrong:** `performance.now()` or `Date.now()` is unavailable or unreliable on some edge runtimes (Cloudflare pre-2025, Deno Deploy), causing timing metrics to be empty/null or hook throws.

**Why it happens:** Edge runtimes gradually add Web APIs. Cloudflare's `performance.now()` requires `nodejs_compat` flag + compatibility_date 2025-03-17 or later. Deno Deploy has CPU time limits that affect high-frequency calls.

**Prevention:**
- Document timing API requirements per platform in observability hooks docs
- Export a safe timing utility: `getSafeCurrentTime()` that guards availability
- Provide consumer with example callback that safely wraps timing calls
- Test on actual Cloudflare Worker and Deno Deploy (not just Node local dev)

**Validation gate (Phase 18):** Verify `performance.now()` reliability on Cloudflare with current compatibility date and Deno Deploy under realistic frame frequencies.

---

### Pitfall 2: Secrets and Tokens Leakage Through Observability Callbacks

**What goes wrong:** Raw request/response objects or frame data passed to callbacks contain Authorization headers, API tokens, or sensitive payloads. If consumer or monitoring service doesn't filter, credentials end up in logs/APM for indefinite storage.

**Why it happens:** Callbacks pass raw data for flexibility (vendor-neutral design). Developers don't realize what data is in the callback. Monitoring services historically don't filter by default.

**Prevention:**
- Define `ObservabilityContext` types to exclude raw frames/requests/responses
- Document security requirement: "Never log raw objects; extract only safe fields"
- Example callback shows secure pattern (measure latency, count frames, omit raw data)
- If handler exposes request details, strip sensitive headers (Authorization, x-api-key, cookie)
- Test: FrameObservation type doesn't include raw objects (static check)

**Validation gate (Phase 18):** Security audit of FrameObservation interface; verify no raw frame/request/response fields are passed to callbacks.

---

### Pitfall 3: Observability Callbacks Throwing Exceptions Crash SSE Stream

**What goes wrong:** Consumer's observability callback throws or rejects; exception propagates; stream crashes mid-response; client receives truncated/corrupted SSE.

**Why it happens:** Callbacks are user code (can fail). Streaming pipeline doesn't wrap callback invocations in try-catch. SSE has no error recovery (mid-stream errors are unrecoverable).

**Prevention:**
- Wrap ALL callback invocations in try-catch; log error but do NOT rethrow
- Handle Promise rejections if callback returns Promise
- Document: "Callbacks must not throw. Errors are logged but do not interrupt stream."
- Test: Callback throws on every frame → stream still completes cleanly
- Test: Callback returns rejected Promise → rejection is caught

**Validation gate (Phase 18, CRITICAL):** Integration test where callback throws on every frame; verify stream completes with client receiving all frames.

---

### Pitfall 4: Resilience State at Module Scope Breaks Serverless/Edge Isolation

**What goes wrong:** Rate limiter or circuit breaker state stored at module scope (global let/const). Under serverless, invocations share module but isolation is unpredictable. State becomes inconsistent. Protection is ineffective.

**Why it happens:** Developers think module scope is fast and simple. Constraint (no module state) is in docs but easy to violate during implementation.

**Prevention:**
- Hard requirement: Zero module-scope state for rate limit/circuit breaker
- Resilience is configuration only; consumer implements stores
- Code review: No module-level `let`/`const` holding resilience state
- Test: Multiple concurrent requests with rate limit config don't interfere

**Validation gate (Phase 18, CRITICAL):** Static check for module-scope state; concurrent request test with rate limiter ensuring isolation.

---

### Pitfall 5: Backpressure Not Applied to Upstream Fetch

**What goes wrong:** Handler reads from backend without waiting for downstream readiness. Data accumulates in buffer. Memory grows unbounded. Process OOMs.

**Why it happens:** `read()` returns next chunk immediately; doesn't wait for downstream. `write()` returning false means "pause upstream" — easy to miss.

**Prevention:**
- Use `pipeline()` which handles backpressure automatically
- If manual read/write loop: check backpressure signals; pause upstream if needed
- Document backpressure handling in handler code
- Test: Slow client (100-byte buffer), fast backend → memory stays bounded

**Validation gate (Phase 18, CRITICAL):** Memory test under slow-client load (1000 concurrent, 10KB/s throughput); verify memory <50MB (not unbounded).

---

### Pitfall 6: AbortSignal Doesn't Clean Up Resources (FD/Socket Leaks)

**What goes wrong:** Handler passes `signal: abortSignal` to fetch but doesn't ensure full cleanup. Timers, sockets remain. FD count grows. Eventually ulimit exhausted.

**Why it happens:** Abort cancels fetch but doesn't guarantee cleanup of all associated resources. Multiple teardown paths (abort, error, close) can race.

**Prevention:**
- Comprehensive finally block cleanup: abort controller, timers, sockets
- Use `pipeline()` which auto-destroys streams on error
- Test: Abort 1000 requests mid-stream; measure FD count (must return to baseline)
- Use `lsof -p <pid>` to inspect FD count before/after stress test

**Validation gate (Phase 18, CRITICAL):** Stress test with 1000 aborted requests; verify FD count stable (no CLOSE_WAIT socket accumulation).

---

### Pitfall 7: Readiness Probes Performing Expensive Checks (Cascading Failures)

**What goes wrong:** Readiness probe checks backend connectivity (expensive). Under load, probe requests queue behind real requests. Probe times out. LB removes instance. Cascading failure.

**Why it happens:** Readiness is often on critical path. If readiness probe is expensive, it starves under load. Aggressive LB retry (3 failed probes = remove) causes cascade.

**Prevention:**
- Readiness must be local and cheap (<10ms). No external dependency checks by default.
- Separate liveness (process alive?) from readiness (can serve?).
- If must check external dependencies, cache result (30s TTL) or skip readiness entirely.
- Document: "Readiness probes must not make backend round-trips."
- Test: Readiness completes in <10ms under 1000 concurrent requests

**Validation gate (Phase 18):** Load test readiness probe at 1000 req/s; verify <10ms latency p99.

---

### Pitfall 8: Graceful Shutdown Impossible on Serverless

**What goes wrong:** Handler implements graceful shutdown (wait for pending requests, then exit). On Vercel, SIGTERM has 500ms window. Streaming responses longer than 500ms are killed mid-stream.

**Why it happens:** Serverless runtimes have strict shutdown timeouts. Vercel ~500ms, Cloudflare no SIGTERM at all. Developers assume traditional server behavior.

**Prevention:**
- Document graceful shutdown limitation clearly: "Best-effort only. Vercel 500ms window, Cloudflare not supported."
- Don't rely on graceful shutdown for long-running streams.
- Optional orchestrator (not forced on consumers).
- For long-running streams, recommend client-side reconnection + resume logic.

**Note (Phase 18):** Graceful shutdown is not part of Phase 18 scope (deferred to Phase 19). But understand limitation when designing readiness probe (which IS Phase 18).

---

### Pitfall 9: Health Endpoints Leaking Internal Information

**What goes wrong:** Health endpoint returns version, env vars, backend URL, dependency versions. Attacker discovers info for targeted attacks.

**Why it happens:** Developers think health endpoint is internal-only. Exposing detail is useful for debugging, so detail is added.

**Prevention:**
- Health/readiness responses must be minimal: `{ status: "..." }` only
- Separate public health from authenticated debug endpoint
- No version, env, backend URL, dependency info
- Document security requirement
- Test: Health endpoint contains only `{ status: ... }`, no other fields

**Validation gate (Phase 18):** Security audit of health/readiness response types; verify minimal content.

---

### Pitfall 10: Canary/Blue-Green Deployment Misconfiguration

**What goes wrong:** Canary intended 5/95 split, but LB config error results in 50/50 split. New code exposed to more traffic than intended.

**Why it happens:** LB config is platform-specific and complex. Easy to miscalculate weights. Config not tested before deploy.

**Prevention:**
- Test canary/blue-green config in staging before prod
- Verification checklist: send 100 test requests, verify ~95 hit blue, ~5 hit green
- Include automated verification in deploy runbook
- Document platform-specific steps (AWS ALB, Kubernetes, Vercel)

**Note (Phase 18):** Canary/blue-green deploy is Phase 19/20 scope. Phase 18 focuses on readiness probe that gates canary promotion.

---

## Validation Architecture

**Test Framework:** Vitest (packages/server/vitest.config.ts, Node environment)  
**Commands:**
- Quick run (unit only): `pnpm test --run` (from packages/server)
- Full suite: `pnpm test --run --coverage` (includes coverage report)
- Watch mode (dev): `pnpm test` (from packages/server)

**Wave 0 Test Scaffolding** (must exist before implementation):

| Test File | Coverage | Type |
|-----------|----------|------|
| `observability.test.ts` | Hook interface, try-catch wrapping, callback error scenarios | Unit |
| `health.test.ts` | `createHealthProbe`, `createReadinessProbe`, timeout scenarios | Unit |
| `resilience.test.ts` | Rate limit check, circuit breaker state machine, backpressure | Unit |
| `handler.integration.test.ts` | End-to-end: hooks fire correctly, resilience checks reject early | Integration |
| `handler.callback-safety.test.ts` | Callback throws → stream continues, Promise rejection handled | Smoke/Integration |
| `handler.resource-cleanup.test.ts` | AbortSignal abort → all timers cleared, FD count stable | Smoke |
| `handler.backpressure.test.ts` | Slow downstream → memory bounded, upstream slowed | Load |
| `edge-timing.test.ts` | Safe timing utility works on simulated edge (no performance.now()) | Unit |
| `security.test.ts` | FrameObservation has no raw frames/requests, headers stripped | Unit |

**Per-Task Test Type:**

| Task | Test Type | Key Assertions |
|------|-----------|-----------------|
| Implement observability.ts interface | Unit | Interface compiles, lifecycle points defined |
| Add hook firing to handler.ts | Integration | `onRequest` fired with sessionId, hook errors caught |
| Add try-catch wrapping to all hooks | Smoke | Callback throws → logged, stream continues |
| Implement health.ts probes | Unit | Liveness returns 200, readiness respects timeout |
| Add health probes to handler config | Integration | Probes callable from handler endpoints |
| Implement resilience.ts interfaces | Unit | Store interfaces defined, check functions return boolean |
| Add rate limit check to handler | Integration | Rate limit exceeded → 429 response |
| Add circuit breaker check to handler | Integration | Circuit breaker open → 503 response |
| Add timeout/AbortSignal to handler | Integration | Timeout expires → upstream aborted, cleanup complete |
| Test backpressure handling | Load | Slow client (100-byte buffer) + fast backend → memory stable |
| Test AbortSignal FD cleanup | Smoke | 1000 aborts → FD count returns to baseline |
| Implement graceful shutdown (Phase 19, not Phase 18) | Unit | Signal handler installs correctly |

**Coverage Targets:**
- Lines: 95%
- Branches: 90%
- Functions: 95%
- Statements: 95%

**Mutation Testing:** Stryker config exists; verify key mutations fail:
- Remove try-catch from hook invocation → test fails (callback error not caught)
- Remove module-scope state validation → can add it back (scaffolding check)
- Change backpressure check → test fails (memory grows unbounded)

---

## Code Examples

Verified patterns from project codebase and ARCHITECTURE-v1.6.md:

### Example 1: Observability Hook Firing with Error Containment

```typescript
// Source: ARCHITECTURE-v1.6.md, handler.ts integration

const startedAt = Date.now();
const sessionId = crypto.randomUUID();
const hooks = options.observability ?? {};

// Fire onRequest hook
try {
  await hooks.onRequest?.({
    sessionId,
    backendUrl: options.backendUrl,
    timestamp: startedAt,
  });
} catch (e) {
  console.error("[deepagents/server] onRequest hook failed:", e);
  // Continue — do NOT return error; hook failure doesn't gate request
}

// ... later, fire onFetchEnd hook
try {
  await hooks.onFetchEnd?.({
    backendUrl: options.backendUrl,
    status: backendResponse.status,
    bytesReceived: receivedBytes,
    durationMs: Date.now() - startedAt,
    timestamp: Date.now(),
  });
} catch (e) {
  console.error("[deepagents/server] onFetchEnd hook failed:", e);
}
```

**Why:** Error in hook is logged but NEVER propagates. Stream continues to completion. This is CRITICAL for SSE safety.

### Example 2: Safe Timing Utility for Edge Runtimes

```typescript
// Source: Recommended for v1.6 observability edge safety

/**
 * Get current time in milliseconds using the most reliable API
 * available in the current runtime.
 *
 * - Node.js: performance.now() (µs precision)
 * - Cloudflare Workers (with nodejs_compat): performance.now()
 * - Deno: performance.now()
 * - Fallback: Date.now() (ms precision)
 *
 * Note: Cloudflare Workers require `nodejs_compat` flag and
 * compatibility_date >= 2025-03-17 for performance.now() support.
 */
export function getSafeCurrentTime(): number {
  try {
    if (typeof performance !== "undefined" && performance.now) {
      return Math.round(performance.now());
    }
  } catch {
    // In case performance.now() throws (shouldn't happen, but guard)
  }
  return Date.now();
}

// Usage in observability callback
export const observability = {
  onTransformBegin: ({ frameIndex, frameBytes }) => {
    const now = getSafeCurrentTime();
    metrics.recordFrameStart({ frameIndex, timestamp: now });
  },
};
```

### Example 3: Rate Limit Check (Early Reject Pattern)

```typescript
// Source: ARCHITECTURE-v1.6.md, handler.ts resilience integration

// Early in handler, before expensive fetch
if (resilience.rateLimitStore) {
  const key = resilience.rateLimitKey?.(req) ?? sessionId;
  const allowed = await resilience.rateLimitStore.check(key);
  if (!allowed) {
    // Fire error hook
    try {
      await hooks.onError?.({
        type: "rate-limit",
        error: new Error("Rate limited"),
        durationMs: Date.now() - startedAt,
        sessionId,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error("[deepagents/server] onError hook failed:", e);
    }
    // Return 429 immediately (no fetch)
    return NextResponse.json(
      { error: "Rate limited" },
      { status: 429 }
    );
  }
  // Record this request in the rate limiter
  await resilience.rateLimitStore.record(
    key,
    resilience.rateLimitWindowMs ?? 60000
  );
}
```

**Why:** Check before expensive fetch saves bandwidth/backend load. Record after allowed ensures accurate token consumption.

### Example 4: Consumer-Provided Rate Limit Store (In-Memory Example)

```typescript
// Source: Consumer application code (not library)

const rateLimitMap = new Map<
  string,
  { count: number; resetAt: number }
>();

export const inMemoryRateLimitStore: RateLimitStore = {
  check: async (key: string) => {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      return true; // Window expired or no entry, allow
    }
    return entry.count < 100; // Allow if under limit
  },

  record: async (key: string, windowMs: number) => {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
    }
  },
};

// Wire into handler
const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  resilience: {
    rateLimitStore: inMemoryRateLimitStore,
    rateLimitWindowMs: 60000, // 1 minute
    rateLimitMax: 100,
  },
});
```

### Example 5: Health Probe Usage in Next.js App

```typescript
// Source: ARCHITECTURE-v1.6.md, health probe example

// apps/example/app/api/health/route.ts
import { createHealthProbe } from "@deepagents-nextjs/server";

export const GET = async (req: NextRequest) => {
  const health = await createHealthProbe([
    {
      name: "handler",
      check: async () => true, // Handler is always alive if this runs
    },
    {
      name: "backend",
      check: async () => {
        try {
          const res = await fetch(
            `${process.env.BACKEND_URL}/health`,
            { method: "HEAD", timeout: 1000 }
          );
          return res.ok;
        } catch {
          return false;
        }
      },
      timeoutMs: 2000,
    },
  ]);

  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
  });
};

// apps/example/app/api/ready/route.ts
import { createReadinessProbe } from "@deepagents-nextjs/server";

export const GET = async (req: NextRequest) => {
  const ready = await createReadinessProbe({
    backendUrl: process.env.BACKEND_URL!,
    getToken: async () => process.env.AUTH_TOKEN,
    timeoutMs: 5000,
  });

  return NextResponse.json(ready, {
    status: ready.ready ? 200 : 503,
  });
};
```

---

## State of the Art

### Edge Runtime Timing APIs

| Runtime | performance.now() | Date.now() | Status | Notes |
|---------|---|---|---|---|
| Node.js 17+ | ✓ Native (µs precision) | ✓ Native (ms) | Stable | Standard behavior |
| Vercel Edge Functions | ✓ Native | ✓ Native | Stable | Works like Node.js |
| Cloudflare Workers | ✓ With nodejs_compat + compat_date >= 2025-03-17 | ✓ Native (ms) | Changing | Older compatibility dates lack perf.now(); guard required |
| Deno Deploy | ✓ Native (50ms CPU limit) | ✓ Native | Stable but Limited | Works but CPU limits affect high-frequency timing |
| AWS Lambda | ✓ Native (Node.js 18+) | ✓ Native | Stable | Container reuse allows measurement |

**State of the art (2026):** Guard `performance.now()` availability; provide fallback to `Date.now()`. Document per-platform requirements.

### Observability Integration Patterns

| Pattern | Library/Tool | Status | Notes |
|---------|---|---|---|
| Vendor SDK bundling | OpenTelemetry SDK | ❌ REJECTED | Forces vendor lock-in, breaks edge |
| Callback hooks | Custom (AI SDK v6 style) | ✓ RECOMMENDED | Vendor-neutral, zero deps, edge-safe |
| Sampling/gating | Conditional hook firing | ⏸ DEFERRED to v1.6.x | Not Phase 18 scope |
| APM integration examples | Sentry, Datadog, Custom | ✓ DOCUMENTED | Phase 20 (Launch) |

### Resilience Patterns

| Pattern | Status | Notes |
|---------|--------|-------|
| Token bucket rate limiting | ✓ EMBEDDED | Simple algorithm, consumer provides state store |
| Circuit breaker (state machine) | ✓ EMBEDDED | CLOSED/OPEN/HALF_OPEN, consumer provides store |
| Adaptive backpressure | ✓ NATIVE (pipeline) | Node.js streams.pipeline() handles automatically |
| Timeout/abort | ✓ NATIVE (AbortController) | Web standard, available in all runtimes |
| Graceful shutdown | ✓ OPTIONAL | SIGTERM handlers, best-effort (serverless limited) |

---

## Open Questions

1. **Cloudflare Workers timing API post-2025-03-17**
   - What we know: Compatibility date 2025-03-17 introduced `performance.now()` support with nodejs_compat flag
   - What's unclear: Is microsecond precision reliable? Does it work under all CPU time limits?
   - Recommendation: Test on actual Cloudflare Worker with current compatibility date; include in Phase 18 validation gate

2. **Deno Deploy CPU time limits and timing measurements**
   - What we know: Deno Deploy has CPU time limit (~50ms per request in some tiers)
   - What's unclear: Does high-frequency `performance.now()` calls affect CPU budget? Can we measure streaming frames reliably?
   - Recommendation: Load test on Deno Deploy with realistic frame frequencies; validate timing measurements don't exceed CPU budget

3. **Health probe performance under extreme load**
   - What we know: Readiness probes must complete <10ms to avoid cascading failures
   - What's unclear: Can `createReadinessProbe` meet this at 1000 req/s with concurrent checks?
   - Recommendation: Load test readiness probe at 1000 req/s; measure p99 latency; optimize if needed (caching, parallelization)

4. **Framework package code stability**
   - What we know: Copy pattern (like SseFrameAccumulator) avoids peerDep leakage
   - What's unclear: How frequently will health probes need updates? Can we justify copying code instead of importing?
   - Recommendation: Code is small (~40 lines each) and stable; copy is maintainable. If probes change, update all copies together

5. **Observability sampling at scale**
   - What we know: Sampling deferred to v1.6.x
   - What's unclear: When does hook overhead become bottleneck? What sampling rate is safe?
   - Recommendation: Benchmark hook firing at 1000+ req/s; flag for v1.6.x design if needed

---

## Sources

### Primary (HIGH confidence)

- **ARCHITECTURE-v1.6.md** — Detailed integration design, component boundaries, lifecycle diagrams, handler.ts modifications
- **PITFALLS-v1.6.md** — 10 critical/moderate pitfalls with mitigation strategies (timing APIs, secrets leakage, callback safety, module-scope state, backpressure, FD cleanup, readiness cascades, graceful shutdown limits, info disclosure, canary config)
- **SUMMARY-v1.6.md** — Executive summary, stack decisions, feature tiers, build order, validation gates
- **REQUIREMENTS.md** — 21 requirements mapped to phases; Phase 18 owns OBS-01..05, PROBE-01..05, RESIL-01..06
- **Project codebase** — handler.ts, accumulator.ts, stream-registry.ts, reconnect.ts (patterns for per-request context, copy-not-import, error handling)

### Secondary (MEDIUM confidence)

- **Kubernetes Probes docs** (kubernetes.io) — Liveness/readiness probe semantics, conventions
- **Resilience4j docs** (resilience4j.readme.io) — Circuit breaker state machine reference
- **Node.js Stream docs** (nodejs.org) — Backpressure handling, pipeline() documentation
- **AbortController MDN** (developer.mozilla.org) — Abort API semantics and cleanup guarantees
- **Cloudflare Workers changelog** (2025-03-17) — Performance.now() availability with nodejs_compat
- **Vercel Functions graceful shutdown** (changelog 2025-09) — 500ms shutdown window documented
- **OpenTelemetry docs** (opentelemetry.io) — Context for why callbacks instead of SDK as runtime dep

### Tertiary (LOW confidence — flagged for validation)

- **Medium/Dev.to articles (2026):** Backpressure in JavaScript, Node.js stream performance, health check design — Articles on emerging patterns; verify specific claims against official docs before implementation

---

## Metadata

**Confidence breakdown:**
- Observability hooks architecture: **HIGH** — Lifecycle points validated against handler.ts; callbacks are standard Node.js pattern; interface design straightforward
- Health probes: **HIGH** — Follows Kubernetes conventions; implementations are simple and well-tested
- Resilience controls: **HIGH** (architecture), **MEDIUM** (implementation specifics) — Store interface pattern is sound; rate limiting and circuit breaker algorithms are standard; implementation details (state transitions, resetAfterMs) need Phase 18 validation
- Edge runtime compatibility: **HIGH** — Web API only (fetch, AbortController, ReadableStream); Node-only code isolated to graceful shutdown (explicitly optional)
- Pitfalls: **HIGH** — All pitfalls sourced from PITFALLS-v1.6.md research; documented with prevention + validation strategies

**Valid until:** 2026-07-06 (30 days — stable domain; update if edge runtime APIs change)

**Research date:** 2026-06-06

---

## Integration Checklist for Planner

Before creating PLAN.md for Phase 18, ensure:

- [ ] Phase 18 directory exists: `.planning/phases/18-observability-health-resilience/`
- [ ] RESEARCH.md (this file) in place
- [ ] REQUIREMENTS.md shows 16 Phase 18 requirements (OBS-01..05, PROBE-01..05, RESIL-01..06)
- [ ] ARCHITECTURE-v1.6.md referenced for detailed design (handler.ts modifications, component boundaries, lifecycle diagrams)
- [ ] PITFALLS-v1.6.md reviewed for 10 critical pitfalls (timing, secrets, callbacks, module state, backpressure, FD cleanup, cascading probes, shutdown limits, info disclosure, canary config)
- [ ] Test Wave 0 files scaffolded (stubs) before implementation begins
- [ ] Vitest config verified (node environment, 95% coverage target)
- [ ] Framework packages identified for health probe copy: sveltekit, remix, edge
- [ ] Apps identified for example endpoints: example, open-swe (for instrumentation.ts shutdown setup)

---

*Phase 18 research: Observability + Health + Core Resilience*  
*Researched: 2026-06-06*  
*Confidence: HIGH on architecture/patterns; MEDIUM on implementation specifics (flagged for Phase 18 validation gates)*  
*Next phase: 19 — Graceful Shutdown + Deploy Docs*
