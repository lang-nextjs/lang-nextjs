/**
 * LangGraph Platform astream_events v2 on_tool_start/on_tool_end → AI SDK v6 adapter.
 *
 * Maps LangGraph Platform event frames:
 *   - on_tool_start  → tool-input-start  (AI SDK v6)
 *   - on_tool_end    → tool-output-available (AI SDK v6)
 *   - on_chat_model_stream → text-delta (inherited from langGraphAdapter pattern)
 *
 * Key design decisions:
 *   - Stateless adapter: `openSweAdapter.transforms` is a getter that returns fresh
 *     `createOpenSweTransform()` instances on each access, preventing inter-request
 *     state leakage. All state lives in the closure created by `createOpenSweTransform()`.
 *   - toolCallId format: `${run_id}--${toolName}-${counter}` (e.g. "run-abc--bash_execute-0").
 *     Counter increments per (run_id, toolName) pair; deterministic and human-readable.
 *   - LIFO queue pairing for same-tool parallel calls: pendingToolCallIds uses pop() on end
 *     events so that the most-recently-started tool call of a given name is paired to the
 *     most-recently-arrived end event. This correctly buffers reversed-arrival ends for the
 *     reorder buffer to handle ordering enforcement.
 *   - Reorder buffer: maintains `startOrder` (FIFO list of started toolCallIds) and
 *     `endBuffer` (map of buffered, not-yet-emittable end frames). End events are emitted
 *     only when they match the head of `startOrder`; others are buffered until unblocked.
 *   - Single-frame-per-call contract: SseTransform returns SseFrame | null (one frame).
 *     When multiple frames are unblocked at once (drain), extras go into `readyQueue`.
 *     The next transform call pops from readyQueue first before processing new input.
 */

import { createScopeRegistry } from "./checkpoint-ns";
import type { SseFrame, SseTransform, SseMultiTransform } from "../accumulator";
import type { SseAdapter } from "../adapter-contract";
import { createOpenSweEnrichTransform } from "./openSweEnrich";

/**
 * LangGraph Platform astream_events v2 frame shape.
 * The discriminant field is `event` (NOT `type`).
 */
type LangGraphEvent = {
  event: string;
  name: string;
  run_id: string;
  data: Record<string, unknown>;
  /**
   * Present on every event, including tools inside UNREGISTERED subgraphs — those do emit
   * on_tool_start/on_tool_end with no opt-in. `metadata.checkpoint_ns` is the only reliable
   * nesting key: `parent_ids` is null on every frame, and `streamSubgraphs` governs
   * `.stream()`, not `streamEvents`. (Issue #38.)
   */
  metadata?: { checkpoint_ns?: string };
};

/**
 * Factory that returns a fresh stateful SseTransform closure.
 *
 * Per-closure state:
 *   - toolCallCounters: run_id → (toolName → call count)
 *   - pendingToolCallIds: `${run_id}--${toolName}` → stack of generated toolCallIds
 *     (LIFO stack — push on start, pop on end — correctly handles reversed-arrival ends
 *     for same-tool parallel calls when combined with the reorder buffer)
 *   - startOrder: ordered list of started toolCallIds (head = oldest unfinished)
 *   - endBuffer: buffered end-event frames keyed by toolCallId (awaiting emission)
 *
 * Multi-frame output: when one end-event unblocks several buffered ends, the
 * transform returns them as an `SseFrame[]` in a single call (the pipeline
 * flattens arrays). An earlier readyQueue design returned one frame and stashed
 * the rest for the *next* call — which swallowed the next live input frame and
 * stranded the tail when the unblocking end was the final frame. Returning an
 * array has neither hazard.
 */
