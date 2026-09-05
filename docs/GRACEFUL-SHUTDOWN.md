# Graceful Shutdown

`createGracefulShutdown()` (from `@deepagents-nextjs/server`) is a **Node-only,
opt-in** orchestrator that, on `SIGTERM`/`SIGINT`, flips a per-instance draining
flag, waits for in-flight SSE streams to finish (up to a configurable timeout),
then exits. It is the runtime half of the SIGTERM→503 drain: the draining flag
is wired into the Phase 18 `createReadinessProbe` so the readiness endpoint
returns `503 { status: "draining" }` the instant shutdown begins, and the load
balancer stops routing new traffic before active streams are drained.

## Overview

- **Node-only.** This module is never copied into the `edge` package. It calls
  `process.exit` / `process.once` and is meaningless where there is no process
  lifecycle (see [Serverless limitations](#serverless-limitations)).
- **Opt-in.** Importing the module registers **zero** signal listeners. A
  listener is installed only when you call `installSignalHandlers()` (or wire
  `process.on('SIGTERM', () => shutdown.dispose())` yourself).
- **No module-scope state.** The draining flag and the active-stream `Set` live
  inside the handle returned by the factory. Each call yields an independent
  instance — safe to create one per server.
- **Safety timeout.** `dispose()` always terminates: if streams never release it
  force-exits with code `1` after `drainTimeoutMs`, so a hung stream can never
  block exit forever.

## API

```ts
import {
  createGracefulShutdown,
  type ShutdownConfig,
  type GracefulShutdown,
} from "@deepagents-nextjs/server";

const shutdown: GracefulShutdown = createGracefulShutdown(config?: ShutdownConfig);
```

### `ShutdownConfig`

| Field            | Type                     | Default                        | Purpose                                                           |
| ---------------- | ------------------------ | ------------------------------ | ----------------------------------------------------------------- |
| `drainTimeoutMs` | `number`                 | `30000`                        | Max time to wait for streams to drain before force-exiting.       |
| `onExit`         | `(code: number) => void` | `(code) => process.exit(code)` | Exit hook. Injectable so tests assert exit codes without exiting. |
| `logger`         | `(msg: string) => void`  | `console.warn`                 | Log sink for drain lifecycle messages.                            |

### `GracefulShutdown` handle

| Member                    | Signature              | Behavior                                                                                          |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `isDraining()`            | `() => boolean`        | `true` once `dispose()` has begun. **Wire this into `createReadinessProbe`.**                     |
| `trackStream(id)`         | `(id: string) => void` | Register an in-flight stream by id (Set semantics — duplicate ids dedupe).                        |
| `releaseStream(id)`       | `(id: string) => void` | Mark a stream finished. Unknown ids are ignored.                                                  |
| `activeCount()`           | `() => number`         | Number of currently active streams.                                                               |
| `dispose()`               | `() => Promise<void>`  | Flip draining, wait for streams to drain up to `drainTimeoutMs`, then `onExit`. Idempotent.       |
| `installSignalHandlers()` | `() => () => void`     | Register `process.once` SIGTERM + SIGINT handlers that call `dispose()`. Returns an uninstall fn. |

On a clean drain `dispose()` invokes `onExit(0)`; if streams are still active at
the deadline it logs and invokes `onExit(1)`.

## Integration

Create one shutdown handle at startup, feed `isDraining()` into the readiness
probe, and track/release streams through the handler's observability hooks.

```ts
// server bootstrap (Node runtime only)
import {
  createGracefulShutdown,
  createReadinessProbe,
} from "@deepagents-nextjs/server";

// 1. One instance for the process.
const shutdown = createGracefulShutdown({
  // >= max expected request duration + margin (see below).
  drainTimeoutMs: 30_000,
});

// 2. Readiness flips to 503 { status: "draining" } as soon as draining starts.
//    GET /ready handler:
export async function readyHandler() {
  const result = await createReadinessProbe({
    isDraining: () => shutdown.isDraining(),
  });
  return Response.json(result, { status: result.ready ? 200 : 503 });
}

// 3. Track in-flight SSE streams via the handler observability hooks so dispose()
//    knows when the process has finished draining.
const handlerConfig = {
  onRequest: ({ requestId }: { requestId: string }) => {
    shutdown.trackStream(requestId);
  },
  onStreamEnd: ({ requestId }: { requestId: string }) => {
    shutdown.releaseStream(requestId);
  },
  // ...other handler config
};

// 4. Install signal handlers ONCE at startup. installSignalHandlers() uses
//    process.once, so repeated signals never accumulate listeners
//    (avoids the Node MaxListeners warning). Do NOT call it per-request.
const uninstall = shutdown.installSignalHandlers();
// uninstall() removes both listeners (e.g. in tests or hot-reload teardown).
```

> **MaxListeners pitfall:** call `installSignalHandlers()` exactly once per
> process. It registers `process.once('SIGTERM')` + `process.once('SIGINT')`;
> calling it in a request path or import side-effect would leak listeners and
> trip Node's MaxListenersExceededWarning.

## Configuring the drain timeout

Set `drainTimeoutMs` to **at least your maximum expected request/stream duration
plus a margin**. For long-lived SSE chat streams that can run for minutes, pick a
value that lets a typical in-flight turn complete (e.g. 30–60s), then rely on the
safety timeout to guarantee exit if a stream hangs.

- Too low → in-flight streams are truncated at the deadline (`onExit(1)`).
- Too high → orchestrators (Kubernetes `terminationGracePeriodSeconds`, Vercel)
  may `SIGKILL` the process before `dispose()` finishes. Keep `drainTimeoutMs`
  **below** the platform's grace period so the safety timeout, not the platform
  kill, controls exit.

The safety timeout always guarantees exit: a stream that never calls
`releaseStream` cannot block shutdown beyond `drainTimeoutMs`.

## Serverless limitations

Graceful shutdown is **best-effort or not-applicable** on serverless platforms —
it is **not guaranteed** there. Recommend client-side reconnection as the
durable mitigation.

- **Vercel (Node functions): ~500ms window.** When an instance is recycled you
  get roughly a ~500ms window before termination — not enough to drain a
  long-lived SSE stream. Streams will be **truncated**; treat shutdown drain as
  best-effort only. Wire the readiness probe for the canary/health-gate flow,
  but do **not** rely on the drain loop to finish long streams.
- **Cloudflare Workers: no SIGTERM (N/A).** Workers have no process lifecycle and
  receive no `SIGTERM`; `createGracefulShutdown()` does not apply. This module is
  Node-only and is never bundled into the edge package.

**Mitigation — client-side reconnection.** Because drain is not guaranteed on
serverless, clients should detect a dropped/truncated stream and reconnect (the
`useDeepAgentsChat` resume/`resumeId` flow re-attaches to an interrupted run).
Resilience lives on the client; the server drain loop is a best-effort
optimization where the platform allows it (long-running Node hosts: Kubernetes,
a VM/container, a bare Node server).

See [DEPLOYMENT-RUNBOOK.md](./DEPLOYMENT-RUNBOOK.md) for Kubernetes probe wiring,
preStop/SIGTERM ordering, and the health-gated rollout that uses this drain flow.
