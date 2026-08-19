# Phase 20: Launch — Research

**Researched:** 2026-06-06  
**Domain:** Error-reporting integration documentation, end-to-end validation, v1.6.0 release  
**Confidence:** HIGH (foundational layers built in phases 18–19; phase 20 is docs + E2E + release)

## Summary

Phase 20 ships v1.6 to production by completing two critical tasks: **(1) documenting how consumers wire error-reporting via the `onError` hook** with concrete Sentry and Datadog examples (no vendor SDK bundled), and **(2) validating the three production flows end-to-end** via Playwright E2E tests: observability events reaching a sink, resilience trips producing correct fallbacks, and SIGTERM-driven graceful shutdown draining in-flight streams. The release involves creating changesets documenting the additive observability/resilience/shutdown options as non-breaking.

**Key findings:**
- **OPS-02 (error-reporting docs):** Sentry and Datadog both support custom callback instrumentation via their SDKs (`@sentry/node`, `@datadog/browser-rum`). The pattern is simple: consumer instantiates the vendor SDK in their own code, then wires `onError` callback to send events. Phase 20 provides type-safe examples showing hook → context mapping.
- **OPS-05 (E2E flows):** The three flows test different subsystems: (a) observability → APM sink (Sentry/Datadog instrumented via onError), (b) resilience → fallback response (429 rate-limit, 503 breaker), (c) SIGTERM → drain (Node-only integration test or Playwright test against spawned server). Existing Playwright harness supports page.route() mocking; E2E can use mock backends (no live backend required).
- **v1.6.0 release:** Version bump from 0.1.0 → 1.6.0 with changesets documenting observability/resilience/shutdown config options as additive. Existing API surface unchanged.
- **SIGTERM E2E approach:** The graceful shutdown test requires a Node server (SIGTERM is Node-only). Recommend a hybrid: browser Playwright tests for (a) and (b) with mock backends; a separate Node integration test for (c) that spawns the handler server, sends requests, and validates drain behavior with fake timers.

**Primary recommendation:** OPS-02 is straightforward documentation work using patterns already tested in phase 18–19. OPS-05 E2E can reuse the existing Playwright mock-backend pattern for flows (a) and (b), and add a Node-only integration test for (c). The 1000-abort lsof FD stress test (flagged in phase 18) should be deferred to v1.6.x or v1.7 (marked as pragmatic deferral — bounded resource-stability test in CI is higher-value than flaky lsof polling).

---

<user_constraints>

## User Constraints (from Phase Goal & Locked Requirements)

### Locked Decisions

