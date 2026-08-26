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
import type { SseFrame, SseTransform } from "./accumulator";

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
  /**
   * Does this RAW upstream frame end the backend's output?
   *
   * Optional, and it can only ever ADD terminals — the handler ORs it with the
   * core check rather than replacing it, so an adapter cannot suppress a
   * terminal the core would have recognised. That direction matters: a missed
   * terminal is a false disconnect (noisy, visible), while a wrongly-suppressed
   * one silences a genuine truncation (silent data loss).
   *
   * It exists because a rung's wire dialect is not the transport's business.
   * The langchain backend closes with `event: message` and no `type` field
   * anywhere, so the core predicate cannot see it; teaching the core about
   * `event: message` would put a rung's vocabulary in the shared layer, which
   * is the coupling adapter-contract.ts was created to undo.
   *
   * EVALUATED ON THE FRAME AS RECEIVED, never on transform output. Truncation
   * is a property of what the backend sent — see handler.ts, and the three
   * drain tests that depend on that invariant.
   */
  readonly isTerminal?: (frame: SseFrame) => boolean;
}
