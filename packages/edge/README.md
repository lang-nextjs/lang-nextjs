# @deepagents-nextjs/edge

Edge runtime handlers for Deno Deploy and Cloudflare Workers — same two-line setup, Web Streams only.

## Install

```bash
npm install @deepagents-nextjs/edge
```

> **Note:** ESM-only package. Requires Node.js 18+ for local development; Deno Deploy or Cloudflare Workers for production.

## Quick Start — Deno Deploy

```typescript
import { createDenoHandler } from '@deepagents-nextjs/edge';
import { deepagentsAdapter } from '@deepagents-nextjs/server';

const handler = createDenoHandler({
  backendUrl: Deno.env.get('BACKEND_URL')!,
  adapter: deepagentsAdapter,
});

Deno.serve({ port: 3000 }, handler);
```

## Quick Start — Cloudflare Workers

> **EXPERIMENTAL** — see [Cloudflare SSE Buffering Caveat](#cloudflare-sse-buffering-caveat) before using in production.

```typescript
import { createCloudflareHandler } from '@deepagents-nextjs/edge';
import { deepagentsAdapter } from '@deepagents-nextjs/server';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handler = createCloudflareHandler({
      backendUrl: env.BACKEND_URL as string,
      adapter: deepagentsAdapter,
    });
    return handler(request);
  },
};
```

## Cloudflare SSE Buffering Caveat

> **Warning:** Cloudflare Workers may buffer the full SSE response before delivering it to the client, resulting in **TTFB > 10 seconds** for typical AI streaming responses. This is a [known Cloudflare Workers limitation](https://github.com/mastra-ai/mastra/issues/13584) confirmed in February 2026.
>
> **Recommendation:** Use `createDenoHandler` with Deno Deploy as your primary edge target for streaming AI workloads. Cloudflare Workers support is marked **EXPERIMENTAL** until this buffering issue is resolved or Cloudflare provides an official workaround.
>
> If TTFB > 5s is measured in your `wrangler dev` preview, mark your deployment with an appropriate user-facing caveat.

## Cloudflare Worker Tier Requirements

Cloudflare Workers have resource limits that may affect long-running AI streams:

- **Memory limit:** 128MB per Worker invocation.
- **CPU time limit:** 30 seconds on the free tier (longer on paid plans — see [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for details).
- **TTFB caveat:** ~10s buffering delay applies due to SSE buffering (see [Cloudflare SSE Buffering Caveat](#cloudflare-sse-buffering-caveat) above).

When running long-running agent streams, your stream may exceed the Worker's CPU limit and be forcibly terminated by Cloudflare with no usable error message. To get a clean, recoverable error instead:

**Set `streamTimeoutMs` below your tier's CPU limit.** For example, on the free tier use `streamTimeoutMs: 25000` (25 seconds) to abort before the 30-second limit and return a clean HTTP 504 response instead of a cryptic Worker termination.

## API Reference

### createDenoHandler(options)

Returns `(request: Request) => Promise<Response>`. Suitable for `Deno.serve({ port }, handler)`.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `backendUrl` | `string` | Yes | DeepAgents backend URL to proxy |
| `adapter` | `SseAdapter` | No | Adapter bundle (e.g. `deepagentsAdapter`) |
| `transforms` | `SseTransform[]` | No | Additional transform functions |
| `getToken` | `(req: Request) => string \| null \| undefined \| Promise<...>` | No | Token getter for Bearer auth injection |

**Behavior:**
- Returns 503 if `backendUrl` is empty.
- Returns 502 if backend fetch fails.
- Forwards `x-vercel-ai-ui-message-stream` header from backend.
- Does NOT forward hop-by-hop headers (host, content-length, transfer-encoding, connection).

---

### createCloudflareHandler(options)

**EXPERIMENTAL** — See [Cloudflare SSE Buffering Caveat](#cloudflare-sse-buffering-caveat).

Same options as `createDenoHandler`. Additional options:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `backendUrl` | `string` | Yes | DeepAgents backend URL to proxy |
| `adapter` | `SseAdapter` | No | Adapter bundle (e.g. `deepagentsAdapter`) |
| `transforms` | `SseTransform[]` | No | Additional transform functions |
| `getToken` | `(req: Request) => string \| null \| undefined \| Promise<...>` | No | Token getter for Bearer auth injection |
| `env` | `Record<string, unknown>` | No | Cloudflare bindings env object (for reference; extract `backendUrl` before calling factory) |
| `streamTimeoutMs` | `number` | No | Max total stream duration (ms). Returns 504 on pre-stream timeout, errors the stream mid-stream. Recommended below the Worker CPU limit (30s free tier). |

---

## Environment Variables

| Variable | Handler | Description |
|----------|---------|-------------|
| `BACKEND_URL` (via `Deno.env.get()`) | Deno Deploy | DeepAgents backend URL |
| `BACKEND_URL` (via wrangler.toml `[vars]`) | Cloudflare Workers | DeepAgents backend URL |

## Troubleshooting

**"BACKEND_URL not configured" (503)**

Set `BACKEND_URL` in your Deno Deploy config or wrangler.toml `[vars]` section.

**Cloudflare TTFB > 10s**

Expected with current Cloudflare Workers SSE buffering. Use Deno Deploy instead. See [Cloudflare SSE Buffering Caveat](#cloudflare-sse-buffering-caveat).

**Stream cut off / Worker terminated unexpectedly**

Your stream likely exceeded the Cloudflare Worker CPU limit. Set `streamTimeoutMs` to get a clean 504 instead, and see [Cloudflare Worker Tier Requirements](#cloudflare-worker-tier-requirements).

**"Cannot import @deepagents-nextjs/edge in a CJS project"**

This package is ESM-only. Ensure your project uses `"type": "module"` or import via dynamic `import()`.

## Compatibility

- Node.js 18+ (local development)
- Deno Deploy (recommended for production streaming)
- Cloudflare Workers (EXPERIMENTAL — TTFB caveat applies)
- TypeScript 5.0+
