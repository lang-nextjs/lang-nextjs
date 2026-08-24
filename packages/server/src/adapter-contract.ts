/**
 * The adapter contract. CORE — depends on no rung, and every rung depends on it.
 *
 * This interface lived inside adapters/deepagents.ts until 2026-08-24, which made the
 * DeepAgents rung load-bearing for code that had nothing to do with DeepAgents:
 *
 *   - handler.ts (transport core) imported it to type its `adapter` option
 *   - langchain.ts, langgraph.ts and openSwe.ts each imported it from "./deepagents"
 *
 * So deleting the DeepAgents rung broke the transport core AND the three sibling rungs that
 * merely happened to implement the same interface. An interface every rung implements
 * cannot live inside one rung. See issue #17.
 */
import type { SseTransform } from "./accumulator";

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
  readonly name: string;
  readonly transforms: SseTransform[];
}
