# @deepagents-nextjs/remix

Remix action handler and streaming hook for DeepAgents SSE streaming using native fetch.

## Installation

```bash
npm install @deepagents-nextjs/remix
```

## Quick Start

**`app/routes/api.chat.stream.ts`** (server-side action):

```typescript
import { createDeepAgentsHandler } from '@deepagents-nextjs/remix';
export const action = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! });
```

**`app/routes/_index.tsx`** (client-side hook):

```typescript
import { useDeepAgentsChat } from '@deepagents-nextjs/remix';
const { messages, status, start } = useDeepAgentsChat('/api/chat/stream');
```

## API Reference

### `createDeepAgentsHandler(options)`

Creates a Remix action handler that proxies SSE streams from a DeepAgents backend. Export as `action` from a Remix route file.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `backendUrl` | `string` | yes | URL of the DeepAgents backend SSE endpoint |
| `adapter` | `SseAdapter` | no | Named adapter bundle for backend normalization. No default. |
| `getToken` | `(args: ActionFunctionArgs) => Promise<string \| null \| undefined> \| string \| null \| undefined` | no | Optional token provider. Receives Remix `ActionFunctionArgs`. |
| `transforms` | `SseTransform[]` | no | Additional transforms appended after `adapter.transforms`. |
| `retry` | `{ maxRetries?: number; initialDelayMs?: number }` | no | Retry policy for connection-level fetch failures. |

**Exported types:** `RemixHandlerOptions`, `SseFrame`, `SseTransform`, `SseAdapter`

---

### `useDeepAgentsChat(endpoint, options?)`

React hook that streams messages from the DeepAgents proxy endpoint using native `fetch()` and a `ReadableStream` reader loop.

```typescript
const { messages, status, start } = useDeepAgentsChat('/api/chat/stream', {
  sessionId: 'abc-123',
  body: { extra: 'payload' },
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `endpoint` | `string` | URL of the Remix action route |
| `options` | `{ sessionId?: string; body?: Record<string, unknown> }` | Optional session ID and additional POST body fields |

**Returns `DeepAgentsChatResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `unknown[]` | Accumulated stream frames |
| `status` | `'idle' \| 'loading' \| 'streaming' \| 'done' \| 'error'` | Current stream state |
| `error` | `Error \| null` | Last error, if any |
| `start` | `() => void` | Imperative function to initiate the stream |

**Use `start()` to begin streaming** — unlike `@deepagents-nextjs/react`, this hook does not accept a message string. Call `start()` to trigger the SSE fetch.

---

### `DeepAgentsChatResult` (exported type)

The return type of `useDeepAgentsChat` is exported as a named type so consumers can type component props without re-declaring the intersection:

```typescript
import type { DeepAgentsChatResult } from '@deepagents-nextjs/remix';

function ChatPanel({ chat }: { chat: DeepAgentsChatResult }) {
  return <button onClick={chat.start}>Start</button>;
}
```

---

## Important Notes

### Native fetch, not `useFetcher`

The hook uses `fetch()` + `ReadableStream` reader loop internally — **not** `useFetcher`. This is intentional: Remix's `useFetcher` buffers the complete response before returning it and cannot stream SSE incrementally. Do not attempt to replace this hook with `useFetcher`.

### pnpm Hoisting

If you encounter module resolution errors in Vite (e.g., multiple React instances or AI SDK version conflicts), add `resolve.dedupe` to your Vite config:

```typescript
// vite.config.ts
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', 'ai'],
  },
});
```

### HMR Port

When running in a monorepo dev environment, set a unique HMR WebSocket port to avoid `EADDRINUSE` conflicts with other Vite-based apps:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    hmr: { port: 24680 },
  },
});
```

---

## Compatibility

- Remix 2.0+
- React 18+
- Node.js 18+
- TypeScript 5.0+

---

## Troubleshooting

**Messages not updating after calling `start()`**

Check the `status` field transitions: `idle` → `loading` → `streaming` → `done`. If status stays `loading`, the backend may not be sending any data. If status jumps to `error`, check `error.message` for details.

**Note:** This hook exposes `start()` as the imperative trigger — there is no text input. Call `start()` to initiate the stream fetch.

**Module resolution error in Vite**

Add `resolve.dedupe: ['react', 'react-dom', 'ai']` to `vite.config.ts` (see pnpm Hoisting note above).

**Handler returns 503**

`BACKEND_URL` is not set. Set it in your `.env` file:

```
BACKEND_URL=http://localhost:8000/api/chat/stream/
```
