# Stack Research: v1.6 Production Readiness & Observability

**Domain:** TypeScript streaming-proxy library with vendor-neutral observability, health checks, resilience, and deployment ops.

**Researched:** 2026-06-05

**Confidence:** HIGH — Verified with official documentation and current npm versions.

**Base stack (v1.5):** See `STACK.md` (v1.3 edge/reconnection) — core technologies unchanged. This document covers v1.6 **ADDITIONS ONLY**.

---

## Executive Summary

v1.6 requires **zero new core runtime dependencies**, maintaining the library's lightweight footprint and edge-runtime compatibility (Web Streams API only). Observability uses callback/event hooks (zero-dependency), health probes leverage Web standards (AbortController, fetch), and resilience controls implement established patterns (circuit breaker, rate limiting, backpressure). All additions are either Web-standard APIs, optional integrations (Sentry/error reporting), or dev-only tooling. The locked design boundary holds: **no OpenTelemetry runtime dependency**.

---

## Part 1: Observability Hooks (Zero-Dependency)

### No New Dependencies Required

Observability ships as **callback/event system** in `@deepagents-nextjs/server` package. No npm adds needed.

### TypeScript Types for Hooks

```typescript
// packages/server/src/observability.ts

export interface RequestEvent {
  timestamp: number;
  sessionId: string;
  backendUrl: string;
  method: 'GET' | 'POST';
}

export interface StreamStartEvent {
  timestamp: number;
  streamId: string;
  sessionId: string;
}

export interface StreamChunkEvent {
  timestamp: number;
  streamId: string;
  chunkSize: number;
  bytesSent: number;
  chunkCount: number;
}

export interface StreamEndEvent {
  timestamp: number;
  streamId: string;
  bytesSent: number;
  chunkCount: number;
  duration: number; // ms
  status: 'success' | 'error' | 'aborted';
}

export interface ErrorEvent {
  timestamp: number;
  streamId?: string;
  error: Error;
  context: {
    backendUrl: string;
    sessionId?: string;
    stage: 'request' | 'streaming' | 'cleanup';
  };
}

export interface ObservabilityHooks {
  onRequest?(event: RequestEvent): void;
  onStreamStart?(event: StreamStartEvent): void;
  onStreamChunk?(event: StreamChunkEvent): void;
  onStreamEnd?(event: StreamEndEvent): void;
  onError?(event: ErrorEvent): void;
}
```

### Handler Integration

```typescript
// createDeepAgentsHandler accepts hooks option
export function createDeepAgentsHandler(options: {
  backendUrl: string;
  hooks?: ObservabilityHooks;
  // ... other options
}) {
  // Fire hook on request
  options.hooks?.onRequest?.({
    timestamp: Date.now(),
    sessionId: req.headers.get('x-session-id') || 'unknown',
    backendUrl: options.backendUrl,
    method: req.method as any,
  });

  // Fire hook on stream chunk
  const transform = (chunk: string) => {
    options.hooks?.onStreamChunk?.({
      timestamp: Date.now(),
      streamId,
      chunkSize: chunk.length,
      bytesSent: totalBytes,
      chunkCount: frameCount,
    });
    return chunk;
  };

  // Fire hook on completion
  options.hooks?.onStreamEnd?.({
    timestamp: Date.now(),
    streamId,
    bytesSent: totalBytes,
    chunkCount: frameCount,
    duration: Date.now() - startTime,
    status: 'success',
  });
}
```

### Why No Dependencies?

1. **Vendor-neutral:** Consumer picks their observability sink (OTel, Datadog, Sentry, stdout).
2. **Lightweight:** Single event object parameter, no serialization overhead.
3. **Standard pattern:** Node.js EventEmitter pattern (or plain callbacks) are idiomatic.
4. **Edge-compatible:** Works in Deno/Cloudflare (no Node.js deps).

### Integration Examples

**Consumer using Sentry (optional):**
```typescript
import * as Sentry from '@sentry/node';

const handler = createDeepAgentsHandler({
  backendUrl,
  hooks: {
    onError: (evt) => {
      Sentry.captureException(evt.error, {
        tags: {
          streamId: evt.streamId,
          stage: evt.context.stage,
        },
        extra: {
          bytesSent: evt.bytesSent,
          chunkCount: evt.chunkCount,
        },
      });
    },
  },
});
```

