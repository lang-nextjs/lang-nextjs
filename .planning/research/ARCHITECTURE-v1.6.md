# Architecture: v1.6 Production Readiness & Observability

**Project:** deepagents-nextjs  
**Domain:** v1.6 production-readiness milestone — observability hooks, health/readiness probes, resilience controls, graceful shutdown
**Researched:** 2026-06-06  
**Confidence:** HIGH for integration patterns; MEDIUM for observability callback semantics (flagged for implementation validation)

---

## Executive Summary

v1.6 production readiness extends the existing stateless handler + adapter + registry architecture with four tightly integrated pillars. No breaking changes to the handler signature or transform contract — all new functionality is **additive via callbacks and pluggable helpers**:

1. **Observability hooks** — `ObservabilityHooks` interface on handler config, fired at lifecycle points (fetch start/end, transform begin/end, stream start/end, errors) with frame/byte metrics, zero runtime deps, vendor-neutral callback pattern
2. **Health & readiness probes** — Reusable helper functions in server package (`createHealthProbe`, `createReadinessProbe`) that encapsulate liveness and readiness logic, copied to framework + edge packages following existing `SseFrameAccumulator` pattern
3. **Resilience controls** — Rate limiting, circuit breaker, backpressure, and timeout/abort as first-class config options (`resilience: { rateLimitStore?, circuitBreaker?, backpressure?, timeoutMs }`) integrated into the handler pipeline with consumer-provided async stores for state
4. **Deploy infra & graceful shutdown** — Serverless-friendly shutdown hooks (`onShutdown` callback), error reporting integration points, and canary/blue-green promotion patterns (generalizing existing open-swe Phase 17 patterns)

**Key design principle:** Per-request isolation + vendor-neutral callbacks = edge-safe, HMR-stable, zero new runtime deps.

---

## Recommended Architecture

### Data Flow: Complete Request Lifecycle with v1.6 Additions

```
1. CLIENT REQUEST
   ↓
2. HANDLER INVOCATION (createDeepAgentsHandler)
   ├─ Hook: onRequest({ sessionId, backendUrl, timestamp })
   ├─ Resilience: checkRateLimit() — async store lookup
   ├─ Resilience: checkCircuitBreaker() — async store lookup
   ├─ Timeout: AbortController with timeoutMs
   │
3. FETCH BACKEND
   ├─ Hook: onFetchStart({ backendUrl, timeout })
   ├─ Fetch with retry + abort controller
   ├─ Hook: onFetchEnd({ status, durationMs, bytesReceived })
   ├─ Resilience: recordCircuitBreakerEvent(ok? → success : failure)
   │
4. STREAM HANDLER (existing pipeline, unchanged)
   ├─ Hook: onStreamStart({ backendUrl, status })
   ├─ SseFrameAccumulator.push(chunk)
   │
5. TRANSFORM PIPELINE
   ├─ Hook: onTransformBegin({ frameIndex, frameBytes })
   ├─ applyTransforms([...adapter.transforms, ...options.transforms])
   ├─ Hook: onTransformEnd({ outputFrames, dropped?, durationMs })
   │
6. ERROR HANDLING
   ├─ Hook: onError({ type, error, durationMs, context })
   ├─ Observability: record error metrics
   ├─ Resilience: update circuit breaker state
   │
7. STREAM END
   ├─ Hook: onStreamEnd({ success, frameCount, byteCount, durationMs })
   ├─ Observability: finalize session metrics
   │
8. RESPONSE TO CLIENT
   ├─ Status: 200 (success), 502 (backend unavailable), 500 (mid-stream error)
   ├─ Headers: Content-Type, x-vercel-ai-ui-message-stream, Cache-Control
   │
9. SHUTDOWN / CLEANUP
   ├─ Hook: onShutdown({ reason, signal })
   ├─ Drain pending approvals
   └─ Cancel in-flight requests
```

---

## Component Boundaries

| Component | Responsibility | Communicates With | New vs Modified |
|-----------|---|---|---|
| **createDeepAgentsHandler** | Core SSE proxy factory (existing) | Backend, adapters, hooks, resilience stores | MODIFIED — adds `ObservabilityHooks`, `resilience` option |
| **ObservabilityHooks** | Event callbacks at lifecycle points | Handler (fires), consumer (implements) | NEW — interface in handler.ts |
| **Resilience config** | Rate limit, circuit breaker, backpressure, timeout | Handler, consumer async stores | NEW — option on handler config |
| **RateLimitStore** | Consumer-provided async state for rate limits | Resilience checks in handler | NEW — interface (consumer implements) |
| **CircuitBreakerStore** | Consumer-provided async state for circuit breaker | Resilience checks in handler | NEW — interface (consumer implements) |
| **createHealthProbe** | Liveness check helper (server package) | Handler + any upstream dependency | NEW — exported from packages/server |
| **createReadinessProbe** | Readiness check helper (server package) | Handler + backend connectivity | NEW — exported from packages/server |
| **HealthProbe** (copied to edge/framework) | Portable liveness probe | HTTP /health endpoint | NEW — copied like SseFrameAccumulator |
| **ReadinessProbe** (copied to edge/framework) | Portable readiness probe | HTTP /ready endpoint | NEW — copied like SseFrameAccumulator |
| **GracefulShutdown** | Shutdown orchestration (new utility) | Handler, approval registry, stream registry | NEW — optional utility in server package |
| **ErrorReporter** | Error telemetry integration points | Observability hooks, error registry | NEW — interface, consumer implements |

---

