/**
 * Mock SSE route for the DeepAgents example app.
 *
 * Uses AI SDK v6 streamText + MockLanguageModelV3 to produce a scripted
 * UIMessageStream response — the same format useDeepAgentsChat() consumes.
 *
 * Key behaviors verified:
 *   - Response header: x-vercel-ai-ui-message-stream: v1 (set automatically)
 *   - Chunked delivery: 50ms gap between text deltas (visible with curl -N)
 *   - Message type: AIMessage (streamed text)
 *
 * Reference: replace MockLanguageModelV3 with your real model + connect via
 * createDeepAgentsHandler from @deepagents-nextjs/server for production use.
 */
import { streamText, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

export const dynamic = 'force-dynamic'

export async function POST() {
  const result = streamText({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: new MockLanguageModelV3({
      // doStream is typed against @ai-sdk/provider internals not re-exported from 'ai'.
      // Using satisfies-style cast to match runtime shape without importing private types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream: (async () => ({
        stream: simulateReadableStream({
          // 50ms delay between chunks — proves non-buffering with curl -N
          chunkDelayInMs: 50,
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello! ' },
            { type: 'text-delta', id: 'text-1', delta: 'I am the mock ' },
            { type: 'text-delta', id: 'text-1', delta: 'DeepAgents assistant. ' },
            { type: 'text-delta', id: 'text-1', delta: 'This response streams in ' },
            { type: 'text-delta', id: 'text-1', delta: 'chunk by chunk.' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 0, outputTokens: 6 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
    }),
    prompt: 'mock — input is ignored',
  })

  return result.toUIMessageStreamResponse()
}
