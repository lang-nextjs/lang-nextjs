/**
 * READ A COMPLETED ASSISTANT TURN, AND NAME WHICH OF THE OUTCOMES IT WAS.
 *
 * `E2E — open-swe live transport` has been red on main for 34 consecutive runs, and its
 * failure message names a cause the evidence rules out (#530):
 *
 *     Error: langgraph called the tool but reported a different number than 4
 *     expect(received).toContain(expected)
 *       Expected substring: "4"
 *       Received string:    ""
 *
 * A WRONG NUMBER IS NOT AN EMPTY STRING. One assertion was carrying at least four distinct
 * states and printing the name of one of them:
 *
 *     1  the model called the tool and reported the wrong number   <- what the message claims
 *     2  the model called the tool and produced no synthesis text
 *     3  the model never called the tool
 *     4  the request failed upstream and "" is a swallowed error
 *
 * Thirty-four runs of evidence were spent on a sentence describing a state that did not occur.
 *
 * ── THE TEST WAS DOING WHAT THE BACKEND WAS ALREADY BLAMED FOR ────────────────────────────
 *
 * `ai_backends/_common.py` records it on the other plane: "THE BACKEND KNEW THE REASON AND
 * THREW IT AWAY." The reader here did the same. It collected exactly two frame types —
 * `tool-input-available` names and `text-delta` deltas — and dropped everything else on the
 * floor, including `data-error`. So an upstream failure arrived as an empty string with no
 * trace, which is state 4 wearing state 1's message.
 *
 * This reads the WHOLE turn: every frame type is counted, error frames are kept with their
 * code and origin, the finish reason is kept, and tool RESULTS are distinguished from tool
 * CALLS — a call with no result is a different failure from a call whose result the model
 * ignored, and neither is "reported a different number".
 *
 * UNRECOGNISED FRAME TYPES ARE COUNTED RATHER THAN IGNORED, so the next frame this repo starts
 * emitting shows up as a number in the report instead of as silence.
 */

export interface Turn {
  /** Total `data:` frames seen, including ones this does not interpret. */
  frames: number;
  /** A census of every frame type, so nothing is silently dropped. */
  frameTypes: Record<string, number>;
  /** Names from `tool-input-available` — the model ASKED to call these. */
  toolCalls: string[];
  /** Names from `tool-output-available` — these actually RETURNED. */
  toolOutputs: string[];
  text: string;
  /** `data-error` frames, previously discarded entirely. */
  errors: { code: string; message: string; origin: string }[];
  finishReason: string | null;
  /** `data:` payloads that were not JSON. Silence here would hide a malformed stream. */
  unparsable: number;
}

export function readTurn(sse: string): Turn {
  const t: Turn = {
    frames: 0, frameTypes: {}, toolCalls: [], toolOutputs: [],
    text: "", errors: [], finishReason: null, unparsable: 0,
  };
  const chunks: string[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    t.frames++;
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      t.unparsable++;
      continue;
    }
    const type = typeof f.type === "string" ? f.type : "(untyped)";
    t.frameTypes[type] = (t.frameTypes[type] ?? 0) + 1;
    if (type === "tool-input-available" && typeof f.toolName === "string") t.toolCalls.push(f.toolName);
    if (type === "tool-output-available" && typeof f.toolName === "string") t.toolOutputs.push(f.toolName);
    if (type === "text-delta" && typeof f.delta === "string") chunks.push(f.delta);
    if (type === "data-error") {
      const d = (f.data ?? {}) as Record<string, unknown>;
      t.errors.push({
        code: String(d.code ?? "(no code)"),
        message: String(d.message ?? "(no message)"),
        origin: String(d.origin ?? "(absent)"),
      });
    }
    if (type === "finish" && typeof f.finishReason === "string") t.finishReason = f.finishReason;
  }
  t.text = chunks.join("");
  return t;
}

export type Outcome =
  | "ok"
  | "upstream_error"
  | "empty_stream"
  | "no_tool_call"
  | "tool_called_no_text"
  | "wrong_number";

/**
 * ORDERED MOST-EXPLANATORY FIRST, and the order is the whole point.
 *
 * An upstream error also produces no text and no tool call, so a reader that checked "did it
 * call the tool" first would report `no_tool_call` for a provider outage — accusing the app of
 * the defect the provider caused, which is the mistake this file exists to stop.
 */
export function classifyTurn(
  turn: Turn,
  opts: { tool: string; expect: string }
): { outcome: Outcome; why: string } {
  if (turn.errors.length > 0) {
    const e = turn.errors[turn.errors.length - 1];
    return {
      outcome: "upstream_error",
      why: `the stream carried a data-error frame — code=${e.code} origin=${e.origin}: ${e.message}. ` +
        `That is a report about the request, not about the model's answer.`,
    };
  }
  if (turn.frames === 0) {
    return { outcome: "empty_stream", why: `the stream contained no frames at all — not even a finish.` };
  }
  if (!turn.toolCalls.includes(opts.tool)) {
    return {
      outcome: "no_tool_call",
      why: `${opts.tool} was never called. Tools called: ${turn.toolCalls.length ? turn.toolCalls.join(", ") : "none"}.`,
    };
  }
  if (turn.text.trim() === "") {
    return {
      outcome: "tool_called_no_text",
      why: `${opts.tool} was called${turn.toolOutputs.includes(opts.tool) ? " and returned" : " but never returned a result"}, ` +
        `and the model then produced NO synthesis text. This is not a wrong number — there is no number.`,
    };
  }
  if (!turn.text.includes(opts.expect)) {
    return {
      outcome: "wrong_number",
      why: `${opts.tool} was called and the model answered, but the reply does not contain ${JSON.stringify(opts.expect)}.`,
    };
  }
  return { outcome: "ok", why: `${opts.tool} was called and the reply contains ${JSON.stringify(opts.expect)}.` };
}

/** The turn itself, printed, so a failure is readable without re-running anything. */
export function describeTurn(turn: Turn): string {
  const types = Object.entries(turn.frameTypes).sort().map(([k, n]) => `${k}×${n}`).join(" ") || "none";
  return [
    `    frames        : ${turn.frames}${turn.unparsable ? ` (${turn.unparsable} unparsable)` : ""}`,
    `    frame types   : ${types}`,
    `    tool calls    : ${turn.toolCalls.join(", ") || "none"}`,
    `    tool results  : ${turn.toolOutputs.join(", ") || "none"}`,
    `    finish reason : ${turn.finishReason ?? "(absent)"}`,
    `    errors        : ${turn.errors.length ? turn.errors.map((e) => `[${e.code}/${e.origin}] ${e.message}`).join(" | ") : "none"}`,
    `    text          : ${JSON.stringify(turn.text.slice(0, 300))}`,
  ].join("\n");
}
