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
import type { SseAdapter } from "../adapter-contract";

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
      /*
       * A SPACE IS CONTENT. AN EMPTY STRING IS NOT (#347).
       *
       * This guard was `!text.trim()`, which conflates two different facts:
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
       * `=== ""` rather than `!text`: identical for a string, and it says which of the two
       * facts above is being tested.
       */
      if (text === "") return null;
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

    case "tool_end": {
      // THE HALF THAT IS EASY TO FORGET. Without this case, adding `on_tool_end`
      // to the Python backend changes nothing visible: `default` below passes
      // the raw frame through, so the browser receives `event: tool_end` and the
      // card stays pending exactly as before. A backend-only fix looks correct
      // in a curl capture and fixes nothing in the UI.
      const toolCallId = (parsed.tool_call_id as string) ?? "";
      if (!toolCallId) {
        // No id, no pairing. The client matches on toolCallId alone and an
        // unmatched result lands in a pending map and is never merged — so a
        // frame we cannot pair is worse than none: it looks like data arrived.
        return null;
      }
      const output = parsed.output;
      return {
        raw: makeFrame({
          type: "tool-output-available",
          toolCallId,
          output: typeof output === "string" ? output : JSON.stringify(output),
        }),
      };
    }

    case "approval_pending": {
      /*
       * A WITHHELD TOOL CALL, TRANSLATED SO THE CLIENT CAN MODEL IT (#420).
       *
       * Without this the frame falls to `default:` and is forwarded in LangChain's wire
       * shape — passed through, and understood by nobody. Delivery without arrival.
       *
       * NAMED `data-approval-pause`, DELIBERATELY NOT ADJACENT TO `data-approval-required`,
       * and the distinction is the whole ruling on the old path. I first called this
       * `data-approval-pending`; DEV3 pointed out that two near-identical names for the
       * withholding and the non-withholding path is how someone wires the wrong one, and
       * they were right — the hazard was mine to introduce and theirs to catch. `data-approval-required` comes from
       * the proxy-side transform, which fires AFTER the backend has run the tool: it
       * withholds the report and not the effect. This one is emitted by a graph that has
       * genuinely paused. Two names because they are two different claims, and a user must
       * never meet an approval affordance that does not withhold.
       *
       * THE CARD MUST DECIDE FROM THIS FRAME AND NOTHING ELSE. `allowed_decisions` travels
       * inside the payload for that reason: if the client had to ask which topology it was
       * talking to in order to know which decisions to offer, that would be a second
       * declaration of the gating fact living in the browser, drifting from
       * GATED_TOPOLOGIES the first time someone edits one and not the other.
       *
       * CARRIED FAITHFULLY, NOT RESHAPED. `interrupt` is upstream's payload verbatim —
       * `action_requests` and `review_configs` as LangChain wrote them. The four-way
       * vocabulary cannot survive a translation into anything binary: `respond` and `reject`
       * both mean "do not run it" and produce OPPOSITE tool statuses, and `edit` carries
       * structured args no boolean can express. Narrowing here would decide #420 in the
       * direction of whatever a client happened to accept.
       *
       * THE SHAPE IS PROVISIONAL AND #420 OWNS IT. Nothing renders it yet.
       */
      const interrupt = parsed.interrupt;
      if (!interrupt || typeof interrupt !== "object") {
        // A pause we cannot describe is worse than none: it would render an affordance with
        // no decisions on it, which is an approval control that cannot be answered.
        return null;
      }
      return {
        raw: makeFrame({ type: "data-approval-pause", data: { interrupt } }),
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
  /**
   * This backend closes with `event: message` and no `type` field on the wire,
   * so the core predicate — which looks for a JSON `type: "finish"` or a
   * `[DONE]` sentinel — cannot see the end of the stream. Without this, every
   * successful chat through this adapter was followed by a false
   * `upstream_disconnect`.
   *
   * Matched on the `event:` field specifically, not anywhere in the frame, so a
   * token whose text happens to contain the word cannot end the stream.
   */
  isTerminal(frame) {
    return frame.raw
      .split(/\r?\n/)
      .some((line) => /^event:\s*message\s*$/.test(line.trim()));
  },
};
