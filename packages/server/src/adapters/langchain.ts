/**
 * langchainAdapter — LangChain native SSE → AI SDK v6 normalizer.
 *
 * LangChain native SSE uses event: + data: pairs. The fixture uses _event as discriminant
 * which maps to the SSE event: header (e.g., event: token\ndata: {...}).
 *
 * Field mapping (from langchain-native-sse.json fixture):
 *   token frames:    event.text    → text-delta.delta
 *   tool_call frames: event.tool_name, event.tool_input → tool-input-available
 *   message frames:  end-of-stream signal → finish (content intentionally DROPPED)
 *   error frames:    → null (dropped)
 *   [DONE] frames:   → pass through
 *
 * DESIGN INTENT for message frames:
 *   LangChain message frames signal end-of-response. Their content field contains the
 *   accumulated response text, but this MUST NOT be re-emitted as text-delta because:
 *   1. AI SDK v6 already accumulated all token fragments from earlier token frames
 *   2. Re-emitting the full text causes double-counting in the client
 *   3. The semantic meaning is "end of response" (finish), not "here is new content"
 *   Emit ONLY { type: 'finish', finishReason: 'stop' } — drop event.content entirely.
 */
import type { SseFrame, SseTransform } from "../accumulator";
import type { SseAdapter } from "./deepagents";

/**
 * Parse an SSE raw frame string into its event type and data string.
 * Handles multi-line SSE frames: "event: token\ndata: {...}"
 */
function extractLangChainFrame(raw: string): {
  event: string | null;
  data: string;
} {
  const lines = raw.split("\n");
  let event: string | null = null;
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }
  return { event, data };
}

/**
 * Transform a single LangChain SSE frame to AI SDK v6 wire format.
 *
 * @param frame - The raw SSE frame
 * @param toolCallCounters - Per-tool-name counter Map for deterministic IDs
 * @returns Transformed frame, or null to drop the frame
 */
const TEXT_ID = "text-1";

function makeFrame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}`;
}

/** Close any open text block and return its serialized text-end + separator. */
function closeText(state: { textStarted: boolean }): string {
  if (!state.textStarted) return "";
  state.textStarted = false;
  return makeFrame({ type: "text-end", id: TEXT_ID }) + "\n\n";
}

function langchainToAiSdk(
  frame: SseFrame,
  toolCallCounters: Map<string, number>,
  state: { textStarted: boolean }
): SseFrame | null {
  const { event, data } = extractLangChainFrame(frame.raw);

  // [DONE] sentinel — only pass through on bare data-only frames (no event: header).
  // An event-typed frame with data "[DONE]" (e.g. event: token\ndata: [DONE]) is
  // degenerate; passing it through causes JSON.parse("[DONE]") to throw on the client.
  if (data === "[DONE]" && event === null) return frame;

  // If no event: prefix and data doesn't start with data:, pass through (not LangChain format)
  if (event === null && !frame.raw.startsWith("data: ")) return frame;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    // JSON parse failed — apply per-event fallback instead of leaking the raw frame
    if (event === "message") {
      // End of stream with unparseable data — emit finish signal as best-effort
      return {
        raw: `data: ${JSON.stringify({
          type: "finish",
          finishReason: "stop",
        })}`,
      };
    }
    if (event === "token" || event === "error" || event === "tool_call") {
      // Known event types with bad JSON: drop silently
      return null;
    }
    // Unknown event type with non-JSON data — pass through unchanged
    return frame;
  }

  // Event type: SSE event: header takes precedence, fall back to data.type field
  const eventType = event ?? (parsed.type as string) ?? "";

  switch (eventType) {
    case "token": {
      const text = (parsed.text as string) ?? "";
      if (!text.trim()) return null;
      // AI SDK v6 requires text-start before any text-delta with the same id.
      // First delta of a block: emit text-start + text-delta as a compound frame.
      const deltaFrame = makeFrame({
        type: "text-delta",
        id: TEXT_ID,
        delta: text,
      });
      if (!state.textStarted) {
        state.textStarted = true;
        const startFrame = makeFrame({ type: "text-start", id: TEXT_ID });
        return { raw: `${startFrame}\n\n${deltaFrame}` };
      }
      return { raw: deltaFrame };
    }

    case "message": {
      // LangChain message frame = end of response; emit AI SDK finish signal.
      // DESIGN INTENT: Do NOT re-emit the accumulated content from the message frame.
      // The message frame's content field contains the full response text, but this
      // duplicates the token frames already accumulated by AI SDK v6. Emitting it would
      // cause double-counting in the client. Instead, emit ONLY the finish signal.
      // Close any open text block first (AI SDK v6 requires text-end).
      return {
        raw:
          closeText(state) +
          makeFrame({ type: "finish", finishReason: "stop" }),
      };
    }

    case "tool_call": {
      const toolName = (parsed.tool_name as string) ?? "";
      const toolInput = (parsed.tool_input as Record<string, unknown>) ?? {};
      // Deterministic toolCallId: use tool_call_id from frame if present,
      // otherwise lc-{toolName}-{count} where count is per-tool-name. This avoids
      // Date.now() collisions under high throughput and produces reproducible test values.
      const count = toolCallCounters.get(toolName) ?? 0;
      const explicitId = parsed.tool_call_id as string | undefined;
      const toolCallId = explicitId ?? `lc-${toolName}-${count}`;
      // Only advance the counter when the fallback ID is actually used.
      // Use `=== undefined` not `!explicitId`: empty string "" is falsy but is still
      // an explicit (if degenerate) id — it must not consume a counter slot either.
      if (explicitId === undefined) {
        toolCallCounters.set(toolName, count + 1);
      }
      // tool-input-available: required fields type + toolCallId + toolName + input (AI SDK v6)
      // Close any open text block before transitioning to a tool frame.
      return {
        raw:
          closeText(state) +
          makeFrame({
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: toolInput,
          }),
      };
    }

    case "error":
      return null; // Drop error frames — propagates via stream error, not forwarded frame

    default:
      return frame; // Pass through unrecognized event types unchanged
  }
}

/**
 * Create a fresh LangChain → AI SDK v6 transform with its own tool call counter.
 * Each request should use a fresh transform instance to ensure deterministic IDs.
 * Exported for testability.
 */
export function createLangchainTransform(): SseTransform {
  const toolCallCounters = new Map<string, number>();
  const state = { textStarted: false };
  return (frame: SseFrame): SseFrame | null => {
    return langchainToAiSdk(frame, toolCallCounters, state);
  };
}

/**
 * Adapter for LangChain native SSE backends.
 *
 * Pass to createDeepAgentsHandler when your backend streams LangChain native SSE
 * (event: token / event: message / event: tool_call format).
 *
 * Note: transforms is a getter that returns a fresh transform array on each access,
 * ensuring per-request counter isolation. Callers that destructure transforms once
 * and reuse the instance retain their own fresh counter for the duration of that request.
 */
export const langchainAdapter: SseAdapter = {
  name: "langchain",
  get transforms() {
    return [createLangchainTransform()];
  },
};