**Consumer using home-grown logging:**
```typescript
const handler = createDeepAgentsHandler({
  backendUrl,
  hooks: {
    onStreamEnd: (evt) => {
      logger.info('Stream complete', {
        streamId: evt.streamId,
        duration: evt.duration,
        bytes: evt.bytesSent,
      });
    },
  },
});
```

---

## Part 2: Health & Readiness Probes

### No New Dependencies Required

Health probe helpers ship in `@deepagents-nextjs/server`. Uses native `fetch()` + `AbortSignal.timeout()`.

### Types & Exports

```typescript
// packages/server/src/health.ts

export interface HealthProbeConfig {
  deepagentsBackend: string;
  timeout?: number; // ms, default 5000
  checkDependencies?: {
    database?: () => Promise<boolean>;
    cache?: () => Promise<boolean>;
  };
}

export interface HealthStatus {
  ready: boolean;
  status: 'ready' | 'not_ready' | 'error';
  timestamp: number;
  checks: {
    backend: {
      ok: boolean;
      latency?: number;
      error?: string;
    };
    dependencies?: Record<string, boolean>;
  };
}

export function createHealthProbe(config: HealthProbeConfig): {
  check(type: 'liveness' | 'readiness'): Promise<HealthStatus>;
};
```

### Implementation Pattern

```typescript
export function createHealthProbe(config: HealthProbeConfig) {
  return {
    async check(type: 'liveness' | 'readiness') {
      const timestamp = Date.now();

      if (type === 'liveness') {
        // Liveness: just process alive? (lightweight)
        return {
          ready: true,
          status: 'ready',
          timestamp,
          checks: { backend: { ok: true } },
        };
      }

      // Readiness: can serve traffic?
      const checks = {
        backend: { ok: false, latency: 0 },
        dependencies: {},
      };

      // Check backend
      const startTime = Date.now();
      const signal = AbortSignal.timeout(config.timeout ?? 5000);

      try {
        const response = await fetch(`${config.deepagentsBackend}/health`, {
          method: 'HEAD',
          signal,
        });
        checks.backend.ok = response.ok;
        checks.backend.latency = Date.now() - startTime;
      } catch (error) {
        checks.backend.error = (error as Error).message;
      }

      // Check consumer dependencies
      if (config.checkDependencies) {
        for (const [name, checkFn] of Object.entries(config.checkDependencies)) {
          try {
            checks.dependencies[name] = await checkFn();
          } catch {
            checks.dependencies[name] = false;
          }
        }
      }

      const ready = checks.backend.ok &&
                    Object.values(checks.dependencies || {}).every(Boolean);

      return {
        ready,
        status: ready ? 'ready' : 'not_ready',
        timestamp,
        checks,
      };
    },
  };
}
```

### Framework-Specific Examples

**Next.js App Router (`/app/api/health/route.ts`):**
```typescript
import { createHealthProbe } from '@deepagents-nextjs/server';

const probe = createHealthProbe({
  deepagentsBackend: process.env.BACKEND_URL!,
  timeout: 5000,
  checkDependencies: {
    database: async () => {
      // Consumer's DB check
      return await db.raw('SELECT 1');
    },
  },
});

export async function GET(req: Request) {
  const [path] = req.nextUrl.pathname.split('/').slice(-1);
  const probeType = path === 'live' ? 'liveness' : 'readiness';

  const status = await probe.check(probeType);
  return Response.json(status, {
    status: status.ready ? 200 : 503,
    headers: {
      'cache-control': 'no-store',
    },
  });
}
```

**SvelteKit (`routes/+server.ts`):**
```typescript
import { createHealthProbe } from '@deepagents-nextjs/server';

const probe = createHealthProbe({
  deepagentsBackend: env.BACKEND_URL,
});

export async function GET({ url }) {
  const probeType = url.pathname.includes('live') ? 'liveness' : 'readiness';
  const status = await probe.check(probeType);

  return new Response(JSON.stringify(status), {
    status: status.ready ? 200 : 503,
    headers: { 'content-type': 'application/json' },
  });
}
```

