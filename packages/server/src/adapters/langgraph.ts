/**
 * LangGraph astream_events v2 → AI SDK v6 adapter.
 *
 * Normalizes LangGraph event frames (on_chat_model_stream, on_tool_start,
 * on_tool_end, etc.) to AI SDK v6 wire format (text-delta, tool-input-available,
 * tool-output-available).
 *
 * Fixture ground truth: packages/server/src/__fixtures__/langgraph-astream-events-v2.json
 * Distinct event types covered by the fixture:
 *   on_chain_start, on_chain_end, on_chain_stream,
 *   on_chat_model_start, on_chat_model_end, on_chat_model_stream,
 *   on_tool_start, on_tool_end
 */

import { createScopeRegistry } from "./checkpoint-ns";
import type { FrameAttribution, SseFrame, SseTransform } from "../accumulator";
import type { SseAdapter } from "../adapter-contract";

/**
 * LangGraph astream_events v2 frame shape.
 * The discriminant field is `event` (NOT `type`) — confirmed from live fixture.
 */
type LangGraphEvent = {
  event: string;
  name: string;
  run_id: string;
  data: Record<string, unknown>;
  /**
   * Nesting key. Present on every event including tools inside unregistered subgraphs.
   * `parent_ids` is null on every frame and `streamSubgraphs` governs `.stream()` rather than
   * `streamEvents`, so this is the only reliable source. (Issue #38.)
   */
  metadata?: { checkpoint_ns?: string };
};

/**
 * Stable text-block id used for every text-delta in a single stream.
 * AI SDK v6 requires text-delta frames to carry an `id` linking deltas to a
 * conceptual text block. LangGraph's `on_chat_model_stream` doesn't carry one,
 * so we synthesize a per-stream id (single block — there's only ever one
 * assistant text block per agent turn in this flow).
 */
const TEXT_ID = "text-1";

/** Serialize a single AI SDK v6 frame as the body of an SSE data line.
 *
 * Returns `data: {...}` with NO trailing newline — the handler is responsible
 * for the `\n\n` frame separator. To emit a compound (multi-frame) raw, join
 * with `\n\n` so the receiver's SSE parser sees distinct frames.
 */
