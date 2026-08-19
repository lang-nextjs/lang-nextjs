# @deepagents-nextjs/test-utils

Mock DeepAgents SSE server for vitest unit tests — returns a Response with AI SDK v6 UIMessageStream format.

## Installation

```bash
npm install --save-dev @deepagents-nextjs/test-utils
```

## Quick Start

```typescript
vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(await createMockDeepAgentsServer({ chunkDelayMs: 0 }));
// then call your hook or component
```

## API Reference

### `createMockDeepAgentsServer(options?)`

Returns `Promise<Response>` — a complete mock `Response` object with the AI SDK v6 UIMessageStream format. Pass this to `vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(...)` to intercept `fetch` calls made by `useDeepAgentsChat`.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunkDelayMs` | `number` | `50` | Delay between stream chunks in milliseconds. **Set to `0` in tests** to avoid slow test suites. |
| `chunks` | `Array<Record<string, unknown>>` | See below | Custom chunk array. Defaults to `"Hello! I am the mock DeepAgents assistant."` split into `text-start`, `text-delta` (x2), `text-end`, and `finish` frames. |

**Response headers:**

The returned `Response` includes:
- `Content-Type: text/event-stream`
- `x-vercel-ai-ui-message-stream: v1` — required by `useDeepAgentsChat` to select AI SDK v6 UIMessageStream parsing

**Default chunk sequence:**

```typescript
[
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello! ' },
  { type: 'text-delta', id: 'text-1', delta: 'I am the mock DeepAgents assistant.' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 5 } },
]
```

---

### Usage Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeepAgentsChat } from '@deepagents-nextjs/react';
import { createMockDeepAgentsServer } from '@deepagents-nextjs/test-utils';

describe('useDeepAgentsChat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('accumulates messages from SSE stream', async () => {
    const mockResponse = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: 'test-1', endpoint: '/api/chat/stream' })
    );

    await act(async () => {
      result.current.sendMessage('hello');
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(result.current.status).toBe('idle');
  });
});
```

---

## Compatibility

- vitest 3.0+
- Node.js 18+

---

## Troubleshooting

**Tests are slow**

Set `chunkDelayMs: 0`. The default is 50ms per chunk — with multiple chunks per response this adds up quickly across a test suite.

```typescript
await createMockDeepAgentsServer({ chunkDelayMs: 0 });
```

**Mock not intercepting fetch**

Call `vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(...)` **before** the hook renders or `sendMessage` is called. The spy must be in place before `fetch` is invoked.

**Multiple test failures leaking between tests**

Add `vi.restoreAllMocks()` in `beforeEach` to clear the fetch spy between tests:

```typescript
beforeEach(() => {
  vi.restoreAllMocks();
});
```