**Remix (`routes/health.$type.tsx`):**
```typescript
import { json } from '@remix-run/node';
import { createHealthProbe } from '@deepagents-nextjs/server';

const probe = createHealthProbe({
  deepagentsBackend: process.env.BACKEND_URL!,
});

export async function loader({ params }) {
  const probeType = (params.type as any) || 'readiness';
  const status = await probe.check(probeType);

  return json(status, {
    status: status.ready ? 200 : 503,
  });
}
```

### Kubernetes Probe Configuration

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: deepagents-app
spec:
  containers:
  - name: app
    livenessProbe:
      httpGet:
        path: /api/health/live
        port: 3000
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3

    readinessProbe:
      httpGet:
        path: /api/health/ready
        port: 3000
      initialDelaySeconds: 5
      periodSeconds: 5
      timeoutSeconds: 5
      failureThreshold: 2
```

---

## Part 3: Resilience Controls

### 3.1 Rate Limiting (Zero-Dependency)

**Built-in token bucket implementation** — ~50 lines of code in `@deepagents-nextjs/server`.

```typescript
// packages/server/src/resilience.ts

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyGenerator?: (req: Request) => string;
}

export function createRateLimiter(config: RateLimitConfig) {
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  return {
    allow(key: string): boolean {
      const now = Date.now();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: config.maxRequests, lastRefill: now };
        buckets.set(key, bucket);
      }

      // Refill tokens
      const timePassed = now - bucket.lastRefill;
      const tokensToAdd = (timePassed / config.windowMs) * config.maxRequests;
      bucket.tokens = Math.min(config.maxRequests, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
```

**Usage:**
```typescript
const limiter = createRateLimiter({
  maxRequests: 100,
  windowMs: 60000, // 1 minute
});

createDeepAgentsHandler({
  backendUrl,
  middleware: [
    (req) => {
      const sessionId = req.headers.get('x-session-id') || 'default';
      if (!limiter.allow(sessionId)) {
        return new Response('Rate limited', { status: 429 });
      }
      return null; // pass through
    },
  ],
});
```

### 3.2 Circuit Breaker (Optional: cockatiel@3.2.1)

**Optional dependency** for advanced consumers. Basic built-in version available.

**Built-in simple version:**
```typescript
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number; // ms to stay open
}

export function createCircuitBreakerTransform(config: CircuitBreakerConfig) {
  let state: 'closed' | 'open' | 'half_open' = 'closed';
  let failureCount = 0;
  let successCount = 0;
  let lastFailTime = 0;

  return (frame: string): string | null => {
    const now = Date.now();

    // If open and timeout expired, try half-open
    if (state === 'open' && now - lastFailTime > config.timeout) {
      state = 'half_open';
      successCount = 0;
    }

    // In half-open, allow one request to test
    if (state === 'half_open') {
      // If frame is error, reopen
      if (frame.includes('error')) {
        state = 'open';
        lastFailTime = now;
        return null;
      }
      // If success, close
      successCount++;
      if (successCount >= config.successThreshold) {
        state = 'closed';
        failureCount = 0;
      }
      return frame;
    }

    // Closed: normal operation
    if (state === 'closed') {
      if (frame.includes('error')) {
        failureCount++;
        if (failureCount >= config.failureThreshold) {
          state = 'open';
          lastFailTime = now;
          return null;
        }
      } else {
        failureCount = 0;
      }
      return frame;
    }

    return null; // open, drop
  };
}
```

**For advanced use, optional cockatiel:**
```bash
npm install cockatiel@3.2.1  # Consumer choice, not library requirement
```

```typescript
// Consumer adds cockatiel if desired
import { CircuitBreaker } from 'cockatiel';

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  timeout: 30000,
});

createDeepAgentsHandler({
  backendUrl,
  transforms: [
    async (frame) => {
      return breaker.execute(() => Promise.resolve(frame));
    },
  ],
});
```

### 3.3 Backpressure (Web Streams API Standard)

**Native to streaming pipeline** — no additional dependency.

```typescript
// packages/server/src/backpressure.ts

