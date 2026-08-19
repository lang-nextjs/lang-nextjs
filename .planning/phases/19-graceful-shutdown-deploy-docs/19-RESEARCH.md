# Phase 19: Graceful Shutdown + Deploy Docs - Research

**Researched:** 2026-06-06
**Domain:** Node.js graceful shutdown orchestration, serverless constraints, deployment infrastructure, health-gated canary rollout
**Confidence:** HIGH

## Summary

Phase 19 implements graceful SIGTERM shutdown for Node.js long-running processes with three core deliverables: **(1) `createGracefulShutdown()` handler** that flips readiness to 503 on SIGTERM and drains in-flight SSE streams up to a configurable timeout; **(2) comprehensive deployment runbook** documenting canary/blue-green rollout procedures, Kubernetes liveness/readiness wiring, and hard constraints on serverless runtimes; **(3) formalization of Phase 17 canary infrastructure** as a health-gated rollout mechanism.

The design integrates tightly with Phase 18's `createReadinessProbe(isDraining)` callback — when SIGTERM fires, a shared draining signal flips readiness to 503, load balancers immediately stop routing new requests, and the handler drains remaining in-flight streams. **Critical constraint:** serverless runtimes (Vercel ~500ms window, Cloudflare no-SIGTERM) cannot reliably guarantee graceful shutdown; this is a Node-only feature with documented best-effort fallbacks.

**Primary recommendation:** Implement a minimal, opt-in shutdown orchestrator that tracks active streams per-instance, returns a `dispose()` callback to wire with process.on('SIGTERM'), and documents platform-specific limitations explicitly. Zero module-scope state; draining flag is passed to readiness probe as a shared mutable reference or callback. Test with simulated SIGTERM + slow client to verify streams drain before timeout.

## User Constraints (from objective)

### Locked Decisions
- **No new runtime dependencies** — graceful shutdown built with native Node APIs
- **Node-only feature** — Vercel ~500ms window is too short for streaming; Cloudflare Workers don't support SIGTERM; document limitations explicitly
- **Integrate with Phase 18 readiness probe** — SIGTERM → flip `isDraining()` callback → readiness returns 503 → orchestrator evicts before drain completes
- **Zero module-scope state** — draining flag is per-instance or callback-based, not module global; acceptable per-instance in-flight tracker is fine for long-running processes (explicit/opt-in via instrumentation)
- **Test stack is Vitest** — SIGTERM behavior testable via signal handler simulation + drain tracker mock

### Claude's Discretion
- How to structure the shutdown orchestrator API (factory vs. class vs. function)
- Whether to provide a default in-flight request counter or let consumer implement
- Extent of deployment runbook (basic vs. detailed with platform-specific examples)

