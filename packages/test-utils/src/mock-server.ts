/**
 * createMockDeepAgentsServer — test utility for @deepagents-nextjs consumer suites.
 *
 * Extracted from apps/example/app/api/chat/stream/route.mock.ts.
 * Returns a Next.js Response with an AI SDK v6 UIMessageStream body — the same
 * format useDeepAgentsChat() consumes — without a real DeepAgents backend.
 *
 * Usage in test suites:
 *   const response = await createMockDeepAgentsServer()
 *   expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
 */
import { streamText, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

export interface MockDeepAgentsServerOptions {
  /** Delay between stream chunks in milliseconds. Default: 50. Set to 0 for fast tests. */
  chunkDelayMs?: number
  /** Custom chunks to stream. Defaults to a fixed "Hello! I am the mock assistant." response. */
  chunks?: Array<Record<string, unknown>>
}

export async function createMockDeepAgentsServer(
  opts?: MockDeepAgentsServerOptions,
): Promise<Response> {
  const chunkDelayMs = opts?.chunkDelayMs ?? 50
  const chunks = opts?.chunks ?? [
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'Hello! ' },
    { type: 'text-delta', id: 'text-1', delta: 'I am the mock DeepAgents assistant.' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 5 },
    },
  ]

  const result = streamText({
    model: new MockLanguageModelV3({
      doStream: (async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: chunkDelayMs,
          chunks: chunks as any,
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      })) as any,
    }),
    prompt: 'mock — input is ignored',
  })

  return result.toUIMessageStreamResponse()
}