export function createOpenSweTransform(): SseMultiTransform {
  const toolCallCounters = new Map<string, Map<string, number>>();
  const pendingToolCallIds = new Map<string, string[]>();
  // Reorder state is partitioned BY run_id. Emission order is only causally
  // meaningful within a single run; a `task` sub-agent runs its tools under a
  // different run_id, so a GLOBAL startOrder would block (or permanently strand)
  // an independent run's completed end behind another run's still-open start.
  // Per-run ordering removes that head-of-line coupling.
  const startOrderByRun = new Map<string, string[]>();
  const endBuffer = new Map<string, SseFrame>();
  // Last successfully-emitted toolCallId per `${run_id}--${toolName}` key.
  // If a repeat on_tool_end arrives for an already-drained key (the queue was
  // popped on the first call) but the upstream still emits a duplicate (a
  // buggy backend, a retry, a proxy re-send), fall back to the cached id so
  // the transform remains idempotent — the consumer sees a tool-output-
  // available frame instead of a silent null drop.
  const lastEmittedToolCallIdByKey = new Map<string, string>();
  // Per-stream scope registry — mints the stable scopeIds carried on FrameAttribution.
  const attributionFor = createScopeRegistry();

  return function openSweTransform(
    frame: SseFrame
  ): SseFrame | SseFrame[] | null {
    const line = frame.raw;

    // Extract the `data:` payload. LangGraph emits SSE frames two ways:
    //   • create-stream (POST .../runs/stream): bare `data: {…}` (one line)
    //   • join-stream   (GET  .../runs/{id}/stream): `event: events\ndata: {…}`
    // The run page uses the join-stream, so a frame may carry an `event:` line
    // before the `data:` line. Find the data line either way; frames with no
    // data payload (comments, lone event lines) pass through unchanged.
    // Always scan lines for the `data:` payload. A frame may be a bare
    // `data: {…}`, a join-stream `event: events\ndata: {…}`, OR a `data: {…}`
    // followed by other SSE field lines (`id:`/`retry:`). Taking the whole
    // frame in the bare case would fold a trailing field line into the JSON and
    // break the parse, leaking the frame raw — so extract the line either way.
    const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine === undefined) return frame;

    const raw = dataLine.slice(6);

    // Pass [DONE] through unchanged — stream terminator
    if (raw === "[DONE]") return frame;

    let parsed: LangGraphEvent;
    try {
      parsed = JSON.parse(raw) as LangGraphEvent;
    } catch {
      // Non-JSON data — pass through unchanged, never throw
      return frame;
    }

    // Valid JSON that isn't an object — e.g. `data: null`, `data: 42`,
    // `data: "x"` — does NOT throw above, so guard before property access or it
    // crashes the stream on untrusted input.
    if (parsed === null || typeof parsed !== "object") return frame;

    // If no event discriminant field, pass through unchanged
    if (!parsed.event) return frame;

    switch (parsed.event) {
      case "on_chat_model_stream": {
        // Inherited from langGraphAdapter: extract text content and emit text-delta
        const chunk = (parsed.data?.chunk as Record<string, unknown>) ?? {};
        const content = chunk.content;
        // `!content` would let whitespace-only strings (" ", "\n", "  \t") slip
        // through as text-delta frames — the AI SDK then surfaces a visible
        // blank/space delta that pads the message and triggers spurious chunk
        // notifications for content the user sees as nothing. Drop these too.
        if (typeof content !== "string" || !content.trim()) return null;
        return {
          raw: `data: ${JSON.stringify({
            type: "text-delta",
            delta: content,
          })}`,
        };
      }

      case "on_tool_start": {
        const toolName = parsed.name;
        const run_id = parsed.run_id;
        const input = (parsed.data?.input as Record<string, unknown>) ?? {};

        // Get or init counter map for this run_id
        if (!toolCallCounters.has(run_id)) {
          toolCallCounters.set(run_id, new Map<string, number>());
        }
        const countersForRun = toolCallCounters.get(run_id)!;
        const count = countersForRun.get(toolName) ?? 0;
        const toolCallId = `${run_id}--${toolName}-${count}`;
        countersForRun.set(toolName, count + 1);

        // Push toolCallId onto the stack for this (run_id, toolName) pair.
        // pop() on end events means the most-recently-started call pairs first,
        // which enables the reorder buffer to enforce correct emission order.
        const queueKey = `${run_id}--${toolName}`;
        const queue = pendingToolCallIds.get(queueKey) ?? [];
        queue.push(toolCallId);
        pendingToolCallIds.set(queueKey, queue);

        // Record start order within this run (for the reorder buffer).
        const startOrder = startOrderByRun.get(run_id) ?? [];
        startOrder.push(toolCallId);
        startOrderByRun.set(run_id, startOrder);

        return {
          raw: `data: ${JSON.stringify({
            type: "tool-input-start",
            toolCallId,
            toolName,
            input,
          })}`,
          // Out-of-band: NEVER serialized onto this frame. AI SDK v6 parses standard frames
          // with strictObject and rejects unknown fields — putting the namespace in the JSON
          // above would break every client. The enrich stage copies it onto data-* parts,
          // which are user-defined and safe to extend.
          attribution: attributionFor(parsed.metadata?.checkpoint_ns),
        };
      }

      case "on_tool_end": {
        const toolName = parsed.name;
        const run_id = parsed.run_id;
        const output = parsed.data?.output ?? null;

        // Retrieve toolCallId from the stack via pop().
        // pop() pairs the most-recently-started call to this end event, enabling the
        // reorder buffer to buffer reversed-arrival ends correctly.
        const queueKey = `${run_id}--${toolName}`;
        let toolCallId = pendingToolCallIds.get(queueKey)?.pop();
        if (toolCallId === undefined) {
          // Repeat end for an already-drained key (duplicate upstream event,
          // proxy re-send, retry). Fall back to the last successfully-emitted
          // toolCallId for this key so the transform remains idempotent —
          // the consumer still receives a tool-output-available frame rather
          // than a silent null drop. If we've never emitted for this key, drop
          // (genuine orphan end with no matching start).
          const cached = lastEmittedToolCallIdByKey.get(queueKey);
          if (cached === undefined) return null;
          toolCallId = cached;
        } else {
          lastEmittedToolCallIdByKey.set(queueKey, toolCallId);
        }

        // `JSON.stringify` throws `TypeError: Converting circular structure to
        // JSON` if `output` (a tool's return value) carries a self-reference
        // — a proxied object, a backend that includes itself in its result,
        // or any untrusted-misbehaving-model scenario. Wrapping stringify in
        // try/catch with a sentinel-string fallback mirrors the langgraph
        // adapter's hardening and preserves the contract: the transform never
        // throws, and the tool-output-available frame's `output` field is
        // ALWAYS a string AND ALWAYS wrapped in valid JSON (the SSE consumer
        // expects to JSON.parse the data: payload, so a fallback like
        // `String(circular)` returning "[object Object]" would break parsing).
        const safeStringifyOutputEnvelope = (): string => {
          try {
            return JSON.stringify({
              type: "tool-output-available",
              toolCallId,
              output,
            });
          } catch {
            // Circular or otherwise unserializable. Emit a valid envelope with
            // the output replaced by a string sentinel. The consumer still
            // sees a well-formed JSON object with type=tool-output-available.
            return JSON.stringify({
              type: "tool-output-available",
              toolCallId,
              output: "<unserializable>",
            });
          }
        };

        const outputFrame: SseFrame = {
          raw: `data: ${safeStringifyOutputEnvelope()}`,
          attribution: attributionFor(parsed.metadata?.checkpoint_ns),
        };

        // Reorder logic operates within this run only: emit if this end matches
        // the head of the run's startOrder; otherwise buffer it.
        const startOrder = startOrderByRun.get(run_id) ?? [];
        // Once the startOrder is empty (every start for this run has been
        // paired), there is no ordering constraint left — the end is an
        // orphan and must still reach the client. Same applies to the
        // idempotent-repeat path (cached toolCallId replayed after the queue
        // was drained): the reorder buffer's purpose is to keep ends in
        // start order WHILE starts are pending, not to suppress duplicates
        // once everything is flushed.
        if (startOrder[0] === toolCallId || startOrder.length === 0) {
          // This is the expected next end event — emit it and drain buffer
          // (or: the startOrder is empty so this is a free-standing end).
          startOrder.shift();
          const framesToEmit: SseFrame[] = [outputFrame];

          // Drain any buffered ends that are now unblocked (next in start order)
          while (startOrder.length > 0 && endBuffer.has(startOrder[0])) {
            const nextId = startOrder.shift()!;
            framesToEmit.push(endBuffer.get(nextId)!);
            endBuffer.delete(nextId);
          }

          // Emit all unblocked frames in this single call (the pipeline
          // flattens arrays). Order is preserved: this end first, then the
          // buffered ends drained in start order.
          return framesToEmit.length === 1 ? framesToEmit[0]! : framesToEmit;
        } else {
          // Out-of-order end event — buffer it until its predecessor arrives
          endBuffer.set(toolCallId, outputFrame);
          return null;
        }
      }

      default:
        return null;
    }
  };
}

/**
 * openSweAdapter: maps LangGraph Platform on_tool_start/on_tool_end events to AI SDK v6
 * tool frame types. Implements reorder buffer and stack-based toolCallId pairing for
 * correct ordering even when end events arrive out-of-order.
 *
 * The `transforms` property is a getter — each access returns fresh instances,
 * ensuring each HTTP request gets independent per-request state.
 */
export const openSweAdapter: SseAdapter = {
  name: "open-swe",
  get transforms(): SseTransform[] {
    // Stage 1 normalizes LangGraph tool events → AI SDK v6 tool frames.
    // Stage 2 fans out DeepAgents `data-*` parts (plan/file/sub-agent/approval)
    // from those normalized frames, preserving the tool frame for ToolCard.
    // Both stages are SseMultiTransform (may return SseFrame[]); the handler's
    // applyTransforms consumes them as such. The casts satisfy the
    // SseAdapter.transforms element type without widening the shared interface.
    return [
      createOpenSweTransform() as unknown as SseTransform,
      createOpenSweEnrichTransform() as unknown as SseTransform,
    ];
  },
} as const;
