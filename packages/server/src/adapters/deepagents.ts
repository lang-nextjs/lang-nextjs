import type { SseTransform } from '../accumulator'
import { stripMessageIdTransform } from '../transforms'

/**
 * Adapter interface: a named bundle of SSE transforms for a specific backend format.
 * Pipeline order: [...adapter.transforms, ...options.transforms]
 * Adapter transforms run first; user transforms extend or override after.
 *
 * Declared as `SseTransform[]` for the common one-in-one-out case. The handler's
 * `applyTransforms` actually consumes them as `SseMultiTransform` (a transform
 * may fan out to `SseFrame[]`), so an adapter that needs multi-frame output —
 * e.g. open-swe's enrichment transform, which emits a `data-*` part next to each
 * tool frame — casts that transform to `SseTransform` at the array literal.
 */
export interface SseAdapter {
  readonly name: string
  readonly transforms: SseTransform[]
}

/**
 * Default adapter for DeepAgents Django/FastAPI backends.
 * Strips messageId from finish events (AI SDK v6 strictObject rejects extra fields).
 * Applied automatically when no adapter is passed to createDeepAgentsHandler.
 */
export const deepagentsAdapter: SseAdapter = {
  name: 'deepagents',
  transforms: [stripMessageIdTransform],
} as const