function makeFrame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}`;
}

/**
 * If a text block is currently open in `state`, return the SSE serialization
 * of a text-end frame followed by the inter-frame separator, and mark the
 * block closed. Returns "" otherwise — designed for prepend-on-transition.
 */
function closeText(state: { textStarted: boolean }): string {
  if (!state.textStarted) return "";
  state.textStarted = false;
  return makeFrame({ type: "text-end", id: TEXT_ID }) + "\n\n";
}

/**
 * Per-stream transform state. `attributionFor` is scoped here for the same reason
 * `textStarted` is: scopeIds are only meaningful within one stream, and a shared registry
 * would hand two concurrent runs the same ids.
 */
interface LangGraphTransformState {
  textStarted: boolean;
  attributionFor: (ns: unknown) => FrameAttribution | undefined;
}

function langGraphToAiSdkInner(
  frame: SseFrame,
  state: LangGraphTransformState
): SseFrame | null {
  const line = frame.raw;

  // Only process SSE data lines
  if (!line.startsWith("data: ")) return frame;

  const raw = line.slice(6);

  // Translate `[DONE]` to AI SDK v6 `finish` so the React hook transitions
  // status from "streaming" to "idle". Other adapters do the equivalent
  // (langchainAdapter maps `event: message` → finish; deepagentsAdapter
  // expects backends to emit finish directly). Without this, the langgraph
  // cell's hook state is driven by TCP close instead of a structured frame.
  // Also close any open text block first.
  if (raw === "[DONE]") {
    return {
      raw:
        closeText(state) + makeFrame({ type: "finish", finishReason: "stop" }),
    };
  }

  let parsed: LangGraphEvent;
  try {
    parsed = JSON.parse(raw) as LangGraphEvent;
  } catch {
    // Non-JSON data — pass through unchanged (never throw on parse failure)
    return frame;
  }

  // If no event discriminant field, this is not a LangGraph event shape — pass through
  if (!parsed.event) return frame;

  switch (parsed.event) {
    case "on_chat_model_stream": {
      const chunk = (parsed.data?.chunk as Record<string, unknown>) ?? {};
      const content = chunk.content;
      // Drop non-string content (arrays in tool-call mode, undefined, etc.) and empty strings.
      /*
       * A SPACE IS CONTENT. AN EMPTY STRING IS NOT (#347).
       *
       * This guard was `!content.trim()`, which conflates two different facts:
       *
       *   ""        the backend sent no text     -> a frame carrying nothing, drop it
       *   " ", "\n"  the backend sent whitespace  -> the separator between two words
       *
       * A model streaming "Hi" / " " / "there" reassembles as "Hithere" on the client,
       * because the middle token satisfies `!trim()` and is deleted in transit. Every word
       * boundary that arrives as its own token is lost, in all three runtimes, since they
       * share this adapter shape.
       *
       * THE `.trim()` WAS DELIBERATE AND ITS REASONING DOES NOT HOLD. It was introduced as
       * hardening on the argument that a whitespace delta is "functionally empty" and would
       * "pad the message" with something "the user sees as nothing". That is true of a
       * LEADING space and false of the one between two words, which is the case a streaming
       * model produces constantly — and the transport cannot tell them apart, because
       * position is a property of the assembled message and not of the frame.
       *
       * So the transport does what it says elsewhere it does. Two tests below this one, the
       * contract is stated outright for a 1MB payload: "round-trip the text faithfully with
       * NO truncation, NO chunking" — "the adapter's job is pass-through fidelity". A rule
       * that returns a megabyte unaltered and silently deletes a byte is not a fidelity rule.
       * Trimming display whitespace is a decision about presentation, and it belongs where
       * the assembled message is, not in the pipe.
       *
       * `=== ""` rather than `!content`: identical for a string, and it says which of the two
       * facts above is being tested.
       */
      if (typeof content !== "string" || content === "") return null;
      // AI SDK v6 requires text-start before any text-delta with the same id.
      // On the first delta of a block, emit text-start + text-delta as a single
      // compound frame (separated by \n\n — the receiver's accumulator will
      // re-parse them as two distinct SSE events).
      const deltaFrame = makeFrame({
        type: "text-delta",
        id: TEXT_ID,
        delta: content,
      });
      if (!state.textStarted) {
        state.textStarted = true;
        const startFrame = makeFrame({ type: "text-start", id: TEXT_ID });
        return { raw: `${startFrame}\n\n${deltaFrame}` };
      }
      return { raw: deltaFrame };
    }

    case "on_tool_start": {
      // LangGraph emits tool input as fully-resolved at start time (no streaming
      // input phase). Map directly to tool-input-available — the AI SDK v6 hook
      // builds a ToolCallMessage in "input-available" state from this frame alone.
      // toolCallId stability: run_id is the LangGraph-assigned UUIDv7 and is also
      // referenced by the matching on_tool_end, so the round-trip stays correlated.
      const toolCallId = parsed.run_id;
      const toolName = parsed.name;
      if (!toolCallId || !toolName) return null;
      const input = (parsed.data?.input as Record<string, unknown>) ?? {};
      // Close any open text block before the tool frame — AI SDK v6 requires
      // text-end before transitioning out of a text block.
      return {
        raw:
          closeText(state) +
          makeFrame({
            type: "tool-input-available",
            toolCallId,
            toolName,
            input,
          }),
        // Out-of-band; never serialized. See SseFrame.attribution — AI SDK v6 rejects
        // unknown fields on standard frames, so this cannot live in the JSON above.
        attribution: state.attributionFor(
          (parsed.metadata as Record<string, unknown> | undefined)
            ?.checkpoint_ns
        ),
      };
    }

    case "on_tool_end": {
      // data.output is either a string (raw return value of a sync tool) or a
      // structured ToolMessage dict ({content, type:"tool", name, tool_call_id, ...})
      // — depends on the tool's return type and the backend's serialization.
      // Both cases extract the human-readable text into `output`.
      //
      // Hardening: `out` (or `c`) may contain a circular reference (e.g., a
      // tool returns a proxied value or a self-referencing object). Plain
      // `JSON.stringify` throws `TypeError: Converting circular structure to JSON`
      // in that case. We wrap both stringify calls in try/catch and fall back
      // to `String(...)`, which always produces a string (even for circular,
      // undefined, or symbol inputs). The contract — output is always a string,
      // and the transform never throws — is preserved.
      const toolCallId = parsed.run_id;
      if (!toolCallId) return null;
      const out = (parsed.data as Record<string, unknown> | undefined)?.output;
      const safeStringify = (v: unknown): string => {
        try {
          return JSON.stringify(v);
        } catch {
          return String(v ?? "");
        }
      };
      let output: string;
      if (typeof out === "string") {
        output = out;
      } else if (out !== null && typeof out === "object" && "content" in out) {
        const c = (out as { content: unknown }).content;
        output = typeof c === "string" ? c : safeStringify(c);
      } else {
        output = safeStringify(out ?? "");
      }
      return {
        raw:
          closeText(state) +
          makeFrame({
            type: "tool-output-available",
            toolCallId,
            output,
          }),
        attribution: state.attributionFor(
          (parsed.metadata as Record<string, unknown> | undefined)
            ?.checkpoint_ns
        ),
      };
    }

    // Drop all other events (on_chain_start, on_chain_end, on_chain_stream,
    // on_chat_model_start, on_chat_model_end, and any future event types)
    default:
      return null;
  }
}

/**
 * Create a fresh transform with its own per-stream state.
 * Each request needs its own state so concurrent streams don't share text-block
 * tracking; the langchainAdapter follows the same pattern.
 */
export function createLangGraphTransform(): SseTransform {
  // `attributionFor` is per-stream for the same reason `textStarted` is: scopeIds are only
  // meaningful within one stream, and sharing the registry across concurrent requests would
  // hand two different runs the same ids. (Issue #38.)
  const state = {
    textStarted: false,
    attributionFor: createScopeRegistry(),
  };
  return (frame: SseFrame): SseFrame | null =>
    langGraphToAiSdkInner(frame, state);
}

export const langGraphAdapter: SseAdapter = {
  name: "langgraph",
  // Getter ensures each access returns a fresh transform array — per-request
  // isolation (matches langchainAdapter's idiom).
  get transforms() {
    return [createLangGraphTransform()];
  },
};