## Integration Points: New vs Modified

### 1. Observability Hooks

**Location:** `packages/server/src/handler.ts` — new interface + hook firing

**Design:**

```typescript
// packages/server/src/observability.ts (NEW)

export interface ObservabilityContext {
  sessionId: string;
  backendUrl: string;
  startedAt: number; // Unix timestamp ms
  frameIndex: number;
  byteCount: number;
}

export interface ObservabilityHooks {
  /**
   * Fired when a request begins. Use this to initialize telemetry context.
   * Optional; if not provided, no-op.
   */
  onRequest?: (context: {
    sessionId: string;
    backendUrl: string;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired when fetch to backend begins.
   * Allows telemetry systems to track connection timing.
   */
  onFetchStart?: (context: {
    backendUrl: string;
    timeoutMs?: number;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired when fetch completes (success or failure).
   * Early opportunity to record metrics before stream processing begins.
   */
  onFetchEnd?: (context: {
    backendUrl: string;
    status?: number;
    bytesReceived: number;
    durationMs: number;
    error?: Error;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired when SSE stream begins (after successful fetch).
   * Equivalent to "headers received" in the response.
   */
  onStreamStart?: (context: {
    backendUrl: string;
    status: number;
    headers?: Record<string, string>;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired before a frame enters the transform pipeline.
   * Allows per-frame telemetry (frame count, byte size).
   */
  onTransformBegin?: (context: {
    frameIndex: number;
    frameBytes: number;
    framePreview?: string; // First 100 chars of raw frame
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired after a frame exits the transform pipeline.
   * Reports whether frame was dropped, passed, or transformed.
   */
  onTransformEnd?: (context: {
    frameIndex: number;
    dropped: boolean;
    outputCount: number; // 0 if dropped, 1+ if multi-transform
    durationMs: number;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired on any error: fetch failure, stream mid-stream error, transform error.
   * Use this to wire to error reporting (Sentry, DataDog, etc).
   */
  onError?: (context: {
    type: "fetch" | "stream" | "transform" | "rate-limit" | "circuit-breaker";
    error: Error;
    durationMs: number;
    frameIndex?: number;
    sessionId: string;
    timestamp: number;
  }) => void | Promise<void>;

  /**
   * Fired when stream completes (successfully or with error).
   * Final telemetry point: total frame count, byte count, duration.
   */
  onStreamEnd?: (context: {
    success: boolean;
    frameCount: number;
    byteCount: number;
    durationMs: number;
    error?: Error;
    timestamp: number;
  }) => void | Promise<void>;
}
```

**Handler integration:**

```typescript
// packages/server/src/handler.ts (MODIFIED)

export interface DeepAgentsHandlerOptions {
  backendUrl: string;
  adapter?: SseAdapter;
  retry?: { maxRetries?: number; initialDelayMs?: number };
  getToken?: (req: NextRequest) => Promise<string | null | undefined> | string | null | undefined;
  transforms?: SseTransform[];
  approvalGating?: ApprovalGatingConfig;
  maxBodyBytes?: number;

  // NEW for v1.6
  observability?: ObservabilityHooks;
  resilience?: ResilienceConfig;
  onShutdown?: (context: { reason: "timeout" | "error" | "success" | "abort"; signal?: AbortSignal }) => void | Promise<void>;
}

export function createDeepAgentsHandler(
  options: DeepAgentsHandlerOptions
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest) => {
    const sessionId = crypto.randomUUID();
    const startedAt = Date.now();
    const hooks = options.observability ?? {};

    // Fire onRequest
    try {
      await hooks.onRequest?.({
        sessionId,
        backendUrl: options.backendUrl,
        timestamp: startedAt,
      });
    } catch (e) {
      console.error("onRequest hook failed:", e);
    }

    // ... rest of handler logic, firing hooks at each lifecycle point
  };
}
```

**Framework packages (sveltekit, remix, edge):**

```typescript
// packages/sveltekit/src/handler.ts (MODIFIED)
export interface DeepAgentsHandlerOptions {
  backendUrl: string;
  adapter?: SseAdapter;
  retry?: { maxRetries?: number; initialDelayMs?: number };
  transforms?: SseTransform[];
  approvalGating?: ApprovalGatingConfig;
  maxBodyBytes?: number;

  // NEW for v1.6 — same as server package
  observability?: ObservabilityHooks;
  resilience?: ResilienceConfig;
  onShutdown?: (context: { reason: string; signal?: AbortSignal }) => void | Promise<void>;
}
```

**Rationale:**
- Callbacks are vendor-neutral — consumer implements via Datadog, Sentry, OpenTelemetry exporter, custom logging, etc.
- Zero runtime deps — hooks are optional, no-op if undefined
- Edge-safe — callbacks are async, deferred to next microtask if needed
- HMR-stable — no module-level state, all context passed as parameters

---

### 2. Health & Readiness Probes

**Location:** `packages/server/src/health.ts` (NEW) + copied to sveltekit/remix/edge

**Design:**

```typescript
// packages/server/src/health.ts (NEW)

export interface HealthCheckConfig {
  name: string;
  check: () => Promise<boolean>;
  timeoutMs?: number;
}

export async function createHealthProbe(
  checks: HealthCheckConfig[]
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
```

**Usage in Next.js app:**

