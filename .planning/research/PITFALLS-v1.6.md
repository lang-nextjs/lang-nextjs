# Domain Pitfalls: v1.6 Production Readiness & Observability

**Domain:** TypeScript npm monorepo — SSE proxy/transformer library with observability, health, and resilience controls for edge-compatible and serverless environments.

**Researched:** 2026-06-05 (v1.6 Observability & Production Readiness)

**Overall Confidence:** HIGH on edge runtime constraints; MEDIUM on stateless-transform integration; HIGH on callback safety in streaming contexts.

---

## Critical Pitfalls

### Pitfall 1: Timing API Availability Mismatch Across Edge Runtimes — Breaks Observability on Some Platforms

**What goes wrong:**

Observability hooks measure request duration using `performance.now()` or `Date.now()`. This works in Node.js and most edge runtimes. However:
- **Cloudflare Workers (pre-2025)**: No `performance.now()` without compatibility flags; `Date.now()` exists but microsecond precision is missing
- **Deno Deploy**: `performance.now()` exists but is affected by CPU time limits (50ms max per invocation for certain workloads); timing measurements become unreliable under load
- **Vercel Edge Functions**: `performance.now()` works (Node-like); safe

When observability hooks call unavailable timing APIs, they throw silently (caught by try-catch in probe) or return `undefined`, causing metrics to be empty/null. Observers can't measure latency; dashboards show missing data as zeros. Worse, if the hook doesn't guard the call, the stream crashes mid-response.

**Why it happens:**

- Edge runtimes expose different subsets of Web APIs
- Timing APIs were added to Cloudflare gradually (nodejs_compat flag, 2025-03-17 compatibility date onwards)
- Developers assume Node.js/browser API availability is universal
- Observability is vendor-neutral (callbacks), so timing implementation is consumer code — but the library should document this footgun clearly

**Consequences:**

- Metrics are incomplete on some platforms (Cloudflare without compatibility flags)
- If hook throws, stream aborts mid-response with no helpful error message
- Consumer wires observability to monitoring service; metrics are missing for certain platforms; dashboards show gaps
- Difficult to debug (works in dev/Node, breaks on production edge deployment)
- Trust damage if observability is a v1.6 feature promise

**Prevention:**

1. **In handler factory observability documentation:**
   - Document timing API requirements per platform
   - Recommend `try-catch` wrapper in callback patterns
   - Example callback template guards timing calls:
     ```typescript
     const onFrame = (event: FrameObservation) => {
       try {
         const startTime = typeof performance !== 'undefined' 
           ? performance.now() 
           : Date.now();
         // consumer sends metrics
       } catch (err) {
         // ignore timing errors; do not rethrow
       }
     }
     ```

2. **In @deepagents-nextjs/edge README:**
   - Document Cloudflare compatibility requirement: "nodejs_compat + compatibility_date >= 2025-03-17 required for performance.now()"
   - Document Deno Deploy note: "CPU time limit means timing measurements on long streams may not be accurate"

3. **Add test coverage:**
   - Unit test: callback that calls `performance.now()` in try-catch doesn't crash
   - E2E test on actual Cloudflare Worker (with compatibility flags) verifies timing metrics are captured

4. **Library export a utility helper (optional but kind):**
   ```typescript
   export function getSafeCurrentTime(): number {
     if (typeof performance !== 'undefined' && performance.now) {
       return performance.now();
     }
     return Date.now();
   }
   ```

**Detection:**

- Observability callback logs timing as `undefined` or `0` on Cloudflare Workers
- Metrics missing in monitoring dashboard for certain platforms
- Error logs show "performance is not defined" on some deployments

**Phase to address:** Phase 1 (Core handler observability) — Document and guard timing APIs before observability callbacks are exposed. Add helper utility if exporting timing utilities.

---

### Pitfall 2: Secrets and Tokens Leakage Through Observability Callbacks — Exfiltration via Telemetry

**What goes wrong:**

Observability hooks receive raw request/response objects or frame data:
```typescript
onFrame: (frame: SseFrame) => {
  // Consumer might log frame directly
  console.log(frame); // Oops: frame contains Authorization header, API key, auth token
}
```

If consumer or intermediate monitoring service doesn't filter, credentials flow into logs, traces, and metrics backends. Then:
- Credentials are stored in logging SaaS (Datadog, Papertrail, etc.) indefinitely
- AI or automated tools scrape logs, extract tokens, and compromise accounts
- Exfiltration is invisible (consumer assumes secrets are redacted)

**Why it happens:**

- Observability callbacks pass raw data for maximum flexibility (vendor-neutral design intent)
- Consumers don't realize what data is in the callback (Authorization headers, API keys nested in frame objects)
- Default-allow vs. default-deny: callbacks don't redact by default
- Monitoring services historically didn't redact credentials; this is changing in 2026 but adoption is uneven

**Consequences:**

