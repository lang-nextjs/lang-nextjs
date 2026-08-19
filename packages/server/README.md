# @deepagents-nextjs/server

Next.js App Router handler factory for DeepAgents SSE streaming — one-line server setup with adapter pipeline.

## Installation

```bash
npm install @deepagents-nextjs/server
```

## Quick Start

```typescript
import { createDeepAgentsHandler } from '@deepagents-nextjs/server';
export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! });
```

## API Reference

### `createDeepAgentsHandler(options)`

Creates a Next.js App Router `POST` handler that proxies SSE streams from a DeepAgents backend through a configurable adapter and transform pipeline.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `backendUrl` | `string` | **required** | URL of the DeepAgents backend SSE endpoint |
| `adapter` | `SseAdapter` | `deepagentsAdapter` | Named adapter bundle that normalizes backend SSE format to AI SDK v6. Pipeline order: `adapter.transforms` then `options.transforms`. |
| `retry` | `{ maxRetries?: number; initialDelayMs?: number }` | `{ maxRetries: 0 }` | Retry policy for connection-level `fetch()` failures only. Mid-stream failures are not retried. |
| `getToken` | `(req: NextRequest) => Promise<string \| null \| undefined> \| string \| null \| undefined` | — | Optional async token provider. See fail-open behavior below. |
| `transforms` | `SseTransform[]` | `[]` | Additional transforms appended after `adapter.transforms`. |
| `maxBodyBytes` | `number` | `1_048_576` (1 MB) | Request body-size guard. Pre-read `Content-Length` check + belt-and-braces post-buffer re-check. Returns **413** with `{error, maxBytes, actual}`. Set to `0` or negative to disable. |
| `observability` | `ObservabilityHooks` | — | Vendor-neutral lifecycle hooks (OBS-01..03). Callbacks fire at request/fetch/stream start/end/error with safe scalar metadata only (no headers/tokens/bodies). Hooks are wrapped in try/catch — a throwing callback is logged but never aborts the stream. |

### Hardening contract (since v0.x)

The handler enforces defensive contracts against the most common
proxy-misuse attack patterns. All rejections return structured 4xx
responses — clients can act on them.

| Contract | Trigger | Response |
|----------|---------|----------|
| Strict `Content-Type` | Duplicate or comma-joined `Content-Type` header | `400 Bad Request` |
| Strict `Authorization` | Duplicate or comma-joined `Authorization` header | `400 Bad Request` |
| Body-size guard | `Content-Length > maxBodyBytes` OR post-buffer body byteLength exceeds limit | `413 Payload Too Large` |
| SSE frame cap | Accumulator frame exceeds `MAX_FRAME_BYTES` (1 MB) | Frame dropped/truncated |
| CRLF normalization | SSE frame boundary is `\r\n\r\n` or `\r\n` | Split correctly (no deadlock) |
| NaN-safe timing | `performance.now()` returns NaN | Falls back to `Date.now()` |
| `safeStringify` adapters | Circular reference / BigInt in tool output | Falls back to `String(...)` |
| Whitespace text-delta filter | Tool emits whitespace-only text-delta | Dropped (not emitted) |

Note: `Cookie`, `Accept`, `Vary`, `Cache-Control` are passed through
unchanged — their comma-separated multi-value grammar is RFC-correct
and comma-detection would have false positives (e.g. URL-encoded `%2C`
in cookie values).