```typescript
// apps/example/app/api/health/route.ts (NEW)
import { createHealthProbe } from "@deepagents-nextjs/server";

export const GET = async (req: NextRequest) => {
  const health = await createHealthProbe([
    {
      name: "backend",
      check: async () => {
        const res = await fetch(process.env.BACKEND_URL!, { method: "HEAD" });
        return res.ok;
      },
      timeoutMs: 3000,
    },
    {
      name: "handler",
      check: async () => true, // Always passes; indicates handler is alive
    },
  ]);

  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
  });
};

// apps/example/app/api/ready/route.ts (NEW)
import { createReadinessProbe } from "@deepagents-nextjs/server";

export const GET = async (req: NextRequest) => {
  const ready = await createReadinessProbe({
    backendUrl: process.env.BACKEND_URL!,
    getToken: process.env.AUTH_TOKEN
      ? async () => process.env.AUTH_TOKEN
      : undefined,
  });

  return NextResponse.json(ready, {
    status: ready.ready ? 200 : 503,
  });
};
```

**Why copy to framework packages:**
- SvelteKit and Remix may not have Next.js runtime available
- Edge runtimes (Cloudflare, Deno) need Web API only, no Next.js
- Pattern already proven with `SseFrameAccumulator`
- Code is stable and small (~40 lines each)

---

### 3. Resilience Controls

**Location:** `packages/server/src/resilience.ts` (NEW)

**Design:**

```typescript
// packages/server/src/resilience.ts (NEW)

export interface RateLimitStore {
  /**
   * Check if a request is within the rate limit.
   * Return true if allowed, false if rate-limited.
   * Implementation: consumer provides Redis, in-memory store, etc.
   */
  check: (key: string) => Promise<boolean>;
  /**
   * Record a request for rate limit tracking.
   * Called after check() returns true (increment counter, set TTL).
   */
  record: (key: string, windowMs: number) => Promise<void>;
}

export interface CircuitBreakerStore {
  /**
   * Get current state: "closed" (normal), "open" (failing, reject fast),
   * or "half-open" (testing recovery).
   */
  getState: (key: string) => Promise<"closed" | "open" | "half-open">;
  /**
   * Record a success or failure on the circuit breaker.
   * Implementation tracks consecutive failures, resets on success,
   * transitions open→half-open after timeout.
   */
  recordEvent: (
    key: string,
    outcome: "success" | "failure",
    resetAfterMs?: number
  ) => Promise<void>;
}

export interface ResilienceConfig {
  /**
   * Rate limit: optional consumer-provided store.
   * Checked before fetch (early reject). Keyed by sessionId or endpoint.
   */
  rateLimitStore?: RateLimitStore;
  rateLimitKey?: (req: NextRequest) => string; // Default: sessionId
  rateLimitWindowMs?: number; // Default: 60000 (1 minute)
  rateLimitMax?: number; // Default: 100 requests per window

  /**
   * Circuit breaker: optional consumer-provided store.
   * Prevents cascading failures to backend.
   */
  circuitBreakerStore?: CircuitBreakerStore;
  circuitBreakerKey?: (req: NextRequest) => string; // Default: backendUrl
  circuitBreakerFailureThreshold?: number; // Default: 5 consecutive failures
  circuitBreakerResetMs?: number; // Default: 60000 (1 minute)

  /**
   * Backpressure: slow down if too many concurrent requests.
   * Keyed by sessionId or custom key (optional).
   */
  backpressureStore?: RateLimitStore; // Reuses same interface
  backpressureKey?: (req: NextRequest) => string;
  backpressureMax?: number; // Default: 10 concurrent per key
  backpressureRejectAfterMs?: number; // Default: 5000 (give up after 5s wait)

  /**
   * Timeout/abort: cancel the request if it takes too long.
   * Fired immediately in fetch setup; independent of other resilience controls.
   */
  timeoutMs?: number; // Default: 30000 (30 seconds)
}

export async function checkRateLimit(
  store: RateLimitStore,
  key: string
): Promise<{ allowed: boolean; reason?: string }> {
  const allowed = await store.check(key);
  return {
    allowed,
    reason: allowed ? undefined : "rate-limited",
  };
}

export async function checkCircuitBreaker(
  store: CircuitBreakerStore,
  key: string
): Promise<{ allowed: boolean; state: string }> {
  const state = await store.getState(key);
  return {
    allowed: state !== "open",
    state,
  };
}

export async function checkBackpressure(
  store: RateLimitStore,
  key: string,
  maxConcurrent: number,
  rejectAfterMs: number
): Promise<{ allowed: boolean; wait?: number }> {
  const startWait = Date.now();
  // Exponential backoff: try check() every 10ms up to rejectAfterMs
  while (true) {
    const allowed = await store.check(key);
    if (allowed) {
      return { allowed: true };
    }
    const elapsedMs = Date.now() - startWait;
    if (elapsedMs >= rejectAfterMs) {
      return { allowed: false, wait: elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

**Handler integration:**

```typescript
// packages/server/src/handler.ts (MODIFIED applyTransforms section)

