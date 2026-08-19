# Error Reporting (Sentry / Datadog) via the `onError` hook

This guide shows how to ship handler errors to your APM or error-reporting
service (Sentry, Datadog, OpenTelemetry, or anything else) through the
vendor-neutral `observability.onError` hook on `createDeepAgentsHandler`.

## Overview

Error reporting is wired via the `observability.onError` hook (Phase 18,
OBS-01..03). The library bundles **NO** APM SDK and reads **NO** vendor env
vars. **Bring your own `@sentry/node` or `@datadog/*` SDK — it is never a
dependency of `@deepagents-nextjs/*`.** You initialize the SDK once at module
scope in your own app, then forward the `OnErrorContext` to it from `onError`.

This keeps the bundle small, avoids forcing a vendor choice on consumers, and
keeps telemetry vendor-neutral. The only integration surface is the `onError`
callback you supply.

## The `OnErrorContext` shape

`onError` receives a single `OnErrorContext` argument. The shape is the source
of truth in `packages/server/src/observability.ts`. By design (OBS-03) it
carries **only safe scalar fields** — no raw request/response objects, headers,
`Authorization` tokens, cookies, or request bodies ever reach the hook. The
`error` is an `Error` object only, never a raw payload.

| Field        | Type                                                                    | Meaning                                                              | Safe to send to a 3rd party?                                              |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `type`       | `"fetch" \| "stream" \| "transform" \| "rate-limit" \| "circuit-breaker"` | Which lifecycle stage failed                                         | Yes — fixed enum, no PII                                                  |
| `error`      | `Error`                                                                  | The error object (message + stack); never a raw payload             | Yes — but scrub `error.message` if your handlers can embed user input    |
| `durationMs` | `number`                                                                 | Elapsed time before the failure                                     | Yes — numeric scalar                                                     |
| `frameIndex` | `number \| undefined`                                                    | Stream frame index when the failure was during transform/stream     | Yes — numeric scalar                                                     |
| `sessionId`  | `string`                                                                 | The session identifier for the request                             | **Potentially user-identifying — scrub if your APM PII policy requires** |
| `timestamp`  | `number`                                                                 | `Date.now()` at the failure                                         | Yes — numeric scalar                                                     |

No raw headers, tokens, or bodies ever reach the hook (see OBS-03). Treat
`sessionId` as potentially identifying and scrub it before logging if your PII
policy requires.

## Sentry example

Initialize Sentry once at module scope, then forward the context from
`onError`. The vendor SDK (`@sentry/node`) is **your** dependency — install it
in your app; it is never bundled by this library.

```typescript
import * as Sentry from "@sentry/node";
import {
  createDeepAgentsHandler,
  type OnErrorContext,
} from "@deepagents-nextjs/server";

// Initialize once at module scope (not per-request).
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      Sentry.captureException(ctx.error, {
        tags: { error_type: ctx.type },
        extra: {
          sessionId: ctx.sessionId,
          durationMs: ctx.durationMs,
          frameIndex: ctx.frameIndex,
        },
        // Rate-limit errors are expected under load — downgrade to warning.
        level: ctx.type === "rate-limit" ? "warning" : "error",
      });
    },
  },
});
```

`Sentry.captureException` queues internally and is non-blocking, so it is safe
to call from the synchronous `onError` callback.

## Datadog example

Datadog RUM (`@datadog/browser-rum`) is browser-side; server traces use the
separate Datadog APM (`dd-trace`) package. Either way, the SDK is **your**
dependency and is never bundled here.

```typescript
import { datadogRum } from "@datadog/browser-rum";
import {
  createDeepAgentsHandler,
  type OnErrorContext,
} from "@deepagents-nextjs/server";

// Initialize once at app startup. RUM is browser-side; for server traces use
// the separate Datadog APM package (dd-trace).
datadogRum.init({
  applicationId: process.env.DATADOG_APP_ID!,
  clientToken: process.env.DATADOG_CLIENT_TOKEN!,
  site: "datadoghq.com",
  service: "deepagents-frontend",
  env: process.env.NODE_ENV,
  sessionSampleRate: 100,
});

const handler = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  observability: {
    onError: (ctx: OnErrorContext) => {
      datadogRum.addError(ctx.error, {
        "error.type": ctx.type,
        "session.id": ctx.sessionId,
        "error.duration_ms": ctx.durationMs,
      });
    },
  },
});
```

## Caveats

1. **`onError` is READ-ONLY telemetry.** Throwing or rejecting inside the hook
   **never aborts** the SSE stream, and the return value does **not** gate the
   request. Every invocation is wrapped in a try-catch inside the handler
   (OBS-02). Control flow (aborting, blocking, retrying) belongs to the
   resilience stores and approval gating — not to `onError`.
2. **Keep the hook fast (< ~10ms).** Forward to the APM SDK and rely on its
   internal batching/queueing. Do not run blocking DB writes, synchronous RPCs,
   or heavy enrichment inline — that adds latency to the failure path.
3. **`sessionId` may identify a user.** Scrub or hash it before sending if your
   APM PII policy requires. Likewise, scrub `error.message` if your handlers can
   embed user-supplied text into errors.

## Required env vars

The consumer supplies the vendor credentials — this library reads none of them:

- **Sentry:** `SENTRY_DSN`
- **Datadog:** `applicationId` + `clientToken` (RUM), or `DD_API_KEY` for APM

These are passed to your SDK's `init()` call. `@deepagents-nextjs/server` never
reads `SENTRY_DSN`, `DATADOG_APP_ID`, or any other vendor env var.
