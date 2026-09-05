# @deepagents-nextjs/sveltekit

SvelteKit handler and reactive Svelte store for DeepAgents SSE streaming.

## Installation

```bash
npm install @deepagents-nextjs/sveltekit
```

## Quick Start

**`src/routes/api/chat/stream/+server.ts`** (server-side):

```typescript
import { createDeepAgentsHandler } from "@deepagents-nextjs/sveltekit";
export const POST = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL!,
});
```

**`src/routes/+page.svelte`** (client-side):

```svelte
<script lang="ts">
  import { createDeepAgentsStore } from '@deepagents-nextjs/sveltekit';
  import { readable } from 'svelte/store';
  import type { Readable } from 'svelte/store';
  import type { DeepAgentsState } from '@deepagents-nextjs/sveltekit';

  const idle: DeepAgentsState = { messages: [], status: 'idle', error: null };
  let chat: Readable<DeepAgentsState> = readable(idle);
  let started = false;

  function start() {
    if (started) return;
    started = true;
    chat = createDeepAgentsStore('/api/chat/stream', { sessionId: 'session-1' });
  }
</script>

{#each $chat.messages as msg}
  <p>{JSON.stringify(msg)}</p>
{/each}

<button on:click={start} disabled={started}>Start chat</button>
```

> **Note:** `createDeepAgentsStore` returns a `Readable<DeepAgentsState>` — subscribing triggers the fetch. Use the lazy-init pattern above (create store on click) if you want on-demand control.

## API Reference

### `createDeepAgentsHandler(options)`

Creates a SvelteKit `POST` handler for `+server.ts` that proxies SSE streams from a DeepAgents backend. Requires Node.js runtime (see Runtime Requirement below).

**Important:** The SvelteKit handler is a **clean proxy** — it applies **no default adapter** unlike the Next.js `@deepagents-nextjs/server` package. Pass an adapter explicitly if backend normalization is needed.

| Option       | Type                                                                                           | Required | Description                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `backendUrl` | `string`                                                                                       | yes      | URL of the DeepAgents backend SSE endpoint                                     |
| `adapter`    | `SseAdapter`                                                                                   | no       | Named adapter bundle. No default — pass explicitly if normalization is needed. |
| `getToken`   | `(event: RequestEvent) => Promise<string \| null \| undefined> \| string \| null \| undefined` | no       | Optional token provider. Receives the SvelteKit `RequestEvent`.                |
| `transforms` | `SseTransform[]`                                                                               | no       | Additional transforms appended after `adapter.transforms`.                     |
| `retry`      | `{ maxRetries?: number; initialDelayMs?: number }`                                             | no       | Retry policy for connection-level fetch failures.                              |

**Exported types:** `SvelteKitHandlerOptions`, `SseFrame`, `SseTransform`, `SseAdapter`

**Use in `+server.ts` only** — this is a server-side export that runs Node.js-specific APIs.

---

### `createDeepAgentsStore(endpoint, options?)`

Creates a reactive `Readable<DeepAgentsState>` Svelte store that streams messages from the DeepAgents proxy endpoint. Use in `+page.svelte` or other client-side Svelte components.

```typescript
const chat = createDeepAgentsStore("/api/chat/stream", {
  sessionId: "abc-123",
  body: { extra: "payload" },
});
```

**Parameters:**

| Parameter  | Type                                                     | Description                                         |
| ---------- | -------------------------------------------------------- | --------------------------------------------------- |
| `endpoint` | `string`                                                 | URL of the SvelteKit SSE proxy route                |
| `options`  | `{ sessionId?: string; body?: Record<string, unknown> }` | Optional session ID and additional POST body fields |

**Returns:** `Readable<DeepAgentsState>`

**`DeepAgentsState` shape:**

| Field      | Type                                                      | Description               |
| ---------- | --------------------------------------------------------- | ------------------------- |
| `messages` | `unknown[]`                                               | Accumulated stream frames |
| `status`   | `'idle' \| 'loading' \| 'streaming' \| 'done' \| 'error'` | Current stream state      |
| `error`    | `Error \| null`                                           | Last error, if any        |

To start streaming, subscribe to the store — streaming begins on the first subscriber and stops on the last unsubscribe.

**Use in `+page.svelte` or client-side code only** — this store calls `fetch` which requires a browser or jsdom environment.

---

## Important Notes

### HMR Port

When running in a monorepo dev environment, SvelteKit and other frameworks can conflict on the default HMR WebSocket port. Add a unique port to avoid `EADDRINUSE`:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    hmr: { port: 24679 },
  },
});
```

### Runtime Requirement

`createDeepAgentsHandler` calls `assertNodeRuntime()` inside the handler body (not at module load time). The check fires at request time — safe to import in any environment, but the handler will throw if called outside Node.js.

Cloudflare Workers and other edge runtimes are **not supported** in v1.2. Use `@sveltejs/adapter-node` for deployment. Edge runtime support is planned for `@deepagents-nextjs/edge`.

---

## Compatibility

- SvelteKit 2.0+
- Node.js 18+
- TypeScript 5.0+

---

## Troubleshooting

**`assertNodeRuntime()` error at request time**

The handler must run in a Node.js server environment. Edge runtimes (Cloudflare Workers, Deno Deploy with `--no-node` flag) are not supported. Ensure your SvelteKit app uses `@sveltejs/adapter-node`.

**Store not updating**

Check that `sessionId` is unique per conversation. Reusing a session ID may cause the backend to return a cached/stale stream.

**EADDRINUSE in monorepo dev**

Set a unique HMR port in `vite.config.ts` (see HMR Port note above). The default port conflicts with other Vite-based apps in the same monorepo.