export async function createBackpressureTransform(
  readableStream: ReadableStream<string>,
  onBackpressure?: (buffered: number) => void
): Promise<ReadableStream<string>> {
  return readableStream.pipeThrough(
    new TransformStream({
      async transform(chunk, controller) {
        // WritableStream handles backpressure automatically
        // when controller.enqueue() returns a Promise that resolves
        const result = controller.enqueue(chunk);
        
        if (onBackpressure) {
          // Signal to upstream if buffered
          onBackpressure(controller.desiredSize ?? 0);
        }

        // Wait for buffer to drain if needed
        await result;
      },
    })
  );
}
```

---

## Part 4: Timeout & Abort (Web Standards)

### No New Dependencies

Uses native `AbortController` + `AbortSignal.timeout()` (available in Node 17+, all modern runtimes).

```typescript
// packages/server/src/timeout.ts

export interface TimeoutConfig {
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
}

export function createTimeoutTransform(config: TimeoutConfig) {
  return (req: Request): Request => {
    const signal = AbortSignal.timeout(config.requestTimeoutMs ?? 30000);
    
    return new Request(req, {
      signal: AbortSignal.any([req.signal, signal]),
    });
  };
}
```

**Usage:**
```typescript
createDeepAgentsHandler({
  backendUrl,
  timeout: 30000, // 30s request timeout
  streamTimeout: 300000, // 5m stream timeout
});
```

---

## Part 5: Graceful Shutdown (Node.js Only)

### No New Dependencies

SIGTERM/SIGINT handling + active stream tracking (built-in).

```typescript
// packages/server/src/graceful-shutdown.ts

export interface GracefulShutdownConfig {
  timeoutMs?: number; // default 30s
}

export function createGracefulShutdownHandler(
  handler: DeepAgentsHandler,
  config?: GracefulShutdownConfig
) {
  let activeStreams = 0;
  let isShuttingDown = false;

  const originalHandler = handler;

  // Track active streams
  return async (req: Request) => {
    if (isShuttingDown) {
      return new Response('Service shutting down', { status: 503 });
    }

    activeStreams++;
    try {
      return await originalHandler(req);
    } finally {
      activeStreams--;
    }
  };

  // Shutdown hook
  return {
    handler,
    async shutdown() {
      isShuttingDown = true;
      const timeout = config?.timeoutMs ?? 30000;
      const startTime = Date.now();

      while (activeStreams > 0 && Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return activeStreams === 0; // true if clean, false if timeout
    },
  };
}
```

**Usage in Next.js:**
```typescript
import { createDeepAgentsHandler } from '@deepagents-nextjs/server';

const { handler, shutdown } = createGracefulShutdownHandler(
  createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! }),
  { timeoutMs: 30000 }
);

// SIGTERM handler
process.on('SIGTERM', async () => {
  console.log('SIGTERM received');
  const cleaned = await shutdown();
  process.exit(cleaned ? 0 : 1);
});

export const POST = handler;
```

---

## Part 6: Deployment Ops

### 6.1 Vercel Blue-Green Canary (No SDK)

**Uses Vercel Edge Config** — no new npm dependency.

```typescript
// middleware.ts
import { getEdgeConfig } from '@vercel/edge-config';

export async function middleware(request: NextRequest) {
  const config = await getEdgeConfig();
  const deployment = config.get('deployment_target') as 'blue' | 'green' || 'blue';

  // Rewrite to blue or green deployment
  return NextResponse.rewrite(
    new URL(`/api/${deployment}/...`, request.url)
  );
}
```

**Vercel setup:**
```bash
# Create Edge Config
vercel env add EDGE_CONFIG

# Link to project
vercel env link

# Add value in UI or CLI
vercel env pull EDGE_CONFIG

# In Edge Config: {"deployment_target": "blue"}
```

### 6.2 Error Reporting Integration (Optional)

**Sentry** (optional, consumer adds):
```bash
npm install @sentry/node @sentry/tracing  # consumer choice
```

```typescript
// Consumer code
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    nodeProfilingIntegration(),
    new Sentry.Integrations.Http({ tracing: true }),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 0.1,
});

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  hooks: {
    onError: (evt) => {
      Sentry.captureException(evt.error, {
        tags: {
          stage: evt.context.stage,
          streamId: evt.streamId,
        },
        contexts: {
          stream: {
            bytes: evt.bytesSent,
            chunks: evt.chunkCount,
          },
        },
      });
    },
  },
});

