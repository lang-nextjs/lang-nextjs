# @deepagents-nextjs/edge

## 0.2.0

### Minor Changes

- 70284ad: Add `streamTimeoutMs` option to `createCloudflareHandler` for bounding total stream duration on Cloudflare Workers.

  When set, the handler aborts the backend connection if the configured limit is exceeded: a pre-stream timeout returns HTTP 504, and a mid-stream timeout errors the `ReadableStream` instead of leaking an open reader. The option defaults to `undefined`, so existing handlers are unaffected unless they opt in. Recommended to keep it below the Worker CPU limit (30s on the free tier).

  The README now documents Cloudflare Worker tier requirements (128MB memory, 30s CPU, ~10s TTFB) and the new option.

- 70284ad: v1.6 adds a vendor-neutral production-readiness surface to the handler. A new `observability` option exposes lifecycle hooks (`onRequest`, `onFetchStart`, `onFetchEnd`, `onStreamStart`, `onError`, `onStreamEnd`) with edge-safe timing, and `createHealthProbe` / `createReadinessProbe` helpers ship for liveness/readiness endpoints. A new `resilience` option adds consumer-store-backed rate limiting (429), a circuit breaker (503), a per-request timeout, backpressure, and configurable retry. Node deployments can wire `createGracefulShutdown()` for SIGTERM-driven drain (flip readiness to 503, drain in-flight streams, then exit).

  All options are opt-in and additive — existing handlers are unaffected. No new runtime dependencies; edge-runtime compatibility preserved. Error reporting (Sentry/Datadog) wires through the `observability.onError` hook with no vendor SDK bundled — see docs/ERROR-REPORTING.md and docs/MIGRATION-v1.6.md.