**`retry` options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetries` | `number` | `0` | Number of retries after first failure (0 = no retry) |
| `initialDelayMs` | `number` | `100` | Base delay for exponential backoff (ms) |

**Example with retry:**

```typescript
export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  retry: { maxRetries: 3 },
});
```

---

### Adapters

Three named adapters ship with the package. Pass one as `adapter:` to normalize a non-standard backend format.

| Adapter | Description |
|---------|-------------|
| `deepagentsAdapter` | **Default.** Strips `messageId` from `finish` events (required for AI SDK v6 strict parsing). |
| `langGraphAdapter` | LangGraph `astream_events` v2 — maps `on_chat_model_stream` events to AI SDK v6 `text-delta` frames. |
| `langchainAdapter` | LangChain native SSE — maps token/message/tool_call events to AI SDK v6 format. |
| `createLangchainTransform()` | Factory for a custom LangChain transform — use when you need to configure the adapter per-handler. |

```typescript
import { createDeepAgentsHandler, langGraphAdapter } from '@deepagents-nextjs/server';

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.LANGGRAPH_URL!,
  adapter: langGraphAdapter,
});
```

---

### `getCookieToken(cookieName)`

Helper factory that returns a `getToken`-compatible function reading a cookie from `NextRequest` synchronously.

```typescript
import { createDeepAgentsHandler, getCookieToken } from '@deepagents-nextjs/server';

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  getToken: getCookieToken('session'),
});
```

**Signature:** `getCookieToken(cookieName: string): (req: NextRequest) => string | undefined`

**Fail-open behavior:**

| `getToken` return value | Effect |
|------------------------|--------|
| Absent (not provided) | Forward all non-hop-by-hop client headers as-is |
| `null` or `undefined` | No `Authorization` header sent to backend |
| `string` | Injects `Authorization: Bearer {token}`, replacing client `Authorization` |

**Important:** Use `getCookieToken` in a Route Handler (`app/api/**/route.ts`) only. Do **not** use in Server Components — the `cookies()` import from `next/headers` is the correct API there.

---

### Debug Logging

Set `DEBUG=deepagents:sse` as a **server-side** environment variable to log each SSE frame to `stderr`:

```bash
DEBUG=deepagents:sse node server.js
```

Each frame is logged with the `deepagents:sse` namespace. This is a server-side env var — do **not** prefix with `NEXT_PUBLIC_`.

---

### `defaultTransforms` (deprecated)

```typescript
import { defaultTransforms } from '@deepagents-nextjs/server'; // @deprecated
```

**`@deprecated`** — Use `deepagentsAdapter` instead:

```typescript
import { createDeepAgentsHandler, deepagentsAdapter } from '@deepagents-nextjs/server';
createDeepAgentsHandler({ backendUrl, adapter: deepagentsAdapter });
```

`defaultTransforms` is equivalent to `deepagentsAdapter.transforms` and will be removed in a future major version.

---

## Error Reporting & Observability

The handler accepts an `observability` option carrying vendor-neutral lifecycle
hooks (Phase 18). The `onError` hook is the integration point for APM and
error-reporting services: it fires on any lifecycle failure path with a
secret-safe `OnErrorContext` (`type`, `error`, `durationMs`, `frameIndex?`,
`sessionId`, `timestamp`). **No vendor SDK is bundled** — bring your own
`@sentry/node` or `@datadog/*` SDK and forward the context to it.

```typescript
import { createDeepAgentsHandler } from '@deepagents-nextjs/server';

createDeepAgentsHandler({
  backendUrl,
  observability: {
    onError: (ctx) => {
      // Send ctx.error + ctx.type to your APM (Sentry, Datadog, …).
      // onError is read-only telemetry: throwing here never aborts the stream.
    },
  },
});
```

For the full Sentry/Datadog wiring guide, the `OnErrorContext` field/safety
table, and the read-only-telemetry caveat, see
[docs/ERROR-REPORTING.md](../../docs/ERROR-REPORTING.md).

---

## Approval Gating (ADAPT-05)

Gate tool execution behind explicit human approval. When enabled, the handler emits a
`data-approval-required` frame and pauses the stream until the client sends an approve
or reject decision.

### Handler setup

```typescript
import { createDeepAgentsHandler } from '@deepagents-nextjs/server'

export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
  approvalGating: {
    getApprovalConfig: (toolCall) => {
      // Return { require: true } to gate this tool, or undefined to pass through
      return { require: true, timeoutMs: 300_000 }
    },
  },
})
```

### Approval endpoint

Add a dynamic route at `app/api/approval/[approvalId]/route.ts`:

```typescript
import { createApprovalRoutes } from '@deepagents-nextjs/server'

const { GET, POST } = createApprovalRoutes()
export { GET, POST }
```

### Authorization (`authorize` callback)

The route factory accepts an optional `authorize(request) => boolean | Promise<boolean>`
that runs before any state read. The handler decides 401 vs. pass-through per
your app's auth strategy (Bearer token, session cookie, NextAuth, etc.) — the
package stays auth-agnostic.

```typescript
import { createApprovalRoutes } from '@deepagents-nextjs/server'

const { GET, POST } = createApprovalRoutes({
  authorize: (req) => {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/, '')
    return Boolean(token && isValidToken(token))
  },
})
export { GET, POST }
```

`authorize` runs **before** the body is parsed, so unauthorized callers get a
401 without leaking JSON-parse 400s. When `authorize` is omitted the routes
are fail-open — appropriate only for local development.

### Decision modes (LangGraph HumanInterrupt parity)

The route accepts four decisions matching the LangGraph `HumanInterrupt` /
`HumanResponse` conventions:

```typescript
// accept / approve — proceed with the proposed action as-is
await fetch(`/api/approval/${id}`, {
  method: 'POST',
  body: JSON.stringify({ decision: 'approve' }),
})

// ignore / reject — cancel; transform emits data-error code=approval_rejected
await fetch(`/api/approval/${id}`, {
  method: 'POST',
  body: JSON.stringify({ decision: 'reject' }),
})

// edit — modify the tool args before proceeding; transform rewrites the
// buffered tool-input-start.input before draining
await fetch(`/api/approval/${id}`, {
  method: 'POST',
  body: JSON.stringify({
    decision: 'edit',
    editedInput: { command: 'ls' },
  }),
})

// respond — text reply back to the agent; the tool does NOT execute and the
// transform emits a data-human-response frame for the client to forward to
// the LLM as a new user message
await fetch(`/api/approval/${id}`, {
  method: 'POST',
  body: JSON.stringify({
    decision: 'respond',
    response: 'try a dry run first',
  }),
})
```

Status codes: `200` on resolve, `400` on validation failure (missing or
malformed payload — registry stays at `waiting`), `404` if the approvalId is
unknown / expired, `409` if it was already resolved, `401` if `authorize`
returned false.

The `@deepagents-nextjs/react` package ships a typed `useApprovalResponse`
hook and an `<ApprovalCard>` component that handle all four modes.

### Frame format

When approval is required, the client receives:

```
data: {"type":"data-approval-required","data":{"id":"<uuid>","seq":0,"actionName":"bash_execute","description":"Approval required for bash_execute","arguments":{"command":"echo hi"},"status":"waiting","createdAt":"2026-05-04T...","expiresAt":"2026-05-04T..."}}
```

This frame matches the `ApprovalSchema` from `@deepagents-nextjs/react`.

When a rejection is sent, the stream emits a terminal `data-error` frame:

```
data: {"type":"data-error","data":{"code":"approval_rejected","message":"Tool execution was rejected"}}
```

When the approval expires past `timeoutMs`, the stream emits:

```
data: {"type":"data-error","data":{"code":"approval_timeout","message":"Tool approval expired"}}
```

When a human picks `respond`, the stream emits the reply instead of executing
the tool:

```
data: {"type":"data-human-response","data":{"id":"<approvalId>","seq":N,"response":"try grep -r","createdAt":"..."}}
```

### Pause behavior

While any approval is pending, ALL frames (including text-delta frames emitted concurrently
by the LLM) are buffered and held until the approval resolves. This ensures no partial
output reaches the client while a tool decision is outstanding.

### Default behavior (disabled)

When `approvalGating` is not set on the handler, the adapter behaves identically to
the non-gating path — no `data-approval-required` frames are emitted. This is a
non-breaking addition.

---

## Compatibility

- Node.js 18+
- Next.js 15+
- TypeScript 5.0+

---

## Troubleshooting

**`Error: BACKEND_URL is not set`**

Set the environment variable in `.env.local`:

```
BACKEND_URL=http://localhost:8000/api/chat/stream/
```

**`getCookieToken` returning `undefined`**

Check the cookie name spelling — it must exactly match the cookie sent by the browser. Use DevTools > Application > Cookies to verify.

**DEBUG logs not appearing**

Confirm `DEBUG=deepagents:sse` is set as a server-side env var, not `NEXT_PUBLIC_DEBUG`. Next.js only exposes `NEXT_PUBLIC_*` variables to the browser bundle; server-side vars must be set without that prefix.

---

## Stream Reconnection (Feature Flag)

> **WARNING — ENABLE_STREAM_RECONNECT=true required**
>
> Stream reconnection is **disabled by default** due to open AI SDK bugs:
> - [#6502](https://github.com/vercel/ai/issues/6502): `stop()` does not abort generation when `resume: true` is active
> - [#11865](https://github.com/vercel/ai/issues/11865): tab switching does not trigger reconnection (page reload only)
>
> To opt in, set the environment variable:
> ```
> ENABLE_STREAM_RECONNECT=true
> ```
>
> **Known limitations when enabled:**
> - `stop()` will not abort ongoing generation (bug #6502)
> - Tab switching does not auto-reconnect; use the `retry()` workaround in consumer code via the Page Visibility API
> - The in-memory stream registry is a **reference implementation only** — it does not survive serverless cold starts, horizontal scaling, or Vercel Function invocation boundaries. Replace with Redis for production multi-instance deployments.

### Setup

1. Set `ENABLE_STREAM_RECONNECT=true` in your environment
2. Add a GET resume handler route:

```typescript
// app/api/chat/[resumeId]/stream/route.ts
import { createDeepAgentsResumeHandler } from '@deepagents-nextjs/server';

export const GET = createDeepAgentsResumeHandler();
```

3. The POST handler automatically detects the `X-Resume-Id` header (sent by the React hook when `resumeId` is set) and returns 409 if a stream for that ID is already in progress — preventing duplicate submissions.

### `createDeepAgentsResumeHandler()`

Returns a Next.js App Router `GET` handler for resuming interrupted streams.

| Behavior | Condition |
|----------|-----------|
| 503 | `ENABLE_STREAM_RECONNECT` is not `'true'` |
| 204 | No active stream found for the `resumeId` path param |
| 204 | Stream found but already finished (`done: true`) |

The handler reads `resumeId` from the dynamic route segment `[resumeId]`.

### `isStreamReconnectEnabled()`

```typescript
import { isStreamReconnectEnabled } from '@deepagents-nextjs/server';

// Returns true only when process.env.ENABLE_STREAM_RECONNECT === 'true'
isStreamReconnectEnabled(); // → false by default
```

### In-Memory Stream Registry

The registry (`Map<resumeId, StreamRecord>`) is a module-level singleton stabilised with the `globalThis.__deepagents_stream_registry` pattern (survives Next.js HMR). It includes:

- **Lazy TTL eviction**: entries older than 5 minutes are evicted on lookup
- **Deduplication**: a second POST with the same `resumeId` while the first stream is active returns 409
- **Limitation**: does not persist across serverless cold starts or multiple Node.js processes
