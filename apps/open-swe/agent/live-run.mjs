/**
 * A REAL RUN, not a scripted one.
 *
 * Rung 4's local backend has always served a fixed sequence of tool calls, and
 * apps/open-swe/docs/LOCAL-AGENT.md defends that: the repo is the glue layer —
 * SSE delivery, tool normalization, card enrichment, run lifecycle, thread
 * state, approval gating — and "the LLM is the part this repo does not own".
 * The scripted run exercises all of the glue without an account or a key.
 *
 * That argument holds for a clean clone. It stops holding the moment a model
 * backend IS running and configured, which is the normal state of this repo
 * during development: the queue then shows a scripted parser fix beside a chat
 * surface answering real questions from the same machine.
 *
 * So: when the model backend answers, the queue drives it and streams what it
 * actually said. When it does not, the scripted run is still there, unchanged.
 *
 * WHY A TRANSLATION AND NOT A PASSTHROUGH. The two sides speak different
 * protocols and both are load-bearing:
 *
 *   the model backend   AI SDK v6 data-stream frames (text-delta, tool-*)
 *   this backend        LangGraph astream_events v2 (on_chat_model_stream, …)
 *
 * The app proxies this backend through openSweAdapter, which converts
 * LangGraph events INTO AI SDK frames. Emitting AI SDK frames here would be
 * double-converted, and bypassing the adapter would stop exercising the very
 * code path this rung exists to demonstrate. So the frames are translated back
 * into the event vocabulary the adapter reads, and every layer stays honest.
 */

/** Field names taken from packages/server/src/adapters/openSwe.ts. */
export function frameToEvents(frame, runId) {
  let payload;
  try {
    payload = JSON.parse(frame);
  } catch {
    return []; // A frame we cannot read is not evidence of anything.
  }
  const t = payload?.type;

  if (t === "text-delta" && typeof payload.delta === "string") {
    // `!content` in the adapter drops whitespace-only deltas, so sending them
    // is harmless — but sending nothing is cheaper and keeps the stream clean.
    if (!payload.delta.trim()) return [];
    return [
      {
        event: "on_chat_model_stream",
        name: "model",
        run_id: runId,
        data: { chunk: { content: payload.delta } },
      },
    ];
  }

  if (t === "tool-input-available") {
    return [
      {
        event: "on_tool_start",
        name: payload.toolName ?? "tool",
        // The adapter keys tool cards by run_id, so the TOOL CALL's id must be
        // used here — not the run's. Using the run id would collapse every
        // tool in a turn into one card.
        run_id: payload.toolCallId ?? runId,
        data: { input: payload.input ?? {} },
      },
    ];
  }

  if (t === "tool-output-available") {
    return [
      {
        event: "on_tool_end",
        name: payload.toolName ?? "tool",
        run_id: payload.toolCallId ?? runId,
        data: { output: payload.output },
      },
    ];
  }

  if (t === "tool-output-error") {
    // Surfaced as a tool END carrying the error text. The alternative — dropping
    // it — leaves a card that never resolves, which is the defect #250 was
    // about: a tool that fails must not look like one still working.
    return [
      {
        event: "on_tool_end",
        name: payload.toolName ?? "tool",
        run_id: payload.toolCallId ?? runId,
        data: { output: payload.errorText ?? "tool error" },
      },
    ];
  }

  return [];
}

/**
 * Split an SSE body into its `data:` payloads.
 *
 * Per LINE, not per frame. The same mistake cost this repo an evening: a
 * greedy regex over a whole frame swallowed the boundary and JSON.parse threw
 * on `text-end` + `finish` arriving together, which is what every adapter
 * emits when it closes a text block.
 */
export function dataPayloads(chunk) {
  const out = [];
  for (const line of String(chunk).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    out.push(payload);
  }
  return out;
}

/** Was this the model's last word? */
export function isTerminal(payload) {
  try {
    return JSON.parse(payload)?.type === "finish";
  } catch {
    return false;
  }
}