- Leaked API credentials in telemetry backends
- Breach via credential theft from logs (Databahn reports credential theft is #1 AI-powered attack in 2026)
- Account compromise on backend API services
- Compliance violation if backend requires PII/credential redaction (HIPAA, SOC 2)
- Lateral movement into backend infrastructure

**Prevention:**

1. **In documentation (required):**
   - Add security section to observability docs: "Never log raw frame/request objects"
   - Example code showing what NOT to do:
     ```typescript
     // ❌ WRONG: Logs everything including Authorization header
     onFrame: (frame) => { console.log(frame); }
     
     // ✓ RIGHT: Extract only safe fields
     onFrame: (frame) => {
       logger.info('frame', {
         type: frame.type,
         size: frame.data?.length,
         // No Authorization, no raw data
       });
     }
     ```

2. **In handler observability schema (typed):**
   - Define `FrameObservation` to include only safe fields:
     ```typescript
     export interface FrameObservation {
       timestamp: number;
       frameType: string; // 'text-delta', 'tool-call', etc.
       byteLength: number;
       durationMs: number;
       // NO raw frame content
       // NO headers
       // NO Authorization
     }
     ```
   - Never include raw request/response bodies in callback payloads

3. **In @deepagents-nextjs/edge handler:**
   - If edge handler exposes request details in callback, strip headers:
     ```typescript
     const safeHeaders = new Headers();
     for (const [key, value] of request.headers) {
       if (!['authorization', 'x-api-key', 'cookie'].includes(key.toLowerCase())) {
         safeHeaders.append(key, value);
       }
     }
     ```

4. **Add explicit example:**
   - Provide a correct observability example in docs that shows safe callback patterns
   - Example should show: measure latency, count frames, omit raw data

5. **Test coverage:**
   - Unit test: verify FrameObservation type doesn't include raw objects
   - Test: if consumer mistakenly passes Authorization header to callback, header is not in observation

**Detection:**

- Security audit: check FrameObservation type for raw frame/request/response objects
- Log review: grep observability logs for "Authorization", "x-api-key", "Bearer" (should find none)
- Consumer reports leaked credentials in monitoring service

**Phase to address:** Phase 1 (Core observability hooks) — The callback schema must exclude raw sensitive data from the outset. This is a type-level guarantee, not a runtime check.

---

### Pitfall 3: Observability Callbacks Throwing Exceptions Crash the SSE Stream — Mid-Response Failure

**What goes wrong:**

Consumer wires an observability callback:
```typescript
createDeepAgentsHandler({
  onFrame: (frame) => {
    analytics.track({ event: 'frame', data: frame });
    // analytics.track() sometimes throws on network error
  }
})
```

If `onFrame` throws an unhandled exception, the exception propagates up the SSE transform pipeline. The stream crashes mid-response. Client receives a partial, corrupted SSE stream. The error is invisible to the user (stream just ends).

**Why it happens:**

- Observability callbacks are user-provided code (consumer implements them)
- Async operations in callbacks can reject (API calls to analytics services, database writes, etc.)
- Transform pipeline doesn't wrap callback invocations in try-catch
- SSE streams don't have an error recovery mechanism (mid-stream errors = unrecoverable)

**Consequences:**

- Stream crashes silently mid-response
- Client receives incomplete AI response (chat shows partial message)
- User thinks the app is broken; no helpful error message
- If callback is async and rejects, rejection might be unhandled (UnhandledPromiseRejectionWarning in logs)
- No visibility into what crashed the stream

**Prevention:**

1. **In handler, wrap all callback invocations in try-catch:**
   ```typescript
   for await (const chunk of upstream) {
     const frame = parseFrame(chunk);
     
     // Wrap callback invocations
     try {
       if (options.onFrame) {
         await options.onFrame(frame);
       }
     } catch (err) {
       // Log error but do NOT rethrow
       console.error('[observability] onFrame callback threw:', err);
       // Continue processing stream
     }
     
     // Transform and write frame
     const transformed = await transform(frame);
     if (transformed) {
       writer.write(transformed);
     }
   }
   ```

2. **In API docs, warn about callback safety:**
   - "Callbacks must not throw. Errors are logged but do not interrupt the stream."
   - Example shows proper error handling:
     ```typescript
     onFrame: (frame) => {
       try {
         metrics.increment('frames', { type: frame.type });
       } catch (err) {
         console.error('metrics error:', err);
         // Do not rethrow
       }
     }
     ```

3. **If callback returns a Promise, handle rejection:**
   ```typescript
   try {
     const result = options.onFrame(frame);
     if (result instanceof Promise) {
       result.catch((err) => {
         console.error('[observability] onFrame Promise rejected:', err);
       });
     }
   } catch (err) {
     console.error('[observability] onFrame threw:', err);
   }
   ```

4. **Test coverage:**
   - Unit test: callback that throws doesn't crash the stream
   - Unit test: callback that returns rejected Promise is caught
   - E2E test: stream completes even if callback errors on every frame

**Detection:**

- Error logs show "onFrame threw" or "onFrame Promise rejected"
- E2E test measures stream completion time; test fails if stream aborts early

**Phase to address:** Phase 1 (Core observability integration) — Callback wrapping must be built into the handler factory from day one. It's non-negotiable for SSE safety.

---

### Pitfall 4: Resilience State (Circuit Breaker, Rate Limiter) Stored at Module Scope — Breaks Isolation in Serverless/Edge

**What goes wrong:**

Handler factory maintains circuit breaker or rate limiter state at module scope:
```typescript
// ❌ WRONG
let circuitBreakerState = { failures: 0, lastFailure: null };
let rateLimitState = { tokens: 100, lastRefill: Date.now() };

export function createDeepAgentsHandler(options) {
  return async (req, res) => {
    // Check module-scope state
    if (circuitBreakerState.failures > 5) {
      return res.status(503);
    }
    // ...
  }
}
```

In serverless/edge:
- **Vercel Functions**: Multiple invocations can share the same module (within a warm container); state persists across requests but is unpredictable
- **Cloudflare Workers**: Each request may get a new isolate; module state is not guaranteed to persist; state leaks between concurrent requests on same worker
- **Deno Deploy**: Workers are stateless by design; persistent module state is lost between requests

Result: Circuit breaker state is inconsistent. Rate limit token bucket doesn't reset correctly. Different requests see different state. Under load, state becomes corrupt (double-counts, token overflow, etc.). Protection is ineffective or inconsistent.

**Why it happens:**

- The constraint (no module-scope state) is in PROJECT.md but easy to violate when implementing resilience
- Stateless design works for transforms `(frame)=>frame|null` but seems limiting for rate limiter (which needs to track token count)
- Developers think "I can use module scope, it's fast and simple"
- Serverless/edge isolation boundaries are unclear to developers accustomed to long-lived server processes

**Consequences:**

- Rate limiting is ineffective (requests are not actually limited)
- Circuit breaker doesn't trip when it should (backend hammered despite protection)
- State leaks between requests on Cloudflare Workers (one user's rate limit affects another's)
- Inconsistent behavior between local dev (state persists) and production (state lost)
- DDoS vulnerability: rate limiter doesn't work, server gets overwhelmed

**Prevention:**

1. **Enforce in code review: NO module-scope state.**
   - Ratelimiter must be passed as config, not stored in module closure
   - Circuit breaker state must be per-request or per-session, not global

2. **Resilience config pattern:**
   ```typescript
   export interface RateLimit {
     maxRequestsPerSecond: number;
     windowSize: number;
     // State is per-session or per-consumer, managed externally
   }
   
   export function createDeepAgentsHandler(options: {
     rateLimit?: RateLimit;
     // Rate limiter state managed by CONSUMER, not library
   }) {
     return async (req, res) => {
       // Don't check module state; let consumer manage it
       // Or pass a rate-limit-checker callback
       if (options.onRateCheck?.({ request: req })) {
         return res.status(429);
       }
     };
   }
   ```

3. **Alternative: Callback-based resilience.**
   Instead of library maintaining state, expose callbacks for consumer to implement:
   ```typescript
   onRequest: (req) => {
     // Consumer checks their own rate limit store (Redis, in-memory, etc.)
     if (rateLimitChecker.isLimited(req)) {
       throw new Error('Rate limited');
     }
   }
   ```

4. **Document clearly:**
   - "Resilience controls (rate limiting, circuit breaking) are configuration only. The library does not maintain state. Consumer is responsible for implementing stateful checks using their own backend (Redis, database, etc.) or per-request tracking."

5. **Test coverage:**
   - Unit test: no module-scope state exists (static analysis or manual review)
   - E2E test: multiple concurrent requests with rate limit config don't interfere with each other
   - E2E test: Cloudflare Worker simulates multiple isolates; requests in different isolates don't share state

**Detection:**

- Code review: grep for module-scope `let` / `const` holding rate-limit or circuit-breaker state
- Test failure: concurrent requests with rate limiting show inconsistent behavior
- Production logs show rate limiting doesn't work (requests exceed limit)

**Phase to address:** Phase 2 (Resilience controls) — This must be a design requirement before resilience is implemented, not retrofitted after. Add a linter rule if possible to catch module-scope state.

---

### Pitfall 5: Backpressure Not Applied to Upstream Fetch — Unbounded Memory Buffering on Slow Downstream

**What goes wrong:**

Handler receives a request and streams response from backend. If the client (downstream) is slow (bandwidth-limited, weak network), the handler keeps reading from backend (upstream) without waiting. Data accumulates in Node's internal buffers. Memory grows unbounded.

```typescript
// ❌ WRONG: Upstream read is not backpressured
const upstream = await fetch(backendUrl, { signal: request.signal });
const reader = upstream.body.getReader();

while (true) {
  const { value, done } = await reader.read(); // Reads ASAP, not waiting for downstream
  if (done) break;
  
  response.write(value); // If response buffer is full, write() returns false but we ignore it
}
```

Under load (1000 concurrent slow clients), memory explodes. Node OOMs. Vercel function crashes. Deno Deploy request times out (CPU budget exceeded).

**Why it happens:**

- Streaming APIs (ReadableStream, Node Readable) support backpressure, but it's opt-in
- `read()` always returns the next chunk; it doesn't wait for downstream readiness
- `write()` returning `false` means "buffer is full, pause upstream" — but if you ignore it, upstream keeps reading
- Easy to miss in simple streaming code

**Consequences:**

- Memory leak under load (slow client = upstream keeps buffering)
- Node.js process OOMs
- Vercel function crashes (memory limit exceeded)
- Deno Deploy request times out (CPU time exceeds limit due to memory pressure)
- Cascading failures: one slow client brings down the server

**Prevention:**

1. **Use `pipeline()` or `TransformStream` with proper backpressure handling:**
   ```typescript
   // ✓ CORRECT: pipeline() handles backpressure
   const { pipeline } = require('stream');
   
   pipeline(
     upstream.body,
     transformStream, // Respects downstream backpressure
     response,
     (err) => {
       if (err && err.code !== 'ERR_STREAM_DESTROYED') {
         console.error('pipeline error:', err);
       }
     }
   );
   ```

   Or in ReadableStream context (edge):
   ```typescript
   const reader = upstream.body.getReader();
   const writer = response.body.getWriter();
   
   while (true) {
     const { value, done } = await reader.read();
     if (done) break;
     await writer.ready; // WAIT for downstream readiness
     await writer.write(value);
   }
   ```

2. **If using manual read/write loop:**
   - Check if `write()` returns `false`; if so, pause upstream reading until `drain` event
   - Or use `backpressure()` helper to convert backpressure signals

3. **Test coverage:**
   - Backpressure test: slow downstream (MockWritable with 100-byte buffer), fast upstream; verify memory stays bounded
   - Measure memory growth under slow-client load; must stay flat

4. **Documentation:**
   - "Handler uses `pipeline()` for automatic backpressure handling. Do not use `getReader()` / `read()` loops without checking backpressure signals."

**Detection:**

- Memory growth during load test with slow clients
- E2E test shows memory grows to >100MB under 1000 slow concurrent clients (should stay <10MB)
- Vercel function crashes with "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed"

**Phase to address:** Phase 1 (Core handler) — Backpressure handling is part of streaming safety. Must be correct from day one.

---

### Pitfall 6: AbortSignal / Timeout Not Actually Cancelling Upstream Fetch — File Descriptor and Stream Leaks

**What goes wrong:**

Handler passes `signal: request.signal` to upstream fetch to abort when client disconnects:
```typescript
const upstream = await fetch(backendUrl, { signal: request.signal });
```

However, simply passing the signal is not enough:
- Signal aborts the fetch, but the socket/stream is not fully cleaned up
- Timers set inside upstream request (heartbeat, keep-alive) are not cleared
- If backend handler creates child processes or opens file descriptors, they are not closed
- Even if main stream ends, underlying resources leak

Result: File descriptor count grows under load. lsof shows thousands of CLOSE_WAIT sockets. Eventually ulimit is hit and new connections fail.

**Why it happens:**

- AbortSignal cancels the fetch but doesn't guarantee full cleanup of all resources
- Transform stream operators may create resources (timers, file handles) that outlive the stream
- Multiple teardown paths (abort, error, close, finish) can race
- Consumers don't realize abort-safe != cleanup-safe

**Consequences:**

- File descriptor leak under load
- Socket leak (CLOSE_WAIT connections accumulate)
- Eventually ulimit exhaustion; new connections refused
- Server becomes unresponsive even after load decreases (FDs don't get released)
- Requires process restart to clear FD table

**Prevention:**

1. **Ensure comprehensive cleanup on abort:**
   ```typescript
   const controller = new AbortController();
   
   request.signal.addEventListener('abort', () => {
     // Abort upstream fetch
     controller.abort();
     
     // Also clean up any associated resources
     clearInterval(heartbeatTimer);
     if (backendConnection) {
       backendConnection.destroy(); // Force close socket
     }
   });
   
   try {
     const upstream = await fetch(backendUrl, { signal: controller.signal });
   } catch (err) {
     if (err.name === 'AbortError') {
       // Clean up successfully
     }
   }
   ```

2. **Use `stream.pipeline()` with explicit cleanup:**
   - `pipeline()` with error handling destroys all streams on failure
   - Combine with AbortSignal:
     ```typescript
     const { pipeline } = require('stream');
     
     pipeline(
       upstream.body,
       transformStream,
       response,
       (err) => {
         if (err && err.code !== 'ERR_STREAM_DESTROYED') {
           console.error('pipeline failed:', err);
         }
         // Pipeline cleanup is automatic
       }
     );
     ```

3. **Test resource cleanup under abort:**
   - Unit test: abort signal triggers, verify all timers are cleared (use `fake timers` from Sinon)
   - E2E test: abort 1000 requests mid-stream, measure FD count; must return to baseline
   - Use `lsof -p $pid` to inspect FD count before/after test

4. **Document abort safety:**
   - "Handler passes request.signal to fetch() for automatic abort on disconnect. Consumer transforms should not create background timers or resources without cleanup."

**Detection:**

- `lsof -p <pid>` shows thousands of CLOSE_WAIT sockets
- Load test with 1000 aborted requests; FD count doesn't decrease after requests finish
- strace shows file descriptors are not being closed

**Phase to address:** Phase 1 (Core handler) — AbortSignal handling is mandatory. Phase 2 (Resilience) must verify transforms don't leak resources.

---

### Pitfall 7: Readiness Probes Performing Expensive Dependency Checks — Cascading Failures Under Load

**What goes wrong:**

Readiness probe checks if handler can reach the backend:
```typescript
export async function readinessProbe() {
  const healthUrl = `${backendUrl}/health`;
  const response = await fetch(healthUrl, { timeout: 5000 });
  if (!response.ok) {
    throw new Error('Backend unhealthy');
  }
  return { status: 'ready' };
}
```

Under load:
- Load balancer calls readiness probe every 10 seconds for 100 instances
- Each probe makes an HTTP request to backend
- Backend is already under load serving real requests
- Probe requests queue behind real requests
- Probe times out
- Load balancer marks instances as unready
- Load balancer removes instances from pool
- Remaining instances get more traffic
- Cascading failure: each instance's readiness probe times out, more instances removed, until entire fleet is down

**Why it happens:**

- Readiness probes are synchronous, shared thread pool with main request handler
- If app is overloaded, health checks queue and timeout
- Expensive checks (database, external API) on hot path amplify the problem
- Kubernetes/load-balancer defaults (e.g., 3 failed probes = remove from pool) are aggressive

**Consequences:**

- Cascading failure during traffic spike
- All instances marked unready due to probe timeouts
- Service becomes unavailable even though instances are functional
- Recovery requires manual intervention (restart)

**Prevention:**

1. **Readiness probes must be fast and local:**
   - ❌ DON'T: Check external dependencies (backend, database)
   - ✓ DO: Check local state only
   ```typescript
   export async function readinessProbe() {
     // Only check if this handler is initialized
     if (!handlerInitialized) {
       throw new Error('Handler not ready');
     }
     // If backend is unreachable, that's a liveness issue, not readiness
     return { status: 'ready' };
   }
   ```

2. **Separate liveness from readiness:**
   - **Readiness**: "Can this instance serve requests?" — fast, local check only
   - **Liveness**: "Is this process alive?" — just check process state, not dependencies
   ```typescript
   export function livenessProbe() {
     return { status: 'alive' }; // Always returns unless process is dead
   }
   ```

3. **If you must check backend connectivity:**
   - Use a fast, non-blocking check (ping, TCP connect timeout 100ms)
   - Cache result with short TTL (30s)
   ```typescript
   let cachedBackendHealthy = false;
   let lastHealthCheck = 0;
   
   export async function isBackendHealthy() {
     const now = Date.now();
     if (now - lastHealthCheck < 30_000) {
       return cachedBackendHealthy;
     }
     
     try {
       // Fast TCP connect check, not full HTTP request
       const response = await fetch(`${backendUrl}/health`, {
         timeout: 100, // Very fast timeout
       });
       cachedBackendHealthy = response.ok;
     } catch {
       cachedBackendHealthy = false;
     }
     lastHealthCheck = now;
     return cachedBackendHealthy;
   }
   ```

4. **Document clearly:**
   - "Readiness probes provided by the library are local-only. Consumer applications must not extend readiness probes to check external dependencies (backend, database, cache). Use liveness probes for dependency checks, with separate alerting configured."

5. **Test coverage:**
   - Unit test: readiness probe completes in < 10ms
   - Load test: 1000 concurrent requests, readiness probe completes in < 10ms during spike
   - Integration test: if backend is unreachable, readiness probe still returns 'ready' (because it doesn't check backend)

**Detection:**

- Readiness probe latency > 100ms under load
- E2E test logs show readiness probe timeout during load test
- Production metrics show readiness probe latency spikes during traffic spikes

**Phase to address:** Phase 2 (Health probes) — Health probe design is critical before they're exported. Include probe performance requirements in spec.

---

### Pitfall 8: Graceful Shutdown Impossible in Vercel Serverless — Request Termination During Shutdown Causes Data Loss

**What goes wrong:**

Handler tries to implement graceful shutdown:
```typescript
// In Next.js route handler
let pendingRequests = 0;

if (typeof process !== 'undefined') {
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, graceful shutdown...');
    // Wait for pending requests
    while (pendingRequests > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
}
```

However:
- **Vercel Functions** has a 500ms graceful shutdown window (announced Sept 2025)
- **Cloudflare Workers** don't support SIGTERM at all; runtime is terminated immediately
- **Deno Deploy** supports SIGTERM but 10s timeout before kill
- If a request is in-flight when SIGTERM fires, Vercel terminates the process after 500ms regardless

Result: Request is mid-stream when process dies. Client receives incomplete SSE response. Backend operation is half-done (if backend is stateful). Data loss or corruption.

**Why it happens:**

- Developers assume serverless behaves like traditional servers (SIGTERM = graceful shutdown window)
- Vercel's 500ms window is actually very short for streaming scenarios (where a single response can take 10+ seconds)
- Cloudflare Workers don't support graceful shutdown at all
- Developer assumes if they code shutdown, it will work

**Consequences:**

- In-flight streaming requests are killed mid-response
- Client chat gets incomplete AI response
- Backend operation is left in inconsistent state
- Data loss if response was supposed to write to database
- No way to retry (client already received partial response)

**Prevention:**

1. **Document the limitation clearly:**
   - "Vercel Functions supports graceful shutdown with 500ms timeout. Streaming responses that exceed this duration will be terminated. SSE streams longer than 500ms cannot guarantee graceful completion."
   - "Graceful shutdown is not supported on Cloudflare Workers. Assume immediate termination."

2. **For Vercel, implement best-effort cleanup (not guaranteed):**
   ```typescript
   // Optional: attempt cleanup on SIGTERM, but don't rely on it
   if (typeof process !== 'undefined') {
     process.on('SIGTERM', () => {
       console.log('Vercel shutdown signal received (500ms timeout)');
       // Close any open resources, but response is already sent
     });
   }
   ```

3. **Architecture recommendation:**
   - If streaming is long-running, don't rely on handler to persist state
   - Offload persistence to separate worker/service that's not being shut down
   - Example: SSE response handler sends progress to Redis; consumer reads from Redis

4. **Test coverage:**
   - Simulation test: kill process 100ms into response; verify client receives partial response and can interpret error correctly
   - Don't test graceful shutdown on Vercel directly (can't manually send SIGTERM); document as limitation

5. **Consumer documentation:**
   - "For long-running streams (>500ms), consumer should implement client-side reconnection and resume logic. Graceful shutdown is not guaranteed."

**Detection:**

- In production logs, responses are cut off at exactly 500ms on Vercel
- E2E test simulates early process death; verifies client can handle truncated response

**Phase to address:** Phase 3 (Deploy infrastructure) — Graceful shutdown limitation must be documented before deploy runbooks are written. This is a hard constraint, not a nice-to-have.

---

### Pitfall 9: Health Endpoints Leaking Internal Information — Security Information Disclosure

**What goes wrong:**

Health endpoint returns too much detail:
```typescript
export async function healthEndpoint() {
  return {
    status: 'healthy',
    version: packageJson.version,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    backendUrl: process.env.BACKEND_URL, // Oops!
    dependencies: {
      node: process.version,
      next: require('next/package.json').version,
    }
  };
}
```

Attacker or competitor:
- Reads endpoint, discovers backend URL
- Discovers version numbers; looks up public CVEs
- Discovers internal architecture; plans attack accordingly

**Why it happens:**

- Developers think health endpoint is internal-only
- Health endpoints are exposed at `/health` (common path); not authenticated
- Rich telemetry is useful for debugging, so developers add lots of detail

**Consequences:**

- Information disclosure vulnerability
- Attacker discovers backend URL, version numbers, internal structure
- Enables targeted attacks (version-specific RCE, etc.)
- Compliance violation if endpoint is public and exposes internal info

**Prevention:**

1. **Health endpoint must be minimal and safe:**
   ```typescript
   export async function healthEndpoint() {
     // ONLY status, nothing else
     return { status: 'healthy' };
   }
   ```

2. **Separate health (public) from debugging (authenticated):**
   ```typescript
   // Public endpoint: minimal
   app.get('/health', (req, res) => {
     res.json({ status: 'healthy' });
   });
   
   // Authenticated debugging endpoint: detailed
   app.get('/admin/debug/health', authenticate, (req, res) => {
     res.json({
       version: packageJson.version,
       uptime: process.uptime(),
       memoryUsage: process.memoryUsage(),
       // etc.
     });
   });
   ```

3. **If health endpoint must include structured data:**
   - Include only: `{ status: 'healthy' | 'degraded' | 'unhealthy' }`
   - Optional: millisecond timestamp (not internal details)

4. **Document security requirement:**
   - "Health endpoints must not expose version, environment variables, dependency versions, or internal architecture details."

5. **Test coverage:**
   - Security test: health endpoint returns only `{ status: '...' }`, no other fields
   - Test: health endpoint doesn't include any environment variables
   - Test: health endpoint doesn't include version strings or package details

**Detection:**

- Security audit: health endpoint contains sensitive fields
- Automated check: health response contains "version", "BACKEND_URL", "node", "aws", "docker", etc.

**Phase to address:** Phase 2 (Health probes) — Health endpoint spec must include security requirements before implementation.

---

### Pitfall 10: Canary/Blue-Green Deployment Misconfiguration — Traffic Still Routed to Old Version

**What goes wrong:**

Canary deployment setup:
- Blue (v1.5): 95% traffic
- Green (v1.6): 5% traffic, new observability features

Load balancer config is wrong:
```hcl
# ❌ WRONG: Both backends get 50% traffic, not 5/95 split
listener_rule {
  host_header = "api.example.com"
  actions = [
    { target_group = blue_tg },
    { target_group = green_tg }
  ]
}
```

Result: v1.6 gets 50% traffic, not 5%. New code crashes or is exposed to real users prematurely. Rollback required.

Or: DNS points to wrong IP, routing rules are not applied, etc.

**Why it happens:**

- Load balancer config is complex (ALB rules, target groups, weights)
- Different platforms have different syntax (AWS ALB, Kubernetes Ingress, Vercel, etc.)
- Mistake in rule ordering or weight calculation
- Config is not tested before deployment
- Person who wrote config doesn't fully understand platform

**Consequences:**

- New version gets more traffic than intended
- Buggy code is exposed to more users than safe limit
- Rapid escalation of failures
- Panic rollback

**Prevention:**

1. **Test canary/blue-green config BEFORE deploying to prod:**
   - Staging environment: deploy blue-green, verify traffic split with load test
   - Send 100 requests, verify ~5 hit green (95 hit blue)
   - Monitor error rates for each version separately

2. **Clear deployment runbook with verification:**
   ```
   Canary Deployment Checklist:
   [ ] Blue (v1.5) deployed and healthy
   [ ] Green (v1.6) deployed and healthy
   [ ] Load balancer rule created: 95% → blue, 5% → green
   [ ] Send 100 test requests to endpoint; capture version header
   [ ] Verify ~95 requests got v1.5, ~5 got v1.6
   [ ] Monitor v1.6 error rate for 10 minutes
   [ ] If error rate < 0.1%, increase to 50/50
   [ ] If error rate > 1%, rollback to 100% blue
   ```

3. **Automated verification (ideal):**
   ```bash
   # Send 100 requests, parse version header, verify split
   for i in {1..100}; do
     curl -i https://api.example.com | grep "x-app-version"
   done | sort | uniq -c
   # Expected: ~95 v1.5, ~5 v1.6
   ```

4. **Documentation:**
   - Include canary/blue-green setup instructions in deploy runbook
   - Include platform-specific verification commands (AWS ALB, Kubernetes, Vercel)
   - Include rollback procedure

5. **Test coverage:**
   - Integration test: deploy blue+green to staging, verify traffic split
   - Load test: 1000 requests, measure distribution

**Detection:**

- E2E test verifies traffic split before scaling up
- Production monitoring: track requests per version, alert if split is unexpected
- Manual verification: curl endpoint 100 times, check version distribution

**Phase to address:** Phase 3 (Deploy infrastructure & runbooks) — Canary/blue-green procedures must be tested and documented. Include verification as mandatory step.

---

## Moderate Pitfalls

### Pitfall 11: Stateless Transform + Per-Request Observability State — Hidden Coupling

**What goes wrong:**

Handler maintains observability state per-request:
```typescript
const requestObservation = {
  frameCount: 0,
  byteCount: 0,
  startTime: Date.now(),
};

const transforms = [
  (frame) => {
    requestObservation.frameCount++;
    requestObservation.byteCount += frame.length;
    return frame;
  }
];
```

This looks stateless (no module scope), but there's hidden coupling:
- Transform closure captures `requestObservation`
- If transform is reused across requests, state is shared
- Concurrent requests see each other's state
- Transform is no longer independently testable

**Why it happens:**

- Developers think "stateless = no module scope"
- Per-request closures seem fine, but they couple the transform to request lifecycle
- Observability bookkeeping feels like it needs state

**Consequences:**

- Tests of transform in isolation fail (missing captured state)
- Transform is tightly coupled to request handler
- Transforms can't be pre-built and reused
- Concurrent requests interfere with each other's observations

**Prevention:**

1. **Separate transform logic from observability tracking:**
   ```typescript
   // ✓ Transform is pure, no state
   const sseTransform = (frame) => {
     // ... transform logic, no observation
     return frame;
   };
   
   // Observation is callback-based, not state
   const handleFrame = (frame) => {
     frameCount++;
     byteCount += frame.length;
     if (options.onFrame) {
       options.onFrame({ frameCount, byteCount });
     }
   };
   ```

2. **Document: Transforms should not capture external state:**
   - "Transforms must be pure functions (same input = same output). Do not capture request-local variables or observability state inside transform closures."

3. **Test coverage:**
   - Unit test: transform can be instantiated once and applied to multiple frames without side effects

**Detection:**

- Code review: transforms should not reference variables outside their parameter list
- Test: transform can be called with same input twice and produces identical output

**Phase to address:** Phase 1 (Core handler + transforms) — Make this a design requirement. Document in transform type definition.

---

### Pitfall 12: Observability Metrics Not Accounting for Backpressure/Buffering — False Performance Signal

**What goes wrong:**

Observability callback measures request-to-response time:
```typescript
onRequest: ({ timestamp: Date.now(), ... }),
onStreamEnd: ({ duration: Date.now() - requestTime, ... })
```

But if the stream is buffered for 10 seconds (due to backpressure, slow client), metrics show:
- Duration: 10,000 ms (most of which is client-side buffering)
- Throughput: low

Dashboard shows "requests taking 10s" and triggers alert, but actual server processing is fast. Alert is false positive.

**Why it happens:**

- Observability doesn't distinguish between server-side latency and client-side buffering
- Backpressure delays frame transmission but metrics count full response duration
- Easy to confuse "time spent in handler" with "time before client receives response"

**Consequences:**

- False positive alerts on latency
- Developers optimize the wrong thing (client latency, not server latency)
- Trust in observability decreases

**Prevention:**

1. **Measure multiple time points:**
   ```typescript
   onRequest: {
     timestamp,
     requestTime: Date.now(),
   },
   onFrame: {
     frameTime: Date.now(),
     frameIndex,
   },
   onStreamEnd: {
     endTime: Date.now(),
     totalFrames,
     totalBytes,
   }
   ```

2. **Let consumer calculate derived metrics:**
   - Time-to-first-frame (request → first frame)
   - Frame arrival interval (time between frames)
   - Total stream duration
   - Consumer can distinguish server latency from buffering

3. **Document metric semantics:**
   - "Frame timestamps are when handler processed the frame, not when client received it. Consumer should correlate timestamps to detect buffering."

**Detection:**

- Unit test: frame timestamps are ordered correctly
- E2E test: measure time-to-first-frame on slow client; verify it's reasonable (not 10+ seconds)

**Phase to address:** Phase 2 (Observability design) — Metric design must be clear about what is being measured before observers are wired up.

---

## Minor Pitfalls

### Pitfall 13: Edge Runtime Module-Scope Initialization Costs — Cloudflare Worker Cold Start

**What goes wrong:**

Handler factory does heavy lifting at module scope to reuse:
```typescript
// At module scope
const schemaValidator = new ZodValidator({ ... }); // Slow
const regexPatterns = compileAllRegexes(); // Expensive
const cachedData = loadInitialData(); // I/O

export function createDeepAgentsHandler(options) {
  return async (req, res) => {
    // Use schemaValidator, regexPatterns, cachedData
  }
}
```

On Cloudflare Workers:
- First request: module is loaded, all module-scope code runs
- Duration: 100+ ms for initialization, then slow first request
- Subsequent requests reuse the module (faster)
- Each deploy: fresh cold start

For streaming scenarios, 100ms cold start is noticeable (time-to-first-byte increases).

**Why it happens:**

- Developers assume module-scope initialization is cheap
- Want to reuse expensive objects (parsers, caches)
- Not aware of cold-start impact on edge

**Consequences:**

- Slow cold start on edge deployments
- Time-to-first-byte increases significantly
- Users notice delay before first token

**Prevention:**

1. **Lazy initialization:**
   ```typescript
   let schemaValidator;
   
   function getValidator() {
     if (!schemaValidator) {
       schemaValidator = new ZodValidator({ ... });
     }
     return schemaValidator;
   }
   ```

2. **Or use factory pattern (move to handler factory):**
   ```typescript
   export function createDeepAgentsHandler(options) {
     const schemaValidator = new ZodValidator({ ... }); // Initialize per-handler
     
     return async (req, res) => {
       const result = schemaValidator.validate(...);
     }
   }
   ```

3. **Document:**
   - "Avoid heavy initialization at module scope in edge handlers. Use lazy initialization or factory patterns."

**Detection:**

- Measure cold-start time; should be < 50ms
- Monitor time-to-first-byte on edge deployments

**Phase to address:** Phase 2 (@deepagents-nextjs/edge handler) — Edge handler design should minimize module-scope work.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation | Severity |
|-------------|---------------|------------|----------|
| Observability hooks | Timing API missing on some edge runtimes | Document timing API requirements per platform; provide safe timing helper | HIGH |
| Observability hooks | Secrets leakage through callbacks | Define FrameObservation type without raw data; document secret filtering | CRITICAL |
| Observability hooks | Callback throws, crashes stream | Wrap all callback invocations in try-catch | CRITICAL |
| Resilience controls | Module-scope state breaks serverless/edge isolation | Design: no module-scope state; resilience config only; consumer manages state | CRITICAL |
| Resilience controls | Backpressure not handled, unbounded buffering | Use `pipeline()` with proper backpressure handling | CRITICAL |
| Resilience controls | AbortSignal doesn't clean up resources | Comprehensive cleanup on abort; test with lsof | CRITICAL |
| Health probes | Expensive dependency checks cause cascading failure | Readiness probes local-only; cache external checks | CRITICAL |
| Health probes | Health endpoint leaks internal info | Minimal health response: `{ status: ... }` only | HIGH |
| Deploy infrastructure | Graceful shutdown not possible on Vercel | Document 500ms limitation; don't rely on graceful shutdown for streaming | HIGH |
| Deploy infrastructure | Canary/blue-green misconfiguration | Test traffic split in staging; include verification in runbook | MEDIUM |
| Observability design | Metrics don't distinguish server vs. client latency | Measure multiple time points; document metric semantics | MEDIUM |
| Transforms | Hidden state coupling in per-request closures | Keep transforms pure; separate observation from transformation | MEDIUM |
| Edge handler | Cold start from module-scope initialization | Lazy initialization; move heavy work to handler factory | MEDIUM |

---

## Confidence Assessment

| Area | Confidence | Notes |
|-------|------------|-------|
| Timing API availability edge runtimes | HIGH | Cloudflare docs confirm compatibility flags required; Deno Deploy CPU limits documented; Vercel Edge supports performance.now() |
| Secrets leakage through telemetry | HIGH | AquilaX, Databahn 2026 reports confirm credential theft is #1 AI attack; OpenTelemetry redaction processor widely documented |
| Callback safety in streaming | HIGH | Hono issue #2164, NestJS issue #12670, Next.js discussion #61972 confirm SSE exception crashes are real and documented |
| Module-scope state in serverless | HIGH | Vercel Functions, Cloudflare Workers, Deno Deploy isolation well-documented; state persistence is unpredictable |
| Backpressure in streaming | HIGH | Node.js backpressure docs definitive; 2026 articles confirm unbounded buffering is persistent risk; pipeline() solution well-established |
| AbortSignal resource cleanup | HIGH | Medium article 2026 confirms FD/socket leaks are real; lsof verification method proven |
| Health probe cascading failures | HIGH | Kubernetes docs and 2026 guides confirm probe-induced cascading failures are known pattern |
| Health endpoint information disclosure | MEDIUM | API security best practices well-documented; but specific to SSE proxy lib, not yet tested |
| Graceful shutdown on Vercel | HIGH | Vercel changelog Sept 2025 confirms 500ms timeout; Cloudflare Workers don't support SIGTERM |
| Canary/blue-green config mistakes | MEDIUM | Pattern well-documented in Terraform/Kubernetes guides; but specific misconfiguration risks vary by platform |

---

## Gaps to Address in Phase-Specific Research

1. **Cloudflare Workers timing API post-2025-03-17**: Verify if `performance.now()` is fully reliable on current compatibility date; test microsecond precision.
2. **Deno Deploy CPU time limits for streaming**: Test multi-message stream to verify 50ms per message assumption holds for realistic frame sizes.
3. **Vercel Functions graceful shutdown 500ms window**: Confirm if this applies to serverless functions and streaming responses; test actual behavior.
4. **Edge handler cold-start benchmarks**: Measure actual cold-start time for @deepagents-nextjs/edge handlers on Cloudflare and Deno.
5. **Health probe performance under load**: Load test health probes to verify they complete < 10ms under 1000 concurrent requests.
6. **Canary deployment traffic distribution verification**: Test AWS ALB canary setup to verify weight distribution is accurate.

---

## Sources

**Timing APIs & Edge Runtimes:**
- [Cloudflare Workers: Performance and timers docs](https://developers.cloudflare.com/workers/runtime-apis/performance/)
- [Cloudflare Workers: Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Cloudflare Changelog: nodejs_compat 2025-03-17](https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/)
- [Deno: Web Streams at the Edge](https://deno.com/blog/deploy-streams)
- [Deno Deploy: Edge runtime limitations](https://docs.deno.com/deploy/classic/edge_cache/)

**Observability & Secrets:**
- [AquilaX: OpenTelemetry Security — Secrets Leakage](https://aquilax.ai/blog/opentelemetry-security-data-leakage)
- [Databahn: AI-powered breaches — Telemetry attack surface](https://www.databahn.ai/blog/ai-powered-breaches-ai-is-turning-telemetry-into-an-attack-surface)
- [Dash0: OpenTelemetry Redaction Processor](https://www.dash0.com/guides/opentelemetry-redaction-processor)
- [OneUptime: UnhandledPromiseRejectionWarning fix](https://oneuptime.com/blog/post/2026-01-25-fix-unhandled-promise-rejection-warning-in-nodejs/view)

**Streaming & Backpressure:**
- [Node.js v24: Backpressuring in Streams](https://nodejs.org/learn/modules/backpressuring-in-streams)
- [OneUptime: Node.js Streams Effectiveness](https://oneuptime.com/blog/post/2026-02-03-nodejs-streams/view)
- [Dev To: Managing Back-Pressure in Streams](https://dev.to/codexstoney/handling-backpressure-in-nodejs-streams-2dck)
- [Medium 2026: Backpressure in JavaScript](https://blog.gaborkoos.com/posts/2026-01-06-Backpressure-in-JavaScript-the-Hidden-Force-Behind-Streams-Fetch-and-Async-Code/)

**Abort & Resource Cleanup:**
- [Medium 2026: Node Stream Aborts Hide Leaks](https://medium.com/@connect.hashblock/node-stream-aborts-hide-the-worst-leaks-835089cfe4ba)
- [Medium: AbortController Beyond Fetch](https://www.jamdesk.com/blog/abortcontroller-javascript-guide)
- [Medium 2026: 8 Node Stream Timeout Policies](https://medium.com/@Modexa/8-node-stream-timeout-policies-to-stop-hung-p99s-5a8f0c705fcd)
- [Medium 2026: Node fetch timeouts — 10 gaps](https://medium.com/@Modexa/node-fetch-timeouts-10-gaps-that-still-hang-3396fd7bed7a)
- [MDN: AbortSignal — Web APIs](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

**Health Checks & Probes:**
- [Kubernetes: Liveness, Readiness, Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Dev To 2026: Kubernetes Health Probes Done Right](https://dev.to/young_gao/kubernetes-health-probes-done-right-liveness-readiness-and-startup-5g7g)
- [OneUptime 2026: Health Check Design](https://oneuptime.com/blog/post/2026-01-30-health-check-design/view)
- [OneUptime 2026: Liveness Probes Avoid False Positives](https://oneuptime.com/blog/post/2026-02-09-liveness-probes-avoid-false-positives/view)
- [microservices.io: Health Check API Pattern](https://microservices.io/patterns/observability/health-check-api.html)
- [NetFoundry: Health Checks Best Practices](https://netfoundry.io/docs/frontdoor/learn/health-checks/health-checks-best-practices/)
- [API7.ai: API Health Check Best Practices](https://api7.ai/blog/tips-for-health-check-best-practices)

**Graceful Shutdown:**
- [Vercel: Graceful shutdown now supported](https://vercel.com/changelog/vercel-functions-now-support-graceful-shutdown)
- [daily.dev: Vercel Functions graceful shutdown](https://app.daily.dev/posts/f0jn8zoaq)
- [OneUptime 2026: Graceful Shutdown in Lambda](https://oneuptime.com/blog/post/2026-02-12-implement-graceful-shutdown-in-lambda-functions/view)
- [Google Cloud: Graceful shutdowns on Cloud Run](https://cloud.google.com/blog/topics/developers-practitioners/graceful-shutdowns-cloud-run-deep-dive)

**Canary & Blue-Green Deployments:**
- [HashiCorp: Blue-green & Canary with AWS ALB](https://developer.hashicorp.com/terraform/tutorials/aws/blue-green-canary-tests-deployments)
- [Octopus Deploy: Blue/Green vs Canary](https://octopus.com/devops/software-deployments/blue-green-vs-canary-deployments/)
- [OneUptime 2026: Blue-Green & Canary in Kubernetes](https://oneuptime.com/blog/post/2026-01-19-kubernetes-blue-green-canary-deployments/view)
- [OneUptime 2026: Blue-Green & Canary strategies](https://oneuptime.com/blog/post/2026-02-20-blue-green-canary-deployments/view)
- [CNCF: Load balancing for blue-green, rolling, canary](https://www.cncf.io/blog/2022/05/09/load-balancing-for-blue-green-rolling-and-canary-deployment/)

**SSE & Callbacks:**
- [Hono: Issue #2164 — Throwing exception in streamSSE crashes server](https://github.com/honojs/hono/issues/2164)
- [NestJS: Issue #12670 — SSE improvements](https://github.com/nestjs/nest/issues/12670)
- [Next.js: Discussion #61972 — unhandledRejection with SSE](https://github.com/vercel/next.js/discussions/61972)
- [OneUptime 2026: Implement Server-Sent Events in React](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view)

---

*Pitfalls research for: deepagents-nextjs v1.6 Production Readiness & Observability*
*Researched: 2026-06-05*
*Focus: Edge runtime, serverless isolation, stateless-transform constraints, streaming safety, and observability callback risks*
