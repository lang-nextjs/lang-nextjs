# Migrating to v1.6

v1.6 is a **non-breaking, drop-in** release. Every new capability is **additive** and
**opt-in** — if you upgrade and change nothing, your existing handlers keep working
exactly as they did on v1.5. No public types were removed or changed, and no new
runtime dependencies were added. Edge-runtime compatibility is preserved.

## What's New in v1.6

v1.6 rounds out the production-readiness surface. All of the following are opt-in:

- **Observability hooks** (`observability` option) — vendor-neutral lifecycle
  callbacks: `onRequest`, `onFetchStart`, `onFetchEnd`, `onStreamStart`, `onError`,
  `onStreamEnd`. Timing is edge-safe (no Node-only APIs). A throwing/rejecting hook is
  logged but never aborts the stream.
- **Health & readiness probes** (`createHealthProbe` / `createReadinessProbe`) —
  cheap, local liveness/readiness endpoints. Readiness performs **no** mandatory
  backend fetch; dependency checks are opt-in consumer-supplied `ProbeCheck`s. Readiness
  is the SIGTERM → 503 integration point for graceful shutdown.
- **Resilience** (`resilience` option) — consumer-store-backed rate limiting
  (returns **429**), circuit breaker (returns **503**), per-request timeout,
  backpressure, and configurable retry. The library holds **zero** module-scope
  state — all state lives in consumer-provided stores, which is correct under
  serverless/edge isolation. Rejections happen **before** the upstream fetch.
- **Graceful shutdown** (`createGracefulShutdown`) — Node-only per-instance factory
  for SIGTERM-driven drain: flip readiness to 503, drain in-flight streams, then exit.
  Exit is injectable (`onExit`) and signal handlers are opt-in
  (`installSignalHandlers()`), so importing the module registers zero listeners.
- **Error reporting** (via `observability.onError`) — surface failures to
  Sentry/Datadog/etc. through the `onError` hook. **No vendor SDK is bundled**; you
  wire your own reporter. See [./ERROR-REPORTING.md](./ERROR-REPORTING.md) for
  console/Sentry/Datadog examples.

All three production flows (observability `onError`, resilience 429/503, and the
SIGTERM drain) are covered end-to-end by the test suite (OPS-05).

## Upgrade Path (v1.5 → v1.6)

This is a **drop-in upgrade**:

- Existing `createDeepAgentsHandler({ backendUrl })` calls work **unchanged**.
- Every new capability is **opt-in** via additive options (`observability`,
  `resilience`) or new exports (`createHealthProbe`, `createReadinessProbe`,
  `createGracefulShutdown`).
- **No public types were removed or changed.**
- **No new runtime dependencies** were added.
- **Edge-runtime compatibility is preserved** (no Node-only APIs in `/edge`).

### Before (v1.5) — still works verbatim in v1.6

```ts
import { createDeepAgentsHandler } from "@deepagents-nextjs/server";

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
});
```

### After (v1.6) — same call, now opting into observability + resilience

```ts
import { createDeepAgentsHandler } from "@deepagents-nextjs/server";

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,

  // opt-in: vendor-neutral lifecycle hooks (see ERROR-REPORTING.md for onError)
  observability: {
    onError: (ctx) => reportToSentry(ctx),
  },

  // opt-in: consumer-store-backed rate limit (429) + circuit breaker (503)
  resilience: {
    rateLimit: { store: myRateLimitStore, limit: 60, windowMs: 60_000 },
    circuitBreaker: { store: myBreakerStore },
    timeoutMs: 30_000,
  },
});
```

If you omit `observability` and `resilience`, behavior is identical to v1.5 — there is
nothing to migrate.
