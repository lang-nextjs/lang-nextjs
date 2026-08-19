# @deepagents-nextjs/server

## 0.2.0

### Minor Changes

- 70284ad: v1.6 adds a vendor-neutral production-readiness surface to the handler. A new `observability` option exposes lifecycle hooks (`onRequest`, `onFetchStart`, `onFetchEnd`, `onStreamStart`, `onError`, `onStreamEnd`) with edge-safe timing, and `createHealthProbe` / `createReadinessProbe` helpers ship for liveness/readiness endpoints. A new `resilience` option adds consumer-store-backed rate limiting (429), a circuit breaker (503), a per-request timeout, backpressure, and configurable retry. Node deployments can wire `createGracefulShutdown()` for SIGTERM-driven drain (flip readiness to 503, drain in-flight streams, then exit).

  All options are opt-in and additive — existing handlers are unaffected. No new runtime dependencies; edge-runtime compatibility preserved. Error reporting (Sentry/Datadog) wires through the `observability.onError` hook with no vendor SDK bundled — see docs/ERROR-REPORTING.md and docs/MIGRATION-v1.6.md.