export async function createDeepAgentsHandler(
  options: DeepAgentsHandlerOptions
): Promise<(req: NextRequest) => Promise<Response>> {
  return async (req: NextRequest) => {
    const resilience = options.resilience ?? {};
    const hooks = options.observability ?? {};

    // 1. Rate limit check
    if (resilience.rateLimitStore) {
      const key = resilience.rateLimitKey?.(req) ?? sessionId;
      const rateLimitCheck = await checkRateLimit(
        resilience.rateLimitStore,
        key
      );
      if (!rateLimitCheck.allowed) {
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

    // 2. Circuit breaker check
    if (resilience.circuitBreakerStore) {
      const key = resilience.circuitBreakerKey?.(req) ?? options.backendUrl;
      const cbCheck = await checkCircuitBreaker(
        resilience.circuitBreakerStore,
        key
      );
      if (!cbCheck.allowed) {
        await hooks.onError?.({
          type: "circuit-breaker",
          error: new Error(`Circuit breaker is ${cbCheck.state}`),
          durationMs: Date.now() - startedAt,
          sessionId,
          timestamp: Date.now(),
        });
        return NextResponse.json(
          { error: "Service temporarily unavailable (circuit breaker open)" },
          { status: 503 }
        );
      }
    }

    // 3. Backpressure check
    if (resilience.backpressureStore) {
      const key = resilience.backpressureKey?.(req) ?? sessionId;
      const bpCheck = await checkBackpressure(
        resilience.backpressureStore,
        key,
        resilience.backpressureMax ?? 10,
        resilience.backpressureRejectAfterMs ?? 5000
      );
      if (!bpCheck.allowed) {
        await hooks.onError?.({
          type: "rate-limit",
          error: new Error("Backpressure exceeded"),
          durationMs: Date.now() - startedAt,
          sessionId,
          timestamp: Date.now(),
        });
        return NextResponse.json(
          { error: "Too many concurrent requests" },
          { status: 503 }
        );
      }
    }

    // 4. Timeout/abort controller
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort(),
      resilience.timeoutMs ?? 30000
    );

    // ... rest of handler (fetch, stream, transform)
    // Pass abortController.signal to fetch()
  };
}
```

**Consumer example (in-memory rate limiter):**

```typescript
// consumer-app/lib/rate-limit.ts
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export const consumerRateLimitStore: RateLimitStore = {
  check: async (key: string) => {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      return true;
    }
    return entry.count < 100; // Max 100 per window
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

**Rationale:**
- Rate limit, circuit breaker, backpressure all delegate to consumer-provided async stores (Redis, DynamoDB, in-memory, etc.)
- Edge-safe — no module-level state, all keyed by request context
- Composable — consumer can wire multiple resilience patterns together
- Metrics-friendly — each check fires an observability hook, enabling Datadog/Prometheus integration

---

### 4. Graceful Shutdown & Error Reporting

**Location:** `packages/server/src/shutdown.ts` (NEW) + handler integration

**Design:**

```typescript
// packages/server/src/shutdown.ts (NEW)

export interface ShutdownOrchestrator {
  onSignal: (signal: NodeJS.Signals) => Promise<void>;
  abort: () => void;
  drainPending: () => Promise<void>;
}

/**
 * Create a graceful shutdown orchestrator.
 * Handles SIGTERM/SIGINT, drains in-flight requests, cleans up state.
 */
export function createShutdownOrchestrator(config: {
  graceMs?: number; // Default: 30 seconds
  onDrain?: () => Promise<void>; // Custom drain logic (approval registry, stream registry)
}): ShutdownOrchestrator {
  let shutdownStarted = false;
  let pendingRequests = 0;
  const drainPromises: Promise<void>[] = [];

  return {
    onSignal: async (signal: NodeJS.Signals) => {
      if (shutdownStarted) return;
      shutdownStarted = true;

      console.log(`Received ${signal}, starting graceful shutdown...`);

      // Call custom drain (cleanup approval + stream registries)
      if (config.onDrain) {
        await Promise.race([
          config.onDrain(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, config.graceMs ?? 30000)
          ),
        ]);
      }

      // Wait for pending requests (with timeout)
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, config.graceMs ?? 30000)
      );
      await Promise.race([Promise.all(drainPromises), timeout]);

      console.log("Shutdown complete");
      process.exit(0);
    },

    abort: () => {
      shutdownStarted = true;
    },

    drainPending: async () => {
      return Promise.all(drainPromises);
    },
  };
}

/**
 * Wire a shutdown orchestrator to Node.js process signals.
 * Typical usage in apps/example/instrumentation.ts or apps/open-swe/instrumentation.ts
 */
export function installShutdownHandler(
  orchestrator: ShutdownOrchestrator
): void {
  process.on("SIGTERM", () => orchestrator.onSignal("SIGTERM"));
  process.on("SIGINT", () => orchestrator.onSignal("SIGINT"));
}
```

**Handler integration:**

```typescript
// packages/server/src/handler.ts (MODIFIED)

export function createDeepAgentsHandler(
  options: DeepAgentsHandlerOptions
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest) => {
    const hooks = options.observability ?? {};
    const shutdownInitiated = false;

    try {
      // ... resilience checks ...
      // ... fetch backend ...
      // ... stream processing ...

      // Stream complete
      await hooks.onStreamEnd?.({
        success: true,
        frameCount,
        byteCount,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });

      return new NextResponse(transformedStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    } catch (error) {
      const err = error as Error;

      await hooks.onError?.({
        type: "stream",
        error: err,
        durationMs: Date.now() - startedAt,
        sessionId,
        timestamp: Date.now(),
      });

      // Invoke shutdown hook if provided
      if (options.onShutdown) {
        await options.onShutdown({
          reason: "error",
          signal: undefined,
        });
      }

      return NextResponse.json(
        { error: err.message },
        { status: 500 }
      );
    } finally {
      // Cleanup (no-op if hooks not provided)
      await cleanupExpiredApprovals();
    }
  };
}
```

**App-level usage:**

```typescript
// apps/example/instrumentation.ts (NEW)
import { installShutdownHandler, createShutdownOrchestrator } from "@deepagents-nextjs/server";
import { cleanupExpiredApprovals } from "@deepagents-nextjs/server";
import { cleanupExpired as cleanupStreamRegistry } from "@deepagents-nextjs/server";

export const register = async () => {
  const orchestrator = createShutdownOrchestrator({
    graceMs: 30000,
    onDrain: async () => {
      cleanupExpiredApprovals();
      cleanupStreamRegistry();
    },
  });

  installShutdownHandler(orchestrator);

  // Optionally: wire to observability hook
  if (process.env.ENABLE_APM) {
    console.log("APM enabled; telemetry will be sent to:", process.env.APM_ENDPOINT);
  }
};

// Export for Next.js root layout
export default {};
```

**Rationale:**
- `onShutdown` callback is optional — graceful shutdown only runs if consumer configures it
- Drain logic is composable — consumer decides what to clean up
- No new runtime deps — process signal handling is built-in to Node.js
- Serverless-aware — Vercel/AWS/GCP invoke SIGTERM on shutdown, giving apps ~30s to drain

---

## Data Flow: Integration of v1.6 Components

### Request → Response with Observability + Resilience

```
CLIENT REQUEST
  ↓
createDeepAgentsHandler called
  ↓
onRequest hook fired
  → sessionId, backendUrl, timestamp
  ↓
Resilience: checkRateLimit (async store lookup)
  ├ if denied → return 429, fire onError hook
  ├ if allowed → call store.record()
  ↓
Resilience: checkCircuitBreaker (async store lookup)
  ├ if open → return 503, fire onError hook
  ├ if closed/half-open → proceed
  ↓
Resilience: checkBackpressure (async store with exponential backoff)
  ├ if exceeded → return 503, fire onError hook
  ├ if ok → proceed
  ↓
Create AbortController with timeoutMs
  ↓
onFetchStart hook fired
  ↓
FETCH backend (with abort signal)
  ├ On network error → retry (if configured)
  ├ On retry exhausted → return 502, fire onError hook
  ├ On success → continue
  ↓
onFetchEnd hook fired
  → status, bytesReceived, durationMs
  ↓
recordCircuitBreakerEvent("success")
  ↓
onStreamStart hook fired
  ↓
STREAM LOOP (existing SseFrameAccumulator)
  ├ For each chunk received:
  │   ├ push(chunk)
  │   ├ forEach frame:
  │   │   ├ onTransformBegin hook fired
  │   │   ├ applyTransforms([...adapter.transforms, ...options.transforms])
  │   │   ├ onTransformEnd hook fired
  │   │   ├ Write to client stream
  │   └─ Check for mid-stream errors
  │
  ├ On stream error → fire onError hook, recordCircuitBreakerEvent("failure")
  │ On stream success → continue to end
  ↓
onStreamEnd hook fired
  → success, frameCount, byteCount, durationMs
  ↓
Clean up abortController
  ↓
Return 200 response to client
  ↓
Finally block: cleanupExpiredApprovals()
  ↓
OPTIONAL: onShutdown hook fired (on error or timeout)
  → drain pending approvals, cancel in-flight requests
```

---

## Build Order: NEW vs MODIFIED

### Phase-by-Phase Integration

**Phase 1: Observability Foundation**
- NEW: `packages/server/src/observability.ts` — interface + types
- MODIFIED: `packages/server/src/handler.ts` — add hooks parameter, fire hooks at lifecycle points
- MODIFIED: `packages/server/src/index.ts` — export `ObservabilityHooks` type
- Framework packages (sveltekit, remix, edge): copy integration pattern from server package

**Phase 2: Health & Readiness Probes**
- NEW: `packages/server/src/health.ts` — `createHealthProbe`, `createReadinessProbe`
- MODIFIED: `packages/server/src/index.ts` — export health probe functions
- NEW: `apps/example/app/api/health/route.ts` — example health endpoint
- NEW: `apps/example/app/api/ready/route.ts` — example readiness endpoint
- COPY: `packages/sveltekit/src/health.ts` from server (avoid Next.js dep)
- COPY: `packages/remix/src/health.ts` from server
- COPY: `packages/edge/src/health.ts` from server

**Phase 3: Resilience Controls**
- NEW: `packages/server/src/resilience.ts` — store interfaces, check functions
- MODIFIED: `packages/server/src/handler.ts` — integrate rate limit, circuit breaker, backpressure, timeout checks
- MODIFIED: `packages/server/src/index.ts` — export resilience interfaces + check functions
- Framework packages: reuse handler modifications (no code copying needed for resilience — it's part of the handler factory signature)

**Phase 4: Graceful Shutdown & Error Reporting**
- NEW: `packages/server/src/shutdown.ts` — `createShutdownOrchestrator`, `installShutdownHandler`
- MODIFIED: `packages/server/src/handler.ts` — add `onShutdown` callback option
- MODIFIED: `packages/server/src/index.ts` — export shutdown utilities
- NEW: `apps/example/instrumentation.ts` — wire shutdown orchestrator
- NEW: `apps/open-swe/instrumentation.ts` — wire shutdown orchestrator

### File Manifest: NEW vs MODIFIED

| File | Status | Why |
|------|--------|-----|
| `packages/server/src/observability.ts` | NEW | Interface definitions + types |
| `packages/server/src/health.ts` | NEW | Probe factories |
| `packages/server/src/resilience.ts` | NEW | Resilience interfaces + checks |
| `packages/server/src/shutdown.ts` | NEW | Shutdown orchestration |
| `packages/server/src/handler.ts` | MODIFIED | Hook firing + resilience checks + timeout/abort + onShutdown callback |
| `packages/server/src/index.ts` | MODIFIED | Export new types + functions |
| `packages/sveltekit/src/health.ts` | NEW (copied) | Avoid Next.js import |
| `packages/remix/src/health.ts` | NEW (copied) | Avoid Next.js import |
| `packages/edge/src/health.ts` | NEW (copied) | Web API only, no Next.js |
| `apps/example/instrumentation.ts` | NEW | Shutdown + APM setup |
| `apps/open-swe/instrumentation.ts` | NEW | Shutdown + APM setup |
| `apps/example/app/api/health/route.ts` | NEW | Health check endpoint |
| `apps/example/app/api/ready/route.ts` | NEW | Readiness check endpoint |

### No Changes Required

- `pnpm-workspace.yaml` — glob patterns unchanged
- `turbo.json` — no new task dependencies (health/shutdown are runtime only)
- `tsconfig.json` — no new paths needed
- Adapters — unchanged (observability is at handler level, not per-adapter)

---

## Component Boundaries: Clear Separation

### Handler (Core)

Responsible for: fetch, retry, SSE accumulation, transform pipeline, abort handling

**New responsibilities (v1.6):**
- Fire observability hooks at lifecycle points
- Check resilience constraints before fetch
- Record resilience metrics after fetch/stream
- Handle timeout via AbortController
- Invoke shutdown hook on error

### Observability System (Consumer-Implemented)

Responsible for: hooking lifecycle events, forwarding metrics to APM/logging system

**Examples:**
- Datadog: `dd-trace-js` listens to `onStreamEnd` hook, sends metrics
- Sentry: listens to `onError` hook, sends exceptions
- Custom: consumer implements hooks interface, logs to stdout/file

### Resilience System (Consumer-Provided)

Responsible for: providing async stores for rate limit, circuit breaker, backpressure state

**Examples:**
- In-memory: `Map<string, { count, resetAt }>`
- Redis: Lua script for atomic check + increment
- DynamoDB: TTL + conditional update
- Rate limiter as a service (e.g., CloudFlare, Auth0)

### Health & Readiness (Reusable Helpers)

Responsible for: checking liveness and backend connectivity

**Usage:**
- Kubernetes: `/health` → liveness probe, `/ready` → readiness probe
- Vercel: canary endpoint for deploy monitoring
- Custom: consumer calls probe functions in their own endpoints

### Shutdown (Optional Orchestrator)

Responsible for: listening to signals, draining state, exiting process

**Usage:**
- Process-level cleanup on SIGTERM/SIGINT
- Optional — consumer can implement their own shutdown flow
- Composable — custom `onDrain` callback for app-specific cleanup

---

## Patterns to Follow

### Pattern 1: Hook Firing with Error Containment

```typescript
// ✓ GOOD: errors in hooks don't crash handler
try {
  await hooks.onRequest?.({ sessionId, backendUrl, timestamp });
} catch (e) {
  console.error("onRequest hook failed:", e);
  // Continue handler execution
}

// ✗ BAD: hook error crashes entire request
await hooks.onRequest?.({ sessionId, backendUrl, timestamp });
```

### Pattern 2: Async Store Interface (Pluggable)

```typescript
// ✓ GOOD: consumer implements store
export interface RateLimitStore {
  check: (key: string) => Promise<boolean>;
  record: (key: string, windowMs: number) => Promise<void>;
}

const consumerStore: RateLimitStore = {
  check: async (key) => redisClient.decr(key) > 0,
  record: async (key, windowMs) => redisClient.setex(key, windowMs / 1000, 100),
};

// ✗ BAD: hard-coding store in handler
const rateLimitMap = new Map(); // Inside handler — not pluggable
```

### Pattern 3: Resilience Composition

```typescript
// ✓ GOOD: consumer can enable zero, one, or many resilience controls
createDeepAgentsHandler({
  backendUrl,
  resilience: {
    rateLimitStore: redisStore,
    circuitBreakerStore: dynamodbStore,
    // backpressureStore omitted — not needed for this app
  },
});

// ✗ BAD: all-or-nothing resilience
createDeepAgentsHandler({
  backendUrl,
  resilience: true, // What does this mean? Which controls are enabled?
});
```

### Pattern 4: Hook as Telemetry Integration Point

```typescript
// ✓ GOOD: consumer wires hooks to their telemetry system
const observability: ObservabilityHooks = {
  onError: async (context) => {
    await datadogClient.recordError({
      message: context.error.message,
      type: context.type,
      durationMs: context.durationMs,
      tags: { sessionId: context.sessionId },
    });
  },
};

createDeepAgentsHandler({ backendUrl, observability });

// ✗ BAD: handler hard-codes specific APM
createDeepAgentsHandler({
  backendUrl,
  enableDatadog: true,
  enableNewRelic: true, // Too many knobs; who do we send to?
});
```

### Pattern 5: Per-Request Context (No Module-Level State)

```typescript
// ✓ GOOD: sessionId generated per request, passed to hooks
const sessionId = crypto.randomUUID();
await hooks.onRequest?.({ sessionId, ... });

// ✗ BAD: shared state across requests
let lastSessionId: string;
await hooks.onRequest?.({ sessionId: lastSessionId = crypto.randomUUID(), ... });
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Synchronous Hook Firing

❌ Blocks request processing:
```typescript
hooks.onTransformBegin?.({ frameIndex, frameBytes }); // No await
// Next line may execute before hook completes
```

✓ Async with error containment:
```typescript
try {
  await hooks.onTransformBegin?.({ frameIndex, frameBytes });
} catch (e) {
  console.error("onTransformBegin failed:", e);
}
```

### Anti-Pattern 2: Hard-Coded Resilience Logic

❌ Not pluggable:
```typescript
if (sessionId in rateLimitMap && rateLimitMap[sessionId].count >= 100) {
  return 429;
}
```

✓ Delegate to store:
```typescript
if (resilience.rateLimitStore) {
  const allowed = await resilience.rateLimitStore.check(rateLimitKey);
  if (!allowed) return 429;
}
```

### Anti-Pattern 3: Mixing Observability with Business Logic

❌ Hook determines behavior:
```typescript
const canProceed = await hooks.onRequest?.({ ... });
if (!canProceed) return 429;
```

✓ Hooks are read-only telemetry:
```typescript
await hooks.onRequest?.({ ... }); // Fire and forget
// Business logic independent of hook
```

### Anti-Pattern 4: Shutdown Logic in Handler

❌ Shutdown inside request handler:
```typescript
export function createDeepAgentsHandler(...) {
  process.on("SIGTERM", () => { /* cleanup */ }); // In handler factory — only runs once!
}
```

✓ Shutdown at app startup:
```typescript
// instrumentation.ts (app-level)
const orchestrator = createShutdownOrchestrator({ ... });
installShutdownHandler(orchestrator);
```

### Anti-Pattern 5: Modal Probes (Health & Readiness Combined)

❌ Single endpoint for both:
```typescript
// GET /probe returns `{ healthy: true, ready: true }`
// Consumer can't distinguish liveness (is handler alive?) from readiness (is backend available?)
```

✓ Separate endpoints:
```typescript
// GET /health → is handler alive? (minimal checks)
// GET /ready → is backend reachable? (full dependency check)
// Kubernetes uses both: liveness restarts pod, readiness removes from LB
```

---

## Scalability Considerations

| Concern | At 100 req/sec | At 1K req/sec | At 10K req/sec |
|---------|---|---|---|
| **Hook overhead** | ~1ms per hook | ~1ms (no batch) | ~1ms (no batch); possible gating via sampling |
| **Rate limit store** | In-memory Map | Redis (atomic) | Redis + Lua (atomic check+incr in 1 round-trip) |
| **Circuit breaker** | In-memory state | Redis or DynamoDB | DynamoDB with TTL + GSI for active circuits |
| **Backpressure waits** | Exponential backoff 10ms | Same (stateless) | May queue requests; consider request queuing at LB |
| **Observability hook latency** | Hook fires async; negligible impact | Same | Consider sampling (fire every Nth request) to reduce APM cost |
| **Timeout handling** | AbortController (native) | Same | May exhaust event loop if many concurrent timeouts; use Promise.race for efficiency |

**Scaling strategy:**
- Hooks are async and fire independently — don't block request processing
- Resilience stores are consumer-provided; use Redis/DynamoDB for scale
- Health probes are called by LB/orchestrator independently; don't affect request path
- Shutdown is process-level; no per-request overhead

---

## Confidence Assessment

| Area | Level | Notes |
|---|---|---|
| Hook interface design | HIGH | Lifecycle points validated against existing handler flow; callbacks are standard Node.js pattern |
| Observability metrics (frame counts, byte counts, durations) | HIGH | Straightforward to collect; matches AI SDK v6 conventions |
| Rate limit/circuit breaker/backpressure store interfaces | MEDIUM-HIGH | Pattern proven in production systems (Stripe, auth0, resilience4j); delegating to consumer is sound |
| Health probe factories | HIGH | Standard liveness/readiness pattern; validated by Kubernetes conventions |
| Graceful shutdown with signal handling | HIGH | Standard Node.js pattern (SIGTERM/SIGINT); tested extensively in production frameworks |
| Edge runtime compatibility | MEDIUM-HIGH | Observability hooks (async callbacks) are edge-safe; health probes use only fetch API; shutdown is Node.js-only (not needed in edge) |
| Framework package copying (sveltekit, remix, edge) | HIGH | Pattern proven in v1.2 with SseFrameAccumulator; code stability risk is low |

### Flagged for Implementation Validation

1. **Hook performance under load** — Measure latency of firing N hooks concurrently at 1K req/sec; consider async hook batching if needed
2. **Backpressure exponential backoff** — Validate 10ms retry interval doesn't cause thundering herd or excessive event loop spinning
3. **Circuit breaker reset logic** — Test transition from "open" → "half-open" → "closed" under real load
4. **Shutdown grace period** — Verify 30s default is sufficient for typical request durations (should be 2-3x p99 latency)
5. **Observability hook ordering** — If multiple hooks fire on single event, verify order is stable (onTransformBegin before onTransformEnd, etc.)

---

## Suggested Implementation Sequence (4 Weeks)

### Week 1: Observability Foundation

1. Define `ObservabilityHooks` interface
2. Modify handler to fire hooks at lifecycle points
3. Unit test hook firing with mock consumer
4. Framework packages: integrate into sveltekit/remix/edge handler factories

### Week 2: Health & Readiness Probes

1. Implement `createHealthProbe` and `createReadinessProbe` factories
2. Add example endpoints to apps/example (/health, /ready)
3. Copy probe functions to sveltekit/remix/edge packages
4. Unit test probe success/timeout scenarios

### Week 3: Resilience Controls

1. Define `RateLimitStore`, `CircuitBreakerStore` interfaces
2. Implement `checkRateLimit`, `checkCircuitBreaker`, `checkBackpressure` functions
3. Integrate into handler with early rejection (429/503)
4. Wire circuit breaker success/failure recording
5. Unit test each resilience control independently

### Week 4: Graceful Shutdown & Integration Tests

1. Implement `createShutdownOrchestrator` and `installShutdownHandler`
2. Add shutdown hooks to handler factory
3. Wire instrumentation.ts into apps/example and apps/open-swe
4. Integration test: verify rate limit, circuit breaker, backpressure work end-to-end
5. Integration test: verify graceful shutdown drains pending approvals

---

## Integration Points: Summary

### Existing APIs (No Breaking Changes)

| API | Status | Notes |
|---|---|---|
| `createDeepAgentsHandler(options)` | MODIFIED (additive) | New optional fields: `observability`, `resilience`, `onShutdown` |
| `SseFrame`, `SseTransform` types | UNCHANGED | Transform contract remains `(frame) => frame \| null` |
| `SseAdapter` interface | UNCHANGED | Adapter pipeline unchanged |
| `deepagentsAdapter`, `langGraphAdapter`, etc. | UNCHANGED | All adapters work as-is |
| `approvalGating` config | UNCHANGED | Approval gating orthogonal to observability/resilience |

### New Exports (from packages/server/src/index.ts)

| Export | Type | Purpose |
|---|---|---|
| `ObservabilityHooks` | Interface | Consumer implements for telemetry |
| `RateLimitStore` | Interface | Consumer provides for rate limiting |
| `CircuitBreakerStore` | Interface | Consumer provides for circuit breaking |
| `ResilienceConfig` | Interface | Handler config option |
| `createHealthProbe` | Function | Reusable liveness check factory |
| `createReadinessProbe` | Function | Reusable readiness check factory |
| `createShutdownOrchestrator` | Function | Graceful shutdown factory |
| `installShutdownHandler` | Function | Install signal handlers |
| `checkRateLimit` | Function | Exported for testing/reuse |
| `checkCircuitBreaker` | Function | Exported for testing/reuse |
| `checkBackpressure` | Function | Exported for testing/reuse |

### Framework Package Changes (sveltekit, remix, edge)

| Package | Changes |
|---|---|
| `packages/sveltekit` | Add `health.ts` (copied); update handler to support `observability`/`resilience`/`onShutdown` options |
| `packages/remix` | Add `health.ts` (copied); update handler to support `observability`/`resilience`/`onShutdown` options |
| `packages/edge` | Add `health.ts` (copied); update handler to support `observability`/`resilience`/`onShutdown` options |

---

## Key Design Decisions for v1.6

| Decision | Rationale | Outcome |
|---|---|---|
| Observability as callbacks (not OpenTelemetry SDK dep) | Zero runtime deps; consumer wires to their APM system | ✓ Lean, edge-compatible, vendor-neutral |
| Resilience stores are consumer-provided interfaces | Supports in-memory, Redis, DynamoDB, etc. without handler coupling | ✓ Pluggable, scalable, testable |
| Per-request hook firing (no module-level state) | HMR stability in dev; stateless in production | ✓ Safe for all runtimes |
| Health/readiness probes copied to framework packages | Avoids Next.js dep leak; pattern proven with SseFrameAccumulator | ✓ Clean boundaries, reusable |
| Graceful shutdown as optional orchestrator | Not all apps need it (serverless doesn't care about SIGTERM); not forced on consumers | ✓ Opt-in, composable |
| Timeout via AbortController (not separate param) | Signals pipeline to cancel; native fetch support | ✓ Efficient, standard pattern |
| Circuit breaker reset delay | Prevents cascading recovery failures; configurable by consumer | ✓ Production-hardened |

---

## Critical Gaps & Phase Flags

### Must Validate (Phase Implementation)

1. **Hook performance** — Profile hook firing latency at 1K req/sec; ensure <1ms per hook
2. **Backpressure backoff timing** — Test 10ms retry interval doesn't cause event loop contention
3. **Circuit breaker state transitions** — Validate open→half-open→closed transitions under load
4. **Shutdown grace period** — Measure typical request durations; ensure 30s default is safe

### Should Research (Future Phases)

1. **Observability sampling** — If hook firing becomes bottleneck at 10K req/sec, consider sampling strategies
2. **Resilience store persistence** — Redis/DynamoDB fallback patterns if store becomes unavailable
3. **Multi-region resilience** — How do rate limit and circuit breaker work across geographic regions (eventual consistency)?
4. **Custom probe extensibility** — Allow consumers to add their own health checks to the probe factory

---

## Sources

- [Node.js Process Signals](https://nodejs.org/api/process.html#process_signal_events) — SIGTERM/SIGINT handling
- [AbortController Web Standard](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) — Timeout/cancellation
- [Resilience4j Circuit Breaker](https://resilience4j.readme.io/docs/circuitbreaker) — Circuit breaker state machine reference
- [Kubernetes Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — Liveness/readiness conventions
- [OpenTelemetry Instrumentation](https://opentelemetry.io/docs/instrumentation/) — Context for why callbacks, not SDK as dep
- [Vercel Deployment](https://vercel.com/docs/deployments/overview) — SIGTERM grace period conventions
- [AWS Lambda Graceful Shutdown](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html) — Serverless shutdown patterns

---

*Architecture research: v1.6 production readiness & observability integration*  
*Researched: 2026-06-06*  
*Confidence: HIGH for patterns; MEDIUM for resilience store design (flagged for implementation validation)*