export const POST = Sentry.wrapHandler(handler);
```

**Rollbar** (optional, consumer adds):
```bash
npm install rollbar  # consumer choice
```

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **OpenTelemetry SDK** (`@opentelemetry/api`, `@opentelemetry/sdk-node`) | Locked design boundary; 5+ transitive deps; consumers choose their own vendor | Callback hooks + consumer wires OTel if desired |
| **Pino** / **Winston** as runtime deps | Forces logging library on consumers | Use `console` or hook-based injection |
| **express-rate-limit** | Express-specific; heavy | Implement token bucket (~50 lines) |
| **Node-only deps in `/edge` package** | Breaks edge-runtime compatibility | Web Streams API + fetch only |
| **@sentry/node as shipped runtime dep** | Vendor lock-in; defeats zero-dep goal | Document consumer integration pattern |
| **Database client libs in server** | Not proxy's responsibility; consumers manage | Document health check wiring examples |

---

## Version Compatibility

| Package | Constraint | Status | Notes |
|---------|-----------|--------|-------|
| **Node.js** | ^18.17.0 | ✓ | AbortController, fetch stable |
| **TypeScript** | ^6.0.3 | ✓ | AbortSignal types in lib.dom |
| **Deno** | ^1.40.0 | ✓ | Web Streams, AbortController, fetch native |
| **Cloudflare** | 2024-09+ | ✓ | fetch, AbortController, TransformStream |
| **Vitest** | ^4.1.8 | ✓ | Works with streaming code |
| **Playwright** | ^1.44.0 | ✓ | Current, stable |
| **cockatiel** (optional) | ^3.2.1 | ⚠ Node only | Not edge-safe as runtime dep |
| **bottleneck** (optional) | ^2.19.5 | ⚠ Node only | Not edge-safe as runtime dep |

---

## Testing Strategy

### Unit Tests (Vitest)

```typescript
// packages/server/src/__tests__/observability.test.ts
import { createDeepAgentsHandler } from '../index';

test('onRequest hook fires with timestamp', async () => {
  const events: any[] = [];
  const handler = createDeepAgentsHandler({
    backendUrl: 'http://localhost:3000',
    hooks: {
      onRequest: (evt) => events.push(evt),
    },
  });

  await handler(mockRequest);
  
  expect(events).toHaveLength(1);
  expect(events[0].timestamp).toBeGreaterThan(0);
});

test('onError hook captures exception', async () => {
  const errors: any[] = [];
  const handler = createDeepAgentsHandler({
    backendUrl: 'http://invalid-backend.test',
    hooks: {
      onError: (evt) => errors.push(evt),
    },
  });

  await expect(handler(mockRequest)).rejects.toThrow();
  expect(errors).toHaveLength(1);
});

// Health probe tests
test('health probe returns ready when backend ok', async () => {
  const probe = createHealthProbe({
    deepagentsBackend: 'http://localhost:3000',
    timeout: 1000,
  });

  // Mock successful backend
  mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

  const status = await probe.check('readiness');
  expect(status.ready).toBe(true);
});

// Circuit breaker tests
test('circuit breaker opens after failures', async () => {
  const breaker = createCircuitBreakerTransform({
    failureThreshold: 2,
    successThreshold: 1,
    timeout: 5000,
  });

  expect(breaker('error')).toBeNull(); // fail 1
  expect(breaker('error')).toBeNull(); // fail 2 → open
  expect(breaker('ok')).toBeNull(); // dropped, circuit open
});

// Rate limiter tests
test('rate limiter allows requests up to limit', async () => {
  const limiter = createRateLimiter({
    maxRequests: 2,
    windowMs: 1000,
  });

  expect(limiter.allow('session1')).toBe(true);
  expect(limiter.allow('session1')).toBe(true);
  expect(limiter.allow('session1')).toBe(false); // exceeded
});
```

**Coverage goal:** ≥90% for new observability/resilience code.

### Mutation Testing (Stryker)

```bash
pnpm test:mutation --testPathPattern=resilience
```

Validates circuit breaker state machine logic.

---

## Installation Summary

### Core (Zero New Deps)

```bash
# In @deepagents-nextjs/server package only
# Types & exports added; no npm install needed
```

### Optional (Consumer Choice)

```bash
# If consumer wants advanced circuit breaker
npm install cockatiel@3.2.1

