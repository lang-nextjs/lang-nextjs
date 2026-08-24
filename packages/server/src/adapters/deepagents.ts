import { stripMessageIdTransform } from '../transforms'
import type { SseAdapter } from '../adapter-contract'

// Re-exported so existing importers of this path keep working; the interface itself now
// lives in ../adapter-contract because every rung implements it. See issue #17.
export type { SseAdapter } from '../adapter-contract'


/**
 * Default adapter for DeepAgents Django/FastAPI backends.
 * Strips messageId from finish events (AI SDK v6 strictObject rejects extra fields).
 * Applied automatically when no adapter is passed to createDeepAgentsHandler.
 */
export const deepagentsAdapter: SseAdapter = {
  name: 'deepagents',
  transforms: [stripMessageIdTransform],
} as const
