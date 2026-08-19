# Testing with createMockDeepAgentsServer

This guide shows how to write unit tests for components that use any deepagents-nextjs hook.
No backend server is needed — `createMockDeepAgentsServer()` from `@deepagents-nextjs/test-utils`
returns a complete mock Response with AI SDK v6 UIMessageStream format.

## Installation

```bash
npm install --save-dev @deepagents-nextjs/test-utils vitest jsdom @testing-library/react
```

## Setup

Create `vitest.config.ts` in your app:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

## Basic Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeepAgentsChat } from '@deepagents-nextjs/react';
import { createMockDeepAgentsServer } from '@deepagents-nextjs/test-utils';

describe('useDeepAgentsChat', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // Clean up fetch spy between tests
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

## Key Tips

- **Always set `chunkDelayMs: 0`** — the default is 50ms per chunk, which makes tests slow.
- **Call `vi.spyOn` before calling the hook** — the spy must be in place before `fetch` is called.
- **Add `vi.restoreAllMocks()` in `beforeEach`** — prevents fetch spy from leaking between tests.
- **Use `jsdom` environment** — hooks use React and DOM APIs.

## Custom Chunks

Pass custom chunk arrays to test specific message sequences:

```typescript
const mockResponse = await createMockDeepAgentsServer({
  chunkDelayMs: 0,
  chunks: [
    { type: 'text-start', messageId: 'msg-1' },
    { type: 'text-delta', textDelta: 'Hello' },
    { type: 'text-end', messageId: 'msg-1' },
    { type: 'finish', finishReason: 'stop' },
  ],
});
```

## Error Handling

```typescript
vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
// ... after act:
expect(result.current.status).toBe('error');
expect(result.current.error).toBeInstanceOf(Error);
```

## Full Example

See [apps/example/example.test.ts](../apps/example/example.test.ts) for a complete working example.