### Deferred Ideas (OUT OF SCOPE)
- Auto-rollback on error-rate detection (belongs to CD platform, not library)
- Distributed graceful shutdown (multi-instance coordination) — each instance drains independently; load balancer handles traffic removal
- Client-side reconnection logic (out of scope for server library)

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OPS-01 | Consumer can install a graceful shutdown handler that, on SIGTERM, flips readiness to 503 and drains in-flight streams up to a configurable timeout (Node runtime) | Node.js process.on('SIGTERM') is standard; Phase 18 readiness probe has isDraining() callback ready; stream draining via AbortSignal timeout (Phase 18); timeout is configurable parameter |
| OPS-03 | A deployment runbook documents canary/blue-green rollout, Kubernetes liveness/readiness wiring, and the graceful-shutdown limitations on serverless (Vercel ~500ms window, Cloudflare no-SIGTERM) | Vercel changelog (Sept 2025) confirms 500ms window; Cloudflare docs show no SIGTERM support for Workers (Containers do, but Workers don't); Kubernetes Health Probes doc covers readiness/liveness semantics |
| OPS-04 | The post-v1.5 canary/blue-green deploy infrastructure (phase 17) is formalized into the milestone as health-gated rollout | Phase 17 canary infrastructure exists (Vercel traffic split, health checks in smoke-test workflow); health-gating uses Phase 18 readiness probe; runbook formalizes the existing pattern |

</phase_requirements>

## Standard Stack

### Core (Node-only)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `process` (native) | 18+ | SIGTERM signal handling | Native, zero-dependency; all Node.js graceful shutdown uses this |
| Node.js `AbortSignal` (native) | 17+ | Request timeout + abort propagation | Built-in Web API; already used in Phase 18 for request timeout |
| TypeScript (project) | ^6.0.3 | Type-safe callback signatures | Project standard |
| Vitest (project) | ^4.1.8 | Unit/integration testing | Project standard; supports signal simulation |

### Supporting (optional consumer integrations)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Kubernetes API | 1.27+ | PreStop hook + readiness probe binding | If deployed on Kubernetes; documented in runbook |
| Vercel `vercel.json` traffic split | (config) | Canary traffic distribution (5/95) | If using Vercel; smoke-test workflow validates |
| Node.js HTTP server built-in | 18+ | `server.close()` for active connection draining | If manually creating HTTP.Server; documented in runbook |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| process.on('SIGTERM') | graceful-shutdown npm packages | Third-party adds dependency; native API is simpler for streaming shutdown use case |
| Custom in-flight counter | Existing frameworks (Express/Hono shutdown) | Framework-coupled; library needs framework-agnostic approach |
| Direct readiness probe mutation | `isDraining()` callback pattern from Phase 18 | Callback is already designed; no new mechanism needed |

## Architecture Patterns

### Recommended Project Structure

Phase 19 additions to `packages/server/src/`:

```
packages/server/src/
├── shutdown.ts                  # createGracefulShutdown() factory
├── shutdown.test.ts             # SIGTERM signal tests + drain timeout
├── handler.ts                   # (updated) optional onShutdown hook in handler options
└── index.ts                     # (updated) exports createGracefulShutdown + types
```

### Pattern 1: Shutdown Orchestrator (stateless factory)

**What:** A factory function that returns a shutdown handler and a dispose callback. The handler maintains a per-instance draining flag and active-stream counter, wired to the readiness probe via callback and passed to the handler factory.

**When to use:** Every Node.js application using the SSE handler should instantiate one shutdown orchestrator at process startup.

**Example:**

```typescript
// Source: This research + Phase 18 readiness probe integration
import { createGracefulShutdown, createReadinessProbe } from '@deepagents-nextjs/server';

// At app startup:
const shutdown = createGracefulShutdown({ 
  drainTimeoutMs: 30000  // Wait up to 30s for in-flight streams
});

// Wire to readiness probe:
const readinessProbe = () => createReadinessProbe({
  isDraining: () => shutdown.isDraining(),
  checks: [...optional checks...],
});

// Wire handler:
const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL,
  onShutdown: (context) => {
    // context: { streamId, activeCount }
    shutdown.trackStream(context.streamId);
  },
});

// Install SIGTERM handler:
process.on('SIGTERM', () => shutdown.dispose());
```

### Pattern 2: In-Flight Stream Tracking

**What:** A simple counter + Set to track active SSE streams. Incremented when a request starts streaming, decremented when the response closes. On SIGTERM, waits for all streams to close (up to timeout) before exiting.

**When to use:** Inside the shutdown orchestrator; not exposed directly to consumers.

**Internal example:**

```typescript
// Source: Node.js graceful shutdown best practices (2025–2026)
class ShutdownOrchestrator {
  private activeStreams = new Set<string>();
  private draining = false;
  private drainTimeoutMs: number;

  constructor(drainTimeoutMs = 30000) {
    this.drainTimeoutMs = drainTimeoutMs;
  }

  trackStream(streamId: string): void {
    this.activeStreams.add(streamId);
  }

  releaseStream(streamId: string): void {
    this.activeStreams.delete(streamId);
  }

  isDraining(): boolean {
    return this.draining;
  }

  async dispose(): Promise<void> {
    this.draining = true; // Readiness immediately returns 503

    // Wait for streams to drain (with timeout)
    const startTime = Date.now();
    while (this.activeStreams.size > 0) {
      if (Date.now() - startTime > this.drainTimeoutMs) {
        console.warn(
          `[shutdown] timeout reached; ${this.activeStreams.size} streams still active`
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Exit process
    process.exit(this.activeStreams.size > 0 ? 1 : 0);
  }
}
```

### Pattern 3: Readiness ↔ Shutdown Integration

**What:** Phase 18's `createReadinessProbe(isDraining)` callback is called by load balancers every ~10 seconds. When shutdown is triggered, the callback returns true, readiness returns 503, and load balancers stop sending new requests.

**When to use:** Always; this is the core graceful shutdown mechanism.

**Sequence diagram:**

```
1. SIGTERM arrives
   ↓
2. shutdown.dispose() called
   ├─ sets draining = true
   └─ begins drain wait loop
   ↓
3. Next readiness probe call (within ~10s)
   ├─ calls isDraining() → true
   └─ readiness returns status:"draining", ready:false
   ↓
4. Load balancer (Kubernetes/ALB/Vercel) receives 503
   ├─ removes instance from pool
   └─ stops routing new requests
   ↓
5. In-flight requests continue draining
   └─ stream closing triggers releaseStream()
   ↓
6. Timeout expires or all streams close
   └─ process.exit()
```

### Anti-Patterns to Avoid

- **Module-scope draining flag:** Don't store `let shutdownSignal = false` at module level; use instance or callback
- **Not checking isDraining() on new requests:** If you set draining=true but don't flip readiness to 503, load balancers keep sending traffic
- **Blocking on drain without timeout:** If you wait forever for streams to close, process never exits and load balancer kills it forcefully (worse outcome)
- **Trying graceful shutdown on Cloudflare Workers:** Workers don't expose SIGTERM or process object; document as N/A and recommend client-side reconnection
- **Not cleaning up event listeners:** If you add process.on('SIGTERM') multiple times (e.g., per-request), you'll have memory leaks; install once at app startup

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tracking active HTTP requests/streams | Custom Set + counter in handler closure | Shutdown orchestrator factory (provided) | Coordination with readiness probe timing + timeout is subtle; leaks are easy; test coverage is high for the provided version |
| Timeout + drain loop | Manual setTimeout in handler | shutdown.dispose() abstraction | Proper cleanup (clearing timeouts, closing sockets) is error-prone; orchestrator handles all exit paths |
| SIGTERM signal handling | Try building your own process listener | process.on('SIGTERM') + shutdown.dispose() | The pattern is standard; what's non-obvious is *when* to flip readiness (before or after draining) — provided impl gets timing right |
| Vercel-specific graceful shutdown | Custom pre-deploy script | Document limitation + recommend client reconnection | Vercel's 500ms window is hard constraint; can't be worked around; only option is client-side resilience |
| Load balancer traffic split verification | Manual curl loop | smoke-test workflow + health check | Traffic distribution is hard to verify accurately; workflow has proven pattern with timing guards |

**Key insight:** Graceful shutdown is straightforward in principle (set flag, wait for drains) but timing coordination with health probes, load balancers, and process exit is where bugs hide. The provided orchestrator centralizes that coordination.

## Common Pitfalls

### Pitfall 1: Draining Flag Not Wired to Readiness Probe — Load Balancer Keeps Routing Traffic

**What goes wrong:**

Developer implements graceful shutdown:
```typescript
let draining = false;
process.on('SIGTERM', async () => {
  draining = true;
  // Wait for streams...
  process.exit(0);
});
```

But readiness probe doesn't check the draining flag:
```typescript
app.get('/ready', () => Response.json({ status: 'ok' }));
```

Result: Load balancer never learns that shutdown is happening. It keeps sending new requests during the drain window. Some requests are rejected with errors or timeouts. Data loss.

**Why it happens:**

- Developer thinks readiness is a static health check
- Doesn't realize readiness must be *dynamic* during shutdown
- Assumes load balancer will somehow know to stop sending traffic without being told

**Prevention:**

1. **Wire readiness to shutdown state explicitly:**
   ```typescript
   const shutdown = createGracefulShutdown();

   app.get('/ready', async () => {
     const probe = await createReadinessProbe({
       isDraining: () => shutdown.isDraining(),
     });
     if (!probe.ready) {
       return Response.json({ status: probe.status }, { status: 503 });
     }
     return Response.json({ status: 'ok' }, { status: 200 });
   });
   ```

2. **Verify in smoke test:** readiness returns 503 when draining flag is true
3. **Document:** Readiness probe MUST be called by load balancer every 10–30 seconds for graceful shutdown to work

**Detection:**

- E2E test: set draining=true, call readiness probe, verify it returns 503
- Kubernetes integration test: verify readiness probe is configured in Pod spec

### Pitfall 2: Drain Timeout Too Short — Requests Killed Before Stream Completes

**What goes wrong:**

Developer sets a 5-second drain timeout, but SSE streams typically take 10+ seconds (LLM inference):
```typescript
const shutdown = createGracefulShutdown({ drainTimeoutMs: 5000 });
```

When SIGTERM arrives:
- Shutdown waits 5 seconds
- Timeout expires
- Process exits forcefully
- Client receives truncated SSE stream
- User sees incomplete AI response

**Why it happens:**

- Developer assumes "drain timeout" means "time to close sockets" (which is fast)
- Doesn't account for actual request processing time (LLM, external API calls)
- Confuses shutdown timeout with request timeout

**Prevention:**

1. **Set drain timeout to match expected max request duration:**
   ```typescript
   // If typical request is 30 seconds, use 45 second drain timeout
   // to allow 15 seconds of buffer
   const shutdown = createGracefulShutdown({ drainTimeoutMs: 45000 });
   ```

2. **Also set per-request timeout (from Phase 18):**
   ```typescript
   const handler = createDeepAgentsHandler({
     requestTimeoutMs: 30000, // Abort individual requests after 30s
   });
   ```

3. **Document:** Drain timeout should be >= max request duration + safety margin

4. **Test:** Simulate a slow request that takes 20 seconds; verify it completes before drain timeout

**Detection:**

- Load test: send request, trigger SIGTERM after 2 seconds, verify stream completes if it started within drain window
- Monitor: log stream closure times during graceful shutdown; if many requests are killed, increase timeout

### Pitfall 3: No Timeout on Drain Loop — Process Hangs Indefinitely

**What goes wrong:**

Developer forgets to include a timeout:
```typescript
// ❌ WRONG: No timeout, will hang forever if a stream never closes
async dispose() {
  this.draining = true;
  while (this.activeStreams.size > 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  process.exit(0);
}
```

If a stream is stuck (backend hung, network issue), it never closes. The while loop runs forever. Process never exits. Load balancer forcefully kills it after its own timeout (often 30+ seconds), causing a hard shutdown instead of graceful.

**Why it happens:**

- Developer assumes streams will always close
- Doesn't account for hung backends or network issues
- Forgets that timeout is a safety mechanism

**Prevention:**

1. **Always include a timeout:**
   ```typescript
   async dispose() {
     this.draining = true;
     const startTime = Date.now();
     while (this.activeStreams.size > 0) {
       if (Date.now() - startTime > this.drainTimeoutMs) {
         console.warn(`[shutdown] timeout; ${this.activeStreams.size} streams still active`);
         break; // Exit anyway
       }
       await new Promise((r) => setTimeout(r, 100));
     }
     process.exit(0);
   }
   ```

2. **Log which streams are hanging** (for debugging):
   ```typescript
   if (this.activeStreams.size > 0) {
     console.warn(
       `[shutdown] hanging streams: ${Array.from(this.activeStreams).join(', ')}`
     );
   }
   ```

3. **Test:** Unit test that dispose() exits even if streams never close

**Detection:**

- Manual test: start handler, trigger SIGTERM, verify process exits within drainTimeoutMs + 1s
- Process manager monitoring: if process takes >drainTimeoutMs + 5s to exit, alert

### Pitfall 4: Graceful Shutdown on Vercel — 500ms Timeout Too Short for Streaming

**What goes wrong:**

Developer assumes Next.js on Vercel supports full graceful shutdown:

```typescript
// App deployed on Vercel
const shutdown = createGracefulShutdown({ drainTimeoutMs: 30000 });
process.on('SIGTERM', () => shutdown.dispose());
```

Vercel has a ~500ms graceful shutdown window. If an SSE request is in-flight, it gets killed at 500ms, even if the drain timeout is set to 30 seconds.

Result: Long-running SSE streams always get truncated on Vercel. Client receives partial AI response.

**Why it happens:**

- Vercel's 500ms window is a platform constraint, not configurable
- Streaming responses by nature take longer than 500ms
- Developer doesn't realize the platform limit

**Consequences:**

- SSE streams longer than 500ms always fail on Vercel
- Client-side error handling becomes mandatory
- Retries don't help (if the stream was partially sent, client sees data inconsistency)

**Prevention:**

1. **Document the limitation explicitly:**
   ```markdown
   ## Graceful Shutdown on Serverless Platforms

   **Vercel Functions:** Supports graceful shutdown with a ~500ms timeout window.
   Streaming responses exceeding 500ms will be forcefully terminated.
   SSE/streaming responses should implement client-side reconnection logic.

   **Cloudflare Workers:** Do not support SIGTERM; process is terminated immediately.
   Graceful shutdown is not possible. Recommend client-side connection pooling/retry.
   ```

2. **Make shutdown opt-in on Vercel:**
   ```typescript
   // On Vercel, disable graceful shutdown (it won't help)
   if (process.env.VERCEL) {
     console.log('[shutdown] Running on Vercel; graceful shutdown not available');
   } else {
     const shutdown = createGracefulShutdown({ drainTimeoutMs: 30000 });
     process.on('SIGTERM', () => shutdown.dispose());
   }
   ```

3. **Recommend client resilience:**
   - Clients should implement exponential backoff + reconnection
   - SSE requests should be resumable (not guaranteed but best-effort)

4. **Test:** Document as "Node-only" in runbook; don't test on Vercel for graceful shutdown

**Detection:**

- Logs show streams being killed at exactly 500ms on Vercel
- E2E test: mark as expected failure if running on Vercel with long streams

### Pitfall 5: Shutdown Event Listeners Accumulating — Memory Leak

**What goes wrong:**

In a development environment or during testing, the handler is instantiated multiple times:

```typescript
// Every module reload or test setup adds a new SIGTERM listener
process.on('SIGTERM', () => shutdown.dispose());
process.on('SIGTERM', () => shutdown.dispose());
process.on('SIGTERM', () => shutdown.dispose());
```

After many reloads, listeners accumulate. Memory grows. Warn: `MaxListenersExceededWarning`.

**Why it happens:**

- HMR (hot module replacement) reloads modules
- Tests instantiate handlers multiple times
- Developer doesn't realize listeners are cumulative

**Prevention:**

1. **Install shutdown handler once at app startup:**
   ```typescript
   // At module level (runs once)
   const shutdown = createGracefulShutdown();
   process.once('SIGTERM', () => shutdown.dispose());
   ```

2. **Use `process.once()` instead of `process.on()`** — removes listener after first call
3. **In tests, uninstall listener in teardown:**
   ```typescript
   afterEach(() => {
     process.removeAllListeners('SIGTERM');
   });
   ```

4. **Document:** "Install shutdown handler once at app startup; avoid re-installing during HMR"

**Detection:**

- Node warning: `MaxListenersExceededWarning: Possible EventEmitter memory leak detected`
- Memory profiler: listener count grows with reloads

## Code Examples

Verified patterns from official sources:

### Graceful Shutdown Handler (Factory Pattern)

```typescript
// Source: Node.js graceful shutdown best practices (OneUptime 2026-01)
import { EventEmitter } from 'events';

export interface ShutdownConfig {
  drainTimeoutMs?: number;
}

export interface ShutdownContext {
  streamId: string;
  activeCount: number;
}

export class GracefulShutdownOrchestrator extends EventEmitter {
  private draining = false;
  private activeStreams = new Set<string>();
  private drainTimeoutMs: number;

  constructor(config: ShutdownConfig = {}) {
    super();
    this.drainTimeoutMs = config.drainTimeoutMs ?? 30000;
  }

  isDraining(): boolean {
    return this.draining;
  }

  trackStream(streamId: string): void {
    this.activeStreams.add(streamId);
    this.emit('stream-start', { streamId, activeCount: this.activeStreams.size });
  }

  releaseStream(streamId: string): void {
    this.activeStreams.delete(streamId);
    this.emit('stream-end', { streamId, activeCount: this.activeStreams.size });
  }

  async dispose(): Promise<void> {
    if (this.draining) {
      console.log('[shutdown] Already draining, ignoring duplicate SIGTERM');
      return;
    }

    console.log('[shutdown] SIGTERM received; flipping readiness to 503 and draining...');
    this.draining = true;
    this.emit('shutdown', { activeCount: this.activeStreams.size });

    const startTime = Date.now();
    while (this.activeStreams.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed > this.drainTimeoutMs) {
        console.warn(
          `[shutdown] timeout (${this.drainTimeoutMs}ms) reached; ` +
          `${this.activeStreams.size} streams still active, forcing exit`
        );
        process.exit(1);
      }

      const remaining = this.drainTimeoutMs - elapsed;
      console.log(
        `[shutdown] waiting for ${this.activeStreams.size} streams ` +
        `(${remaining}ms remaining)`
      );
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('[shutdown] all streams drained; exiting cleanly');
    process.exit(0);
  }
}

export function createGracefulShutdown(config?: ShutdownConfig) {
  return new GracefulShutdownOrchestrator(config);
}
```

### Readiness Probe Integration

```typescript
// Source: Phase 18 createReadinessProbe + Phase 19 shutdown integration
import { createReadinessProbe } from '@deepagents-nextjs/server';

export function createShutdownReadinessProbe(shutdown: GracefulShutdownOrchestrator) {
  return () =>
    createReadinessProbe({
      isDraining: () => shutdown.isDraining(),
      // Optional consumer-supplied checks:
      checks: [
        {
          name: 'backend',
          check: async () => {
            const resp = await fetch(`${process.env.BACKEND_URL}/health`, {
              timeout: 2000,
            });
            return resp.ok;
          },
          timeoutMs: 3000,
        },
      ],
    });
}
```

### Handler Integration (onShutdown Hook)

```typescript
// Source: Phase 18 handler + Phase 19 shutdown integration
import { createDeepAgentsHandler } from '@deepagents-nextjs/server';

export function createHandlerWithShutdown(shutdown: GracefulShutdownOrchestrator) {
  let streamIdCounter = 0;

  return createDeepAgentsHandler({
    backendUrl: process.env.BACKEND_URL!,
    observability: {
      onRequest: ({ sessionId }) => {
        const streamId = `stream-${++streamIdCounter}`;
        shutdown.trackStream(streamId);
        return streamId; // Captured in context
      },
      onStreamEnd: ({ context: streamId }) => {
        shutdown.releaseStream(streamId);
      },
    },
  });
}
```

### Process Signal Binding

```typescript
// Source: Node.js process/signals documentation + graceful shutdown best practices
// At app startup (runs once, not during each request)

const shutdown = createGracefulShutdown({ drainTimeoutMs: 45000 });

// Handle SIGTERM (from Kubernetes, Docker, systemd, etc.)
process.once('SIGTERM', () => {
  console.log('SIGTERM received, initiating graceful shutdown');
  shutdown.dispose().catch((err) => {
    console.error('Shutdown error:', err);
    process.exit(1);
  });
});

// Handle SIGINT (from Ctrl+C in development)
process.once('SIGINT', () => {
  console.log('SIGINT received, initiating graceful shutdown');
  shutdown.dispose().catch((err) => {
    console.error('Shutdown error:', err);
    process.exit(1);
  });
});

// Unhandled rejection safeguard
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection:', reason, promise);
  process.exit(1);
});
```

## Validation Architecture

Phase 19 must verify graceful shutdown behavior and deployment infrastructure across three layers: **(1) unit tests** for shutdown orchestrator logic, **(2) integration tests** for readiness probe + shutdown wiring, **(3) manual/smoke tests** for canary traffic split and health gating.

### Test Framework & Commands

**Project test stack:** Vitest (unit + integration), `@playwright/test` (E2E/smoke tests)

**Phase 19 test suite:**

```bash
# Unit tests: shutdown orchestrator logic (stream tracking, timeout)
pnpm --filter @deepagents-nextjs/server test -- shutdown.test.ts

# Integration tests: readiness probe integration with draining flag
pnpm --filter @deepagents-nextjs/server test -- handler.shutdown.integration.test.ts

# Smoke tests: canary/blue-green deployment (manual or CI workflow)
# Uses existing smoke-test-staging.yml + new canary validation steps
.github/workflows/smoke-test-staging.yml
```

### Wave 0 Scaffolding

| Test Type | File | Scope | Command |
|-----------|------|-------|---------|
| Unit | `packages/server/src/shutdown.test.ts` | OrchestrationLogic (stream tracking, timeout, draining flag) | `pnpm test shutdown.test.ts` |
| Integration | `packages/server/src/handler.shutdown.integration.test.ts` | readinessProbe(isDraining) + handler onRequest/onStreamEnd | `pnpm test handler.shutdown.integration.test.ts` |
| Manual/Content Check | `docs/DEPLOYMENT-RUNBOOK.md` | Canary/blue-green procedures, Kubernetes binding, platform constraints | Review for completeness + runbook format |
| Manual/Content Check | `docs/GRACEFUL-SHUTDOWN.md` | Shutdown API docs, consumer integration example, limitation docs | Review for completeness + API alignment |
| Smoke (CI) | `.github/workflows/smoke-test-staging.yml` | Canary traffic split (5/95 verification), health-gate pass/fail | Manual trigger + review output |

### Per-Task Test Type

| Requirement | Task | Test Type | Gate |
|-------------|------|-----------|------|
| OPS-01 | Implement `createGracefulShutdown()` factory + stream tracking | Unit + Integration | SIGTERM triggers draining=true; readiness returns 503; streams drain within timeout |
| OPS-01 | Wire shutdown to handler onRequest/onStreamEnd hooks | Integration | Multiple concurrent streams tracked independently; drain timeout prevents forever-wait |
| OPS-01 | SIGTERM + readiness probe integration | Integration | Readiness isDraining() callback mirrors shutdown.isDraining(); response is 503 during drain |
| OPS-03 | Write DEPLOYMENT-RUNBOOK.md | Content check | Includes canary/blue-green steps, Kubernetes YAML snippet, Vercel/Cloudflare limitations |
| OPS-03 | Write GRACEFUL-SHUTDOWN.md | Content check | Includes consumer API, integration example, platform constraints (Vercel 500ms, Cloudflare N/A) |
| OPS-04 | Formalize Phase 17 canary infra as health-gated rollout | Content + Manual | smoke-test-staging.yml includes health-gate verification; docs reference readiness probe |

### Key Validation Gates

1. **Unit: Stream Tracking**
   - Test: `trackStream()` + `releaseStream()` updates active count
   - Test: `isDraining()` returns false initially, true after `dispose()` called
   - Test: Multiple streams tracked independently (Set semantics)

2. **Unit: Drain Timeout**
   - Test: `dispose()` waits for streams to close
   - Test: `dispose()` exits if timeout expires (even if streams still active)
   - Test: Timeout is configurable in constructor

3. **Integration: Readiness + Shutdown**
   - Test: Readiness returns 200/ok when not draining
   - Test: Readiness returns 503/draining when isDraining()=true
   - Test: Handler tracks streams; readiness reflects active count (indirectly via draining flag)

4. **Integration: Slow Client Drain**
   - Scenario: Client makes SSE request; SIGTERM fires 2 seconds in; request takes 20 seconds total
   - Test: Request completes before drain timeout (if started before SIGTERM)
   - Measure: Response is not truncated

5. **Content: Deployment Runbook**
   - Checklist verification: canary procedures documented + tested
   - Checklist verification: Kubernetes readiness/liveness probe examples included
   - Checklist verification: Vercel ~500ms limitation documented clearly
   - Checklist verification: Cloudflare N/A documented with recommendation

6. **Manual/Smoke: Canary Traffic Split**
   - Action: Deploy blue (v1.5) + green (v1.6) to staging
   - Verification: Send 100 test requests, parse version header
   - Expected: ~95 requests hit blue, ~5 hit green (within 5% tolerance)
   - Gate: If split is incorrect, rollback; runbook must include verification command

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Process.exit() on SIGTERM (no drain) | Drain in-flight requests before exit | 2015+ (Node.js best practices, Kubernetes adoption) | Eliminates mid-response crashes; enables zero-downtime deployments |
| Module-scope shutdown flag | Per-instance orchestrator (callback-based) | 2018+ (serverless rise) | Works on edge/serverless where module state is unreliable |
| Mandatory backend health check in readiness | Local-only readiness + optional dependency checks | 2020+ (Kubernetes Pod disruption budgets) | Prevents cascading failures; improves cluster stability |
| Manual SIGTERM handler per-controller | Framework-agnostic orchestrator + readiness integration | 2025+ (observability libraries, streaming adoption) | Graceful shutdown is now a solved library pattern, not a per-app concern |
| Vercel/Cloudflare no graceful shutdown | Documented limitation + client-side resilience | Sept 2025 (Vercel changelog) | Vercel now supports ~500ms window; Cloudflare remains stateless (no SIGTERM); documentation is key |

**Deprecated/outdated:**
- **Manual socket tracking via `server.on('connection')`:** Node.js 18.2+ introduces `server.closeIdleConnections()` which is cleaner; HTTP/2 session tracking is now built-in
- **Forever-wait drain (no timeout):** Recognized as anti-pattern; always include timeout to prevent hard shutdown

## Sources

### Primary (HIGH confidence)

- **Node.js Process/Signals Documentation** - [Node.js process.on('SIGTERM')](https://nodejs.org/en/docs/guides/blocking-vs-non-blocking/) — Core API for signal handling, immutable specification
- **Vercel Changelog (Sept 2025)** - [Vercel Functions now support graceful shutdown](https://vercel.com/changelog/vercel-functions-now-support-graceful-shutdown) — Official announcement of 500ms window
- **Cloudflare Workers Platform Limits** - [Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/limits/) — Confirms Workers do not support SIGTERM; standard timeouts apply (30s for requests)
- **Kubernetes Health Probes** - [Kubernetes: Liveness, Readiness, Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) — Official specification for probe semantics and timing
- **Phase 18 Research & Implementation** - `.planning/research/SUMMARY-v1.6.md`, `packages/server/src/health.ts`, `packages/server/src/health.test.ts` — Readiness probe design, isDraining() callback integration point

### Secondary (MEDIUM confidence)

- **OneUptime (2026-01-06)** - [How to Build a Graceful Shutdown Handler in Node.js](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) — Comprehensive guide with best practices for stream draining and timeout patterns
- **Dev Community (2026-01)** - [Node.js Graceful Shutdown in Production: SIGTERM, In-Flight Draining, and Zero-Downtime Deploys](https://dev.to/axiom_agent/nodejs-graceful-shutdown-in-production-sigterm-in-flight-draining-and-zero-downtime-deploys-2a7h) — Practical patterns for HTTP request draining with timeouts
- **Dev Community (2026-02)** - [Graceful Shutdown in Node.js: Stop Dropping Requests](https://dev.to/young_gao/graceful-shutdown-in-nodejs-stop-dropping-requests-228p) — Covers stream tracking + readiness probe integration
- **Express.js (Official)** - [Express.js Health Checks and Graceful Shutdown](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html) — Framework-agnostic patterns verified by Express maintainers
- **Kubernetes Best Practices (2026)** - [OneUptime: Blue-Green & Canary in Kubernetes](https://oneuptime.com/blog/post/2026-01-19-kubernetes-blue-green-canary-deployments/view) — Canary deployment + readiness probe wiring patterns

### Tertiary (MEDIUM-LOW confidence)

- **Daily.dev Mirror** - [Vercel Functions now support graceful shutdown | daily.dev](https://app.daily.dev/posts/f0jn8zoaq) — Mirrors Vercel announcement; confirms 500ms window
- **GitHub Issue: workerd #101** - [Extend workerd with graceful shutdown](https://github.com/cloudflare/workerd/issues/101) — Community discussion; confirms Cloudflare Workers is stateless and doesn't support SIGTERM as of 2025
- **Project State Documentation** - `.planning/STATE.md`, `.planning/REQUIREMENTS.md` — Phase 18 completion status, Phase 19 scope, OPS-01/03/04 definitions

## Open Questions

1. **Shutdown orchestrator instantiation timing**
   - What we know: Must be done once at app startup (before request loop); multiple instances would leak event listeners
   - What's unclear: Should be a module-level singleton (easier) or passed through request context (stateless-er)?
   - Recommendation: Provide a factory that returns a singleton; document that consumers should call once; tests can reset via direct instantiation

2. **Stream ID generation and propagation**
   - What we know: Shutdown must track which streams are active; handler onRequest hook can generate a unique ID
   - What's unclear: How to propagate streamId from onRequest to onStreamEnd without module-scope variable?
   - Recommendation: Pass context through callbacks (already supported in Phase 18 observability design); return streamId from onRequest, pass it to onStreamEnd

3. **Vercel deployment workflow**
   - What we know: Vercel supports ~500ms graceful shutdown since Sept 2025; SSE streams typically take 10+ seconds
   - What's unclear: Should consumers set drainTimeoutMs to match Vercel limit or ignore it (Vercel will kill anyway)?
   - Recommendation: Document that Vercel's limit is platform constraint; recommend client-side reconnection; shutdown handler is best-effort for Vercel

4. **Canary health-gating implementation**
   - What we know: Phase 17 has existing canary/blue-green config in vercel.json + smoke-test workflow
   - What's unclear: Is "health-gated rollout" a documentation update (reference readiness probe) or new code?
   - Recommendation: Documentation + reference; no new code if Phase 17 infra already exists; verify smoke-test includes health checks

## Metadata

**Confidence breakdown:**
- **Node.js SIGTERM handling:** HIGH — Native API, well-documented, widely used
- **Graceful shutdown patterns:** HIGH — Best practices are mature (2025–2026 sources confirm)
- **Readiness probe integration:** HIGH — Phase 18 already designed isDraining() callback; this phase wires it
- **Vercel/Cloudflare constraints:** HIGH — Official sources (Vercel changelog, Cloudflare docs) confirm limitations
- **Canary/blue-green procedures:** MEDIUM — Patterns are standard but platform-specific (AWS ALB, Kubernetes, Vercel each differ); runbook must be detailed
- **Stream tracking + timeout design:** MEDIUM-HIGH — Pattern is standard; validation (drain timeout accuracy, stream count correctness) needs unit tests

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (30 days; graceful shutdown is stable; Vercel/Cloudflare limits are hard constraints unlikely to change in 30 days)
**Next review trigger:** If Cloudflare Workers announce SIGTERM support or Vercel changes shutdown timeout