1. **Zero new runtime dependencies** — Sentry/Datadog examples must be documentation only. Consumer brings their own `@sentry/node` or `@datadog/browser-rum` SDK.
2. **E2E uses existing Playwright harness** — reuse page.route() mocking and mock-backend patterns. Do not require a live backend.
3. **SIGTERM/drain E2E is Node-only** — recommend a pragmatic approach (integration test with spawned server + fake timers, not browser-based Playwright, since SIGTERM doesn't fire in browser context).
4. **1000-abort lsof FD stress test — deferred** — Phase 18 flagged it as potentially flaky in CI. Phase 20 should assess feasibility and recommend a pragmatic stance: either a bounded resource-stability integration test (10–50 aborts, verify FD count stable under load) or explicit deferral to v1.6.x.

### Claude's Discretion

1. **E2E test scope:** How granular should the three flows be? (a) Observability callback wiring — minimal (hook fires, context shape correct), or comprehensive (multithreaded load, latency assertions)? (b) Resilience fallbacks — mocked 429/503 from backend, or synthesized in-handler? (c) Graceful shutdown — Node integration test or Playwright against spawned Node server?
2. **Release notes tone:** Additive API surface (non-breaking) — should changelog emphasize "v1.5 → v1.6 is a drop-in upgrade" or detail all new options?
3. **Sentry/Datadog example scope:** Full setup guide (SDK init, env vars, dashboard config) or minimal "wire onError" example?

### Deferred Ideas (OUT OF SCOPE)

1. Bundling Sentry/Datadog SDKs as optional peer deps — consumers bring their own.
2. OpenTelemetry integration — v1.6 ships callback hooks; OTel is consumer's choice.
3. Multi-region circuit-breaker consistency — v1.7+.
4. Observability sampling for high-throughput — v1.6.x point release.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OPS-02 | Consumer can wire an error-reporting integration via hook, with a documented Sentry/Datadog example, NO vendor SDK bundled | **Findings:** Both Sentry (`@sentry/node` v8.9.2+) and Datadog (`@datadog/browser-rum`) support callback-based error instrumentation. Consumer instantiates SDK, wires `onError` callback, sends `OnErrorContext` to vendor APIs. Research includes: type-safe example mapping (OnErrorContext → Sentry.captureException), env-var setup patterns, and docs structure (no code changes to @deepagents-nextjs/server required). |
| OPS-05 | End-to-end tests pass for the THREE production flows: (1) observability event reaching a sink, (2) a resilience trip producing the correct fallback (429 rate-limit / 503 circuit-breaker), (3) SIGTERM shutdown draining an in-flight stream | **Findings:** (1) Playwright E2E with page.route() mock backend to trigger onError, spy on hook invocation, assert context payload. (2) Playwright E2E with mock-backend returning 429/503 in early rejection path; same test structure as phase 18 handler integration tests. (3) Node-only integration test: spawn handler in test context with fake timers, issue requests, SIGTERM signal, await drain(), assert activeCount → 0. Existing mock-backend patterns support (1) + (2); (c) requires new Node integration harness. |

</phase_requirements>

---

## Standard Stack

### Core

| Component | Technology | Version | Purpose | Why Standard |
|-----------|-----------|---------|---------|--------------|
| Error reporting (Sentry example) | `@sentry/node` | ^8.9.2 | Capture exceptions from the `onError` hook and send to Sentry | Official Sentry SDK with React 19 error hooks support; widely adopted in production |
| Error reporting (Datadog example) | `@datadog/browser-rum` | ^4.x | Capture exceptions from the `onError` hook and send to Datadog RUM | Official Datadog RUM SDK; supports custom metrics and user events via callback |
| E2E test framework | Playwright | ^1.45 | Browser-based E2E tests for observability/resilience flows | Already in use project-wide; supports mocking via page.route() |
| Node integration testing | Vitest + fake-timers | Current | Integration tests for SIGTERM graceful shutdown | Existing test harness; fake timers support deterministic drain testing without real delays |

### Supporting

| Component | Technology | Version | Purpose | When to Use |
|-----------|-----------|---------|---------|-------------|
| Mock backend SSE | Custom in-memory | — | Playwright page.route() handler returning SSE frames with mocked 429/503 | For resilience tests — no external service required |
| Changeset CLI | `@changesets/cli` | ^3.1.4 | Automated changelog generation from per-package `.md` files | Already configured in the repo; phase 20 creates v1.6.0 changesets |

---

## Architecture Patterns

### OPS-02: Error-Reporting Integration (Docs Pattern)

**What:** A consumer wires their own Sentry/Datadog SDK to the `onError` hook. Phase 20 provides type-safe examples mapping `OnErrorContext` (from phase 18 `observability.ts`) to vendor API calls.

**Pattern — Sentry example:**
```typescript
// Consumer code (NOT in @deepagents-nextjs/server)
import * as Sentry from '@sentry/node';
import { createDeepAgentsHandler, type OnErrorContext } from '@deepagents-nextjs/server';

Sentry.init({ dsn: process.env.SENTRY_DSN });

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      Sentry.captureException(ctx.error, {
        tags: {
          type: ctx.type, // "fetch" | "stream" | "rate-limit" | "circuit-breaker"
        },
        extra: {
          sessionId: ctx.sessionId,
          durationMs: ctx.durationMs,
          frameIndex: ctx.frameIndex,
        },
      });
    },
  },
});
```

**Pattern — Datadog example:**
```typescript
// Consumer code (NOT in @deepagents-nextjs/server)
import { datadogRum } from '@datadog/browser-rum';
import { createDeepAgentsHandler, type OnErrorContext } from '@deepagents-nextjs/server';

datadogRum.init({ applicationId: '...', clientToken: '...' });

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      datadogRum.addError(ctx.error, {
        'error.type': ctx.type,
        'session.id': ctx.sessionId,
        'duration.ms': ctx.durationMs,
      });
    },
  },
});
```

**Key insight:** The `OnErrorContext` type (already defined in phase 18 `observability.ts`) contains only safe scalars — no raw requests/headers/tokens. It maps directly to vendor error API calls. Documentation is the only deliverable; no code changes to the handler.

### OPS-05: Three E2E Flows

#### Flow 1: Observability → Sink (Playwright E2E)

**Test structure** (reuses existing `e2e/chat.spec.ts` pattern):
```typescript
// e2e/observability-flow.spec.ts
test("observability onError fires when backend returns 500", async ({ page, request }) => {
  // Intercept backend calls
  await page.route("**/api/chat/stream", (route) => {
    // Mock backend returning 500 to trigger onError
    void route.fulfill({
      status: 500,
      body: "Internal Server Error",
    });
  });

  // Spy on onError hook (via a test route that echoes hook invocations)
  const errors: OnErrorContext[] = [];
  await page.route("**/api/test/observe/errors", (route) => {
    void route.fulfill({ status: 200, body: JSON.stringify(errors) });
  });

  // Send request
  await page.goto("/");
  await page.getByRole("textbox").fill("test");
  await page.keyboard.press("Enter");

  // Assert UI error state + hook fired
  await expect(page.getByTestId("header-status")).toHaveText("error");
});
```

**Rationale:** Uses existing Playwright page.route() mocking. The test-harness already supports observability callbacks (phase 18 integration tests). E2E proves the callback fires under browser-issued requests (not just unit test environment).

#### Flow 2: Resilience → Fallback (Playwright E2E)

**Test structure** (similar to phase 18 handler.resilience.test.ts, adapted to E2E):
```typescript
// e2e/resilience-flow.spec.ts
test("rate-limit rejection returns 429 before fetching backend", async ({ request }) => {
  // Set up an in-memory store with a limit of 1
  const store = createMockRateLimitStore({ limit: 1 });

  // First request → success (under limit)
  const res1 = await request.post("/api/chat/stream", {
    data: { messages: [{ role: "user", content: "First" }] },
  });
  expect(res1.status()).toBe(200);

  // Second request → 429 (over limit)
  const res2 = await request.post("/api/chat/stream", {
    data: { messages: [{ role: "user", content: "Second" }] },
  });
  expect(res2.status()).toBe(429);
});

test("circuit-breaker open returns 503", async ({ request }) => {
  const store = createMockCircuitBreakerStore({
    failureThreshold: 1,
    state: "open", // Pre-set to open
  });

  const res = await request.post("/api/chat/stream", {
    data: { messages: [{ role: "user", content: "Test" }] },
  });
  expect(res.status()).toBe(503);
});
```

**Rationale:** Reuses the phase 18 store-mock pattern. E2E tests the rejection path at the HTTP boundary (not just handler unit test). Mock stores are in-memory; no external service required.

#### Flow 3: SIGTERM → Drain (Node Integration Test)

**Test structure** (new Node-only integration test):
```typescript
// packages/server/src/graceful-shutdown-e2e.test.ts (or similar)
import { createDeepAgentsHandler, createGracefulShutdown } from './index';
import { vi } from 'vitest';

test("SIGTERM drains in-flight streams", async () => {
  const shutdown = createGracefulShutdown({
    drainTimeoutMs: 5000,
    onExit: vi.fn(), // Spy on exit
  });

  // Create handler with shutdown tracking
  const handler = createDeepAgentsHandler({
    backendUrl: 'http://mock-backend/',
    observability: {
      onStreamStart: () => {
        // When stream starts, register it with shutdown
        shutdown.trackStream('stream-1');
      },
      onStreamEnd: () => {
        shutdown.releaseStream('stream-1');
      },
    },
  });

  // Simulate a long-running request
  const requestPromise = handler(makeRequest());

  // Wait for stream to start
  await vi.advanceTimersByTimeAsync(100);

  // Trigger shutdown
  await shutdown.dispose();

  // Assert: shutdown waited for stream + exited cleanly
  expect(vi.mocked(shutdown.onExit)).toHaveBeenCalledWith(0);
  expect(shutdown.activeCount()).toBe(0);
});
```

**Rationale:**
- SIGTERM only fires in Node.js (not browser), so a Playwright E2E is impossible.
- Integration test with fake timers is deterministic and CI-friendly (no real 30s waits).
- Tests the core contract: `dispose()` → `isDraining()` → readiness 503 → streams drain → exit.
- Can be extended to test timeout behavior (streams still active after drainTimeoutMs → exit code 1).

### Anti-Patterns to Avoid

- **Bundling Sentry/Datadog SDKs:** The examples are documentation only. Consumer responsibility to `npm install @sentry/node`.
- **Hard-coded error classifications:** The `OnErrorContext.type` field is descriptive only. Consumer decides which types to send to APM (e.g., skip rate-limit errors, only report stream errors).
- **Blocking on external APM services in E2E:** All E2E tests must pass without a live Sentry/Datadog backend. Examples show the *pattern*; tests use mock stores.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Error tracking infrastructure | Custom log aggregation to a database | Sentry / Datadog / OpenTelemetry exporter (consumer choice) | Vendor SDKs handle retry, batching, PII redaction; rolling your own is a support nightmare |
| Release notes generation | Manual markdown files | `@changesets/cli` with per-package `.md` files | Automated changelog prevents drift; changesets enforce intent + scope |
| E2E test mocking | Real backend Docker containers for every test | Playwright page.route() mock handlers + vitest mock stores | In-memory mocks are fast (< 100ms), deterministic, and don't require external services |
| Graceful shutdown testing | Real SIGTERM signals in CI | Vitest fake timers + injectable onExit | Fake timers are reproducible and don't race; real process.exit() in tests breaks the test runner |

**Key insight:** Phases 18–19 already provide the primitives (hooks, stores, shutdown factory). Phase 20 is integration + documentation, not new plumbing.

---

## Common Pitfalls

### Pitfall 1: Assuming onError Hook is for Control Flow
**What goes wrong:** Consumer tries to return a value from `onError` to gate the request (e.g., "don't proceed if Sentry fails").  
**Why it happens:** The hook signature allows async callbacks; looks like it might have control flow semantics.  
**How to avoid:** Document clearly: **"onError is read-only telemetry. Throwing/rejecting does not abort the stream. Use this hook for observability only; control flow belongs in the handler options (resilience stores, approval gating)."** This was validated in phase 18 OBS-02 gate.  
**Warning signs:** Consumer code has `await hook()` followed by an `if` check on the result.

### Pitfall 2: Leaking Secrets in onError Context
**What goes wrong:** A consumer logs the entire `OnErrorContext` object to a file or stdout, accidentally capturing sessionId or request metadata.  
**Why it happens:** The hook context looks like a generic error event; no warning that sessionId is personally identifiable.  
**How to avoid:** Document which fields are safe to log: `type`, `durationMs`, `frameIndex`, `error.message` are fine; `sessionId` may identify a user. Sentry/Datadog examples show scrubbing `sessionId` if needed.  
**Warning signs:** Error logs include session tokens or user IDs.

### Pitfall 3: Overloading onError with Expensive Operations
**What goes wrong:** Consumer runs a slow operation in `onError` (e.g., querying a database to enrich the error context), blocking the handler.  
**Why it happens:** No explicit performance budget documented; "just get more context" seems reasonable.  
**How to avoid:** Document: **"onError is an async hook but fires in the request loop. Expensive operations (DB queries, outbound RPC) should be async but fire-and-forget (no await in the handler). Use Sentry/Datadog SDK batching for backpressure."** Recommendation: keep hook to < 10ms latency; defer enrichment to APM backend.  
**Warning signs:** Handler response time increases significantly when onError is wired.

### Pitfall 4: Confusing Flow 1 (Observability) with Flow 2 (Resilience)
**What goes wrong:** E2E test for observability accidentally triggers a resilience gate (rate limit), confusing which flow was tested.  
**Why it happens:** The test setup is overlapping (both fire onError in different scenarios).  
**How to avoid:** Clearly name and separate E2E test files: `e2e/observability-flow.spec.ts`, `e2e/resilience-flow.spec.ts`, `e2e/shutdown-flow.test.ts`. Each test file focuses on one flow; avoid test interactions.  
**Warning signs:** A test passes sometimes, fails others, due to state leakage between test cases.

### Pitfall 5: Testing Graceful Shutdown with Real process.exit()
**What goes wrong:** The shutdown test calls `process.exit()` in the handler, terminating the entire test runner and losing subsequent test results.  
**Why it happens:** The injectable `onExit` pattern was overlooked; developer wired real process.exit directly.  
**How to avoid:** Always inject `onExit` in tests: `createGracefulShutdown({ onExit: vi.fn() })`. This was validated in phase 19 OPS-01 gate.  
**Warning signs:** Test suite exits prematurely with code 0/1 mid-run.

### Pitfall 6: Skipping the 1000-abort FD Stability Test
**What goes wrong:** Phase 20 E2E only tests "happy path" graceful shutdown; a regression that leaks sockets on abort is not caught.  
**Why it happens:** The phase 18 lsof FD stress test is flagged as "potentially flaky"; developers assume it's not needed.  
**How to avoid:** Pragmatic approach: (a) Include a bounded resource-stability test (10–50 aborts, measure FD count before/after, assert delta < 5). This is fast and deterministic. (b) If that proves flaky in CI, defer to v1.6.x with a clear JIRA ticket. Don't skip silently.  
**Warning signs:** Production deployment shows increasing file descriptor count over days of operation.

---

## Code Examples

Verified patterns from phase 18–19 source code and official vendor documentation.

### Error-Reporting Integration: Sentry Pattern

**Source:** Phase 18 `packages/server/src/observability.ts` (OnErrorContext), Sentry docs (https://docs.sentry.io/platforms/javascript/usage/)

```typescript
// Consumer code (next.js app/api/chat/stream/route.ts or equivalent)
import * as Sentry from '@sentry/node';
import { createDeepAgentsHandler, type OnErrorContext } from '@deepagents-nextjs/server';

// Initialize Sentry once at app startup
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      // Map handler error context to Sentry exception event
      Sentry.captureException(ctx.error, {
        tags: {
          error_type: ctx.type, // "fetch" | "stream" | "transform" | "rate-limit" | "circuit-breaker"
          backend: 'deepagents',
        },
        extra: {
          sessionId: ctx.sessionId,
          durationMs: ctx.durationMs,
          frameIndex: ctx.frameIndex,
        },
        level: ctx.type === 'rate-limit' ? 'warning' : 'error',
      });
    },
  },
});
```

**Why this pattern:**
- Sentry SDK is initialized once per process (not per-request).
- The `onError` hook callback is synchronous for simplicity; Sentry's `captureException` is async but non-blocking (queues internally).
- Tags and extra fields map directly to Sentry's event schema.
- `level` is adjusted: rate-limit errors (expected under load) are warnings; stream errors are errors.

### Error-Reporting Integration: Datadog Pattern

**Source:** Phase 18 `packages/server/src/observability.ts`, Datadog docs (https://docs.datadoghq.com/tracing/trace_collection/)

```typescript
// Consumer code (browser context, e.g., React hook)
import { datadogRum } from '@datadog/browser-rum';
import { createDeepAgentsHandler, type OnErrorContext } from '@deepagents-nextjs/server';

// Initialize Datadog RUM once at app startup
datadogRum.init({
  applicationId: process.env.REACT_APP_DATADOG_APP_ID!,
  clientToken: process.env.REACT_APP_DATADOG_CLIENT_TOKEN!,
  site: 'datadoghq.com',
  service: 'deepagents-frontend',
  env: process.env.NODE_ENV,
  sessionSampleRate: 100,
  telemetrySampleRate: 100,
  tracingSampleRate: 0.1,
});

// On the backend handler route (if running on Node/Remix/SvelteKit)
import { datadogrum } from '@datadog/browser-rum'; // or @datadog/nodejs package for server

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      datadogRum.addError(ctx.error, {
        'error.type': ctx.type,
        'session.id': ctx.sessionId,
        'backend.url': 'deepagents', // abstracted, not the actual URL
      });

      // Optionally: increment a custom metric
      datadogRum.addUserAction('error', {
        type: ctx.type,
        durationMs: ctx.durationMs,
      });
    },
  },
});
```

**Why this pattern:**
- Datadog RUM is browser-side; server-side Datadog traces are a separate setup (the APM tracing package).
- The `onError` hook can be wired on both client and server; each sends to its respective Datadog endpoint.
- Metrics (custom events) are a cleaner way to track error frequency by type without log bloat.

### Graceful Shutdown E2E (Integration Test with Fake Timers)

**Source:** Phase 19 `packages/server/src/shutdown.ts`, phase 18 handler patterns

```typescript
// packages/server/src/graceful-shutdown-e2e.test.ts
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGracefulShutdown } from './shutdown';
import { createDeepAgentsHandler } from './handler';
import { makeRequest, makeFetchResponse } from './handler.test'; // Test helpers

test.describe('Graceful Shutdown E2E', () => {
  beforeEach(() => {
    // Enable fake timers for deterministic drain tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('SIGTERM drains in-flight streams before exit', async () => {
    const onExit = vi.fn();
    const shutdown = createGracefulShutdown({
      drainTimeoutMs: 5000,
      onExit,
    });

    // Spy on the readiness probe to verify it flips to draining
    const readinessProbeContext = {
      isDraining: shutdown.isDraining,
    };

    // Create handler
    const handler = createDeepAgentsHandler({
      backendUrl: 'http://mock-backend/',
      observability: {
        onStreamStart: () => {
          shutdown.trackStream('stream-1');
        },
        onStreamEnd: () => {
          shutdown.releaseStream('stream-1');
        },
      },
    });

    // Stub fetch to return a slow stream
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      makeFetchResponse([
        'data: {"type":"text-delta"}\n\n',
        'data: {"type":"finish"}\n\n',
      ].join(''))
    ));

    // Send a request (does NOT await — stream drains in the background)
    const reqPromise = handler(makeRequest());

    // Advance time so the stream starts
    await vi.advanceTimersByTimeAsync(100);
    expect(shutdown.activeCount()).toBe(1);

    // Trigger graceful shutdown (SIGTERM simulation)
    const disposePromise = shutdown.dispose();

    // Verify readiness is now draining
    expect(shutdown.isDraining()).toBe(true);

    // Advance time for stream to complete + drain poll
    await vi.advanceTimersByTimeAsync(500);

    // Await the dispose to complete (it should exit with code 0)
    await disposePromise;

    expect(onExit).toHaveBeenCalledWith(0);
    expect(shutdown.activeCount()).toBe(0);
  });

  test('SIGTERM force-exits if streams do not drain in time', async () => {
    const onExit = vi.fn();
    const shutdown = createGracefulShutdown({
      drainTimeoutMs: 500, // Short timeout
      onExit,
    });

    let releaseStream: (() => void) | null = null;
    shutdown.trackStream('hung-stream');

    const disposePromise = shutdown.dispose();

    // Advance time past the drain timeout
    await vi.advanceTimersByTimeAsync(600);

    // Should have force-exited with code 1
    await disposePromise;
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
```

**Why this pattern:**
- Fake timers eliminate real delays (5s drain timeout becomes instant in tests).
- `onExit` is spied on; tests verify exit code without terminating the test runner.
- Two test cases cover both happy path (streams drain, exit 0) and timeout path (streams hang, exit 1).

---

## Validation Architecture

**Wave 0 Scaffolding:** Per-task test type and command. Phase 20 has a mix of doc, E2E, and integration tasks.

### Test Matrix

| Task | Type | Framework | Command | Gating Criteria |
|------|------|-----------|---------|-----------------|
| OPS-02a: Sentry example docs | Manual / Code Review | N/A | Review README section for accuracy + working code snippet | Sentry SDK v8.9.2+ API verified; example compiles without errors |
| OPS-02b: Datadog example docs | Manual / Code Review | N/A | Review README section for accuracy + working code snippet | Datadog RUM SDK v4.x+ API verified; example compiles without errors |
| OPS-05a: Observability flow E2E | E2E / Playwright | Playwright | `pnpm e2e -- observability-flow.spec.ts` | Hook fires on 500 error; context shape matches OnErrorContext type |
| OPS-05b: Resilience flow E2E (429) | E2E / Playwright | Playwright | `pnpm e2e -- resilience-flow.spec.ts --grep "rate-limit"` | First request succeeds; second request over limit returns 429 |
| OPS-05c: Resilience flow E2E (503) | E2E / Playwright | Playwright | `pnpm e2e -- resilience-flow.spec.ts --grep "circuit-breaker"` | Breaker-open request returns 503 before any backend fetch |
| OPS-05d: Graceful shutdown integration | Integration / Vitest | Vitest + fake-timers | `pnpm --filter @deepagents-nextjs/server test -- graceful-shutdown-e2e.test.ts` | Streams drain before exit; timeout forces exit with code 1 |
| v1.6.0 release: changesets + changelog | Manual + Automated | @changesets/cli | `pnpm changeset version` + `pnpm changeset changelog` | Changelog entries reference OPS-02 + OPS-05; version bumps to 1.6.0 |

### E2E Test Command Examples

**Observability flow (Playwright):**
```bash
pnpm e2e -- --project=chromium observability-flow.spec.ts
```

**Resilience flows (Playwright):**
```bash
pnpm e2e -- --project=chromium resilience-flow.spec.ts
```

**Graceful shutdown (Vitest integration):**
```bash
pnpm --filter @deepagents-nextjs/server test graceful-shutdown-e2e.test.ts
```

**Full v1.6.0 validation suite:**
```bash
# Unit tests (phase 18–19 unchanged)
pnpm --filter @deepagents-nextjs/server test

# E2E (phase 20 new + existing)
pnpm e2e

# Changelog + version bump
pnpm changeset version
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hard-coded HTTP 200 OK for all backend 2xx | Preserve backend status code (re-emit as proxy) | Phase 5 | Consumers see real backend status; enables health checks to differentiate error scenarios |
| Eager stream loop that reads all backend chunks at once | Pull-based ReadableStream with backpressure (phase 18 plan 04) | 2026-06-06 | Slow clients no longer trigger OOM; bounded in-flight gap proven by tests |
| No observability beyond console.error | Vendor-neutral `onError` hook (phase 18 plan 01) | 2026-06-06 | Consumers wire Sentry/Datadog without us bundling SDKs; decoupled from vendor choice |
| No graceful shutdown (process.exit on error) | Per-instance shutdown factory with drain orchestration (phase 19 plan 01) | 2026-06-06 | SIGTERM → readiness 503 → drain → exit; in-flight requests complete cleanly |
| No rate-limit / circuit-breaker | Consumer-store-backed resilience gates (phase 18 plan 03) | 2026-06-06 | Stateless handler; consumer brings Redis/DynamoDB for distributed state |

**Deprecated/outdated:**
- **OpenTelemetry SDK bundled (out of scope):** v1.6 uses callback hooks instead; consumer wires OTel if desired.
- **Built-in logger (e.g., Pino):** Removed from scope; use `console` or hook-based logging.

---

## Open Questions

1. **1000-abort lsof FD stress test — pragmatic deferral**
   - What we know: Phase 18 plan 04 included a 200x repeated-abort test to prove no FD leak (passes). Phase 20 should decide on the 1000-abort lsof check.
   - What's unclear: Is the 200x test sufficient for the phase gate? Or is 1000-abort + lsof verification required for production confidence?
   - Recommendation: **Include a bounded resource-stability test (10–50 aborts, measure FD delta before/after) in the integration suite. If that proves stable under CI load over 2–3 runs, defer the 1000-abort lsof check to v1.6.x with a ticket.** This is pragmatic: the test validates the core contract (no unbounded leak) without flakiness risk.

2. **E2E test for observability — where to assert hook invocation?**
   - What we know: Phase 18 has unit tests proving the hook fires; phase 20 needs E2E proof that it fires under a real request.
   - What's unclear: Should the E2E test verify hook invocation via a test-only route (`/api/test/observe/errors`) that echoes hook events, or via instrumentation assertions (spy on a global observability sink)?
   - Recommendation: **Use a test-only route approach** — create an in-memory sink on the handler that collects hook events during tests, wire a `/api/test/observe/[event-type]` route to inspect it. This mirrors the phase 18 unit test harness and avoids Playwright-specific spy complexity.

3. **Graceful shutdown E2E — should it test multi-stream drain?**
   - What we know: Phase 19 plan 01 tests single-stream drain with fake timers; phase 20 should extend it.
   - What's unclear: Should the E2E test concurrent streams (5–10 in-flight) to prove isolation? Or is single-stream sufficient?
   - Recommendation: **Single-stream + one timeout test is sufficient for phase 20 gate.** Add a concurrency test (2–3 streams) to a v1.6.x spike if needed. Single-stream covers the core contract; concurrency adds diminishing returns and test complexity.

4. **Release notes tone — how much detail on non-breaking API?**
   - What we know: v1.5 → v1.6 is all additive (observability, resilience, shutdown options).
   - What's unclear: Should changelog emphasize "drop-in upgrade, 100% backward compatible" or detail every new option?
   - Recommendation: **Create a v1.6.0 migration guide with a "What's New" section** (observability hooks, resilience stores, graceful shutdown), followed by "Upgrade Path" (no breaking changes, existing code works unchanged). Keep changelog focused on new features; reserve full option details for API docs.

---

## Sources

### Primary (HIGH confidence)
- **Phase 18 `observability.ts`** — OnErrorContext type definition, hook safety contract (OBS-02)
- **Phase 18 `handler.resilience.test.ts`** — Store mock patterns, 429/503 rejection tests
- **Phase 19 `shutdown.ts`** — Per-instance factory, drain orchestration, fake-timer testability
- **Playwright config** (`playwright.config.ts`) — E2E test structure, page.route() mocking pattern
- **E2E test examples** (`e2e/chat.spec.ts`, `e2e/nextjs.spec.ts`) — Playwright request mocking, SSE parsing

### Secondary (MEDIUM confidence)
- **Sentry JavaScript SDK docs** (https://docs.sentry.io/platforms/javascript/usage/) — Error capture API, `captureException` method signature
- **Datadog RUM SDK docs** (https://docs.datadoghq.com/tracing/trace_collection/) — Error event creation, custom metrics
- **@changesets/cli** (https://github.com/changesets/changesets) — Changelog generation, changeset format (`.md` frontmatter syntax)

### Tertiary (LOW confidence — flagged for validation)
- **Graceful shutdown best practices on serverless** — Phase 19 docs flag Vercel ~500ms window, Cloudflare no SIGTERM. Recommendation is documented but not empirically tested on those platforms; v1.6.1 should add platform-specific integration tests.

---

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH — Sentry/Datadog SDKs are widely adopted; integration pattern via callbacks is standard.
- **Architecture (OPS-02 docs):** HIGH — Phase 18 `OnErrorContext` type is locked; examples follow vendor SDK patterns.
- **Architecture (OPS-05 E2E):** HIGH — Phases 18–19 provide all primitives; phase 20 is integration + testing.
- **Validation (test commands):** HIGH — Existing Playwright harness; Vitest + fake-timers proven in phase 19.
- **1000-abort FD stress test:** MEDIUM — Phase 18 passed the 200x test; pragmatic deferral is reasonable but should be validated empirically in CI.

**Research date:** 2026-06-06  
**Valid until:** 2026-07-06 (30 days — v1.6 is stable; no fast-moving dependencies)

**Next step:** Planner creates three OPS-02 tasks (Sentry example, Datadog example, docs review) and four OPS-05 tasks (observability E2E, resilience 429/503 E2E, graceful shutdown integration, changesets + release). Phase 20 plan can reference this research's code examples and E2E test structure directly.