# If consumer wants error reporting to Sentry
npm install @sentry/node@~8.x
```

---

## Deployment Runbooks

### Kubernetes Liveness/Readiness

```bash
# Configure in deployment spec
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deepagents-app
spec:
  template:
    spec:
      containers:
      - name: app
        livenessProbe:
          httpGet:
            path: /api/health/live
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
EOF
```

### Vercel Blue-Green Switchover

```bash
# 1. Deploy green version (new code)
vercel deploy --prod --alias green

# 2. Route traffic to green via Edge Config
vercel env add EDGE_CONFIG
# Set: {"deployment_target": "green"}

# 3. Monitor logs, metrics
# (queries from error reporting SDK)

# 4. Switch back to blue if needed
# Set: {"deployment_target": "blue"}

# 5. Keep previous version for 24h for rollback
```

### Graceful Shutdown

```bash
# In container orchestration (Docker/Kubernetes)
# Ensure SIGTERM handler has time to drain

# Docker
STOPSIGNAL SIGTERM
--stop-timeout 35  # 35s (handler waits 30s + buffer)

# Kubernetes
terminationGracePeriodSeconds: 35
```

---

## Confidence Assessment

| Area | Level | Notes |
|------|-------|-------|
| **Observability hooks** | HIGH | Zero-dep callback pattern; standard in Node.js |
| **Health probes** | HIGH | Native fetch + AbortSignal.timeout() stable across runtimes |
| **Rate limiting** | HIGH | Token bucket algorithm simple & proven |
| **Circuit breaker** | HIGH | Basic version tested; cockatiel@3.2.1 stable for advanced |
| **Timeout/abort** | HIGH | AbortSignal Web standard, available Node 17+, edge runtimes |
| **Graceful shutdown** | HIGH | SIGTERM + stream tracking pattern standard for Node |
| **Blue-green deployment** | HIGH | Vercel Edge Config + Middleware documented & tested |
| **Error reporting** | MEDIUM | Sentry/Rollbar patterns documented; consumer-choice SDKs |

---

## Sources

- [AbortController | MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [Node.js Timers Documentation](https://nodejs.org/api/timers.html)
- [Using AbortSignal in Node.js | OpenJS Foundation](https://openjsf.org/blog/using-abortsignal-in-node-js/)
- [Backpressuring in Streams | Node.js Documentation](https://nodejs.org/learn/modules/backpressuring-in-streams)
- [Web Streams API | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API)
- [Cockatiel | GitHub](https://github.com/connor4312/cockatiel)
- [Cockatiel v3.2.1 | npm](https://www.npmjs.com/package/cockatiel)
- [The Observer Pattern in TypeScript | DEV Community](https://dev.to/gabrielanhaia/the-observer-pattern-in-typescript-when-you-dont-need-rxjs-4l7j)
- [Health Checks | Node.JS Reference Architecture](https://nodeshift.dev/nodejs-reference-architecture/operations/healthchecks/)
- [Kubernetes Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Building a Health-Check Microservice with FastAPI | DEV Community](https://dev.to/lisan_al_gaib/building-a-health-check-microservice-with-fastapi-26jo)
- [Blue-Green Deployments on Vercel | Vercel](https://vercel.com/templates/next.js/blue-green-deployments-vercel)
- [Implementing Canary Deployments on Vercel | Vercel KB](https://vercel.com/kb/guide/implementing_canary_deployments_on_vercel)
- [API Resilience: Circuit Breakers, Retries 2026 | APIScout](https://apiscout.dev/blog/api-resilience-circuit-breakers-retries-bulkheads-2026)
- [Graceful Shutdown in Node.js | DEV Community](https://dev.to/young_gao/graceful-shutdown-in-nodejs-stop-dropping-requests-228p)
- [Sentry | Error Tracking & Performance Monitoring](https://sentry.io/)
- [Vercel Edge Config](https://vercel.com/docs/edge-config)

---

**Stack research for:** v1.6 Production Readiness & Observability  
**Researched:** 2026-06-05  
**Status:** Ready for requirements definition and phase planning
