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
 * A REASON RIDES IN AN HTTP HEADER (`x-openswe-agent-mode-reason`), and a
 * provider's message is text we did not write. A newline in a header value is
 * `ERR_INVALID_CHAR` — Node throws, and the throw lands in the run's response,
 * which turns a bad model day into a broken queue.
 *
 * Non-ASCII is dropped rather than encoded: this is a diagnostic label, the
 * header is latin-1 by spec, and a mangled label read by a human beats a
 * correct one that crashes the writer. The clip is there because a provider
 * that returns a stack trace should not become the banner.
 *
 * AND SECRETS ARE REDACTED FIRST. This text ends up on screen, which is the
 * exception this repo makes to #262 ("the raw message does not reach the DOM")
 * — the provenance banner is the diagnostic surface and already carries raw
 * upstream facts like `backend-status-404`. An exception earns that by paying
 * the cost the rule was protecting against, and the realistic cost here is a
 * provider echoing the credential back inside its own error. Prefixed keys are
 * matched by name; anything else long enough and random-looking enough to be a
 * key is replaced whether or not we recognise its vendor, because the list of
 * vendors is exactly the thing that goes stale.
 */
const MAX_REASON_TEXT = 120;
const SECRET_SHAPES = [
  /\b(?:nvapi|sk|sk-ant|sk-or|xai|gsk|ghp|github_pat|AIza)[-_][A-Za-z0-9_-]{8,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];
const sanitizeReasonText = (s) => {
  let out = s
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out.trim().slice(0, MAX_REASON_TEXT);
};

/**
 * THE BACKEND'S OWN WORDS FOR WHY A STREAM CARRIED NO ANSWER.
 *
 * `frameToEvents` returns `[]` for an error frame, deliberately: an error is
 * not a transcript event, and a run that falls back to the scripted one must
 * not blend real frames into it. But the caller was reading only that empty
 * array, so a backend that said
 *
 *   {"type":"data-error","data":{"code":"backend_error",
 *    "message":"Service temporarily overloaded","origin":"provider"}}
 *
 * was recorded as `stream-empty` — "the model backend streamed zero frames" —
 * when it had streamed the one frame that explained everything. Observed live:
 * one request in three to a healthy backend with a valid key came back exactly
 * like this, and the queue reported it as the model not answering.
 *
 * WHY `data.message` FIRST. That is where the running backend puts it. The
 * flat `errorText`/`message` fall-backs are the AI SDK's own error shapes,
 * kept because this reads frames from anything that speaks the protocol.
 *
 * @returns the message, `""` for an error frame that named no cause, and
 *   `null` for a frame that is not an error at all — three distinct answers,
 *   because "not an error" and "an error nobody described" are different facts
 *   and a caller that cannot tell them apart reports the wrong one.
 */
export function frameErrorText(payload) {
  let frame;
  try {
    frame = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return null; // A frame we cannot read is not evidence of an error.
  }
  if (frame?.type !== "data-error" && frame?.type !== "error") return null;
  const said =
    frame?.data?.message ??
    frame?.errorText ??
    frame?.message ??
    frame?.data?.code;
  return typeof said === "string" ? sanitizeReasonText(said) : "";
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

/**
 * COLLECT A RUN'S TOOL CALLS AS IT STREAMS, so the finished transcript can
 * show them.
 *
 * Reported as "I wish we could see the input and outputs of the tasks in this
 * page". They were on screen while the run streamed and gone the moment it
 * finished: the live path kept only the assistant TEXT, so a run that called
 * three tools persisted as a bare reply. ConversationView has rendered tool
 * args and results all along — it was never given any.
 *
 * Keyed by toolCallId so an input and its output pair up, which is the same
 * key ConversationView pairs on (`tool_call_id`). Order is preserved: a
 * transcript that reorders a run's tools misrepresents what happened.
 */
export function collectToolCalls() {
  const order = [];
  const byId = new Map();

  return {
    /** Feed each parsed frame; unrelated types are ignored. */
    accept(payload) {
      let f;
      try {
        f = JSON.parse(payload);
      } catch {
        return;
      }
      const id = f?.toolCallId;
      if (typeof id !== "string" || !id) return;

      // THE NAME COMES FROM WHICHEVER FRAME CARRIES IT, and only the input
      // frames do — `tool-output-available` is `{toolCallId, output}` with no
      // toolName, by the SDK's own strictObject schema.
      //
      // The first version read only `tool-input-available`, so a call whose
      // OUTPUT was seen first fell back to the literal name "tool". Measured
      // on a three-tool run: one card read `increment` and two read `tool`.
      // `tool-input-start` is where the name arrives first, so it is accepted
      // too, and a known name is never overwritten by the fallback.
      if (f.type === "tool-input-start" || f.type === "tool-input-available") {
        if (!byId.has(id)) order.push(id);
        const prev = byId.get(id) ?? {};
        byId.set(id, {
          ...prev,
          id,
          name: f.toolName ?? prev.name ?? "tool",
          args: f.input ?? prev.args ?? {},
        });
      } else if (f.type === "tool-output-available") {
        if (!byId.has(id)) order.push(id);
        const prev = byId.get(id) ?? { id, name: "tool", args: {} };
        byId.set(id, { ...prev, name: prev.name ?? "tool", result: f.output });
      } else if (f.type === "tool-output-error") {
        if (!byId.has(id)) order.push(id);
        byId.set(id, {
          ...(byId.get(id) ?? { id, name: "tool", args: {} }),
          // Recorded as the RESULT, and flagged. Dropping it would leave a
          // tool that appears to have run and returned nothing — the #250
          // shape, persisted this time.
          result: f.errorText ?? "tool error",
          failed: true,
        });
      }
    },
    /** In call order, with inputs and outputs paired. */
    list() {
      return order.map((id) => byId.get(id)).filter(Boolean);
    },
  };
}

/**
 * The LangChain message shape ConversationView reads: an `ai` message carrying
 * `tool_calls`, and one `tool` message per result keyed by `tool_call_id`.
 *
 * Built here rather than in the page because it is a WIRE format — the same
 * one a real LangGraph thread returns — and the page must not learn two ways
 * to read a transcript.
 */
export function toolMessages(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return [
    {
      type: "ai",
      role: "assistant",
      content: "",
      tool_calls: tools.map((t) => ({
        id: t.id,
        name: t.name,
        args: t.args ?? {},
      })),
    },
    ...tools
      .filter((t) => t.result !== undefined)
      .map((t) => ({
        type: "tool",
        tool_call_id: t.id,
        content:
          typeof t.result === "string" ? t.result : JSON.stringify(t.result),
      })),
  ];
}
