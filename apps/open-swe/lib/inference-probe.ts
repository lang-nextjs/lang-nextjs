/**
 * DID THE MODEL ACTUALLY ANSWER?
 *
 * The row this feeds used to be produced by a button labelled "Verify
 * inference (costs a call)" that cost nothing and verified nothing. It fetched
 * the backend's `/health`, which reports
 *
 *   {"configured": true, "provider": "nvidia"}
 *
 * — whether a KEY IS PRESENT — and rendered the result as `responding`, the
 * same state used for dependencies that were genuinely observed. Its own
 * comment claimed otherwise: "The backend owns the model call; we ask it to
 * make one and report what happened." It asked for no such thing.
 *
 * So the panel charged a person a cost warning for a check that could not
 * fail for the reason it named. A key can be present and the model dead,
 * rate-limited, or end-of-life — which is exactly what happened when NVIDIA
 * retired a model mid-session and every stream started returning 410.
 *
 * A real verification means watching TOKENS COME BACK. That is what this reads.
 */

/** What a probe stream proved, and what it could not. */
export interface InferenceVerdict {
  /** True only if the model emitted at least one non-empty token. */
  answered: boolean;
  /** The first few characters the model produced, for the panel's detail line. */
  sample?: string;
  /** Why it did not answer. Absent when it did. */
  reason?: string;
}

/**
 * Read an AI-SDK data stream and decide whether the model spoke.
 *
 * Deliberately NOT satisfied by a well-formed stream that carries no text. A
 * `finish` with no deltas is the shape a dead or filtered model produces, and
 * treating it as success would rebuild the bug this replaces one level up.
 */
export function readInferenceStream(raw: string): InferenceVerdict {
  let text = "";
  let sawFinish = false;
  let errorDetail: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    if (!payload.startsWith("{")) continue;

    let frame: { type?: string; delta?: unknown; errorText?: unknown; message?: unknown };
    try {
      frame = JSON.parse(payload);
    } catch {
      continue; // A frame we cannot read is not evidence either way.
    }

    if (frame.type === "text-delta" && typeof frame.delta === "string") {
      text += frame.delta;
    } else if (frame.type === "finish") {
      sawFinish = true;
    } else if (frame.type === "error" || frame.type === "data-error") {
      const said = frame.errorText ?? frame.message;
      errorDetail = typeof said === "string" && said.trim() ? said.trim() : "the stream reported an error";
    }
  }

  if (errorDetail) return { answered: false, reason: errorDetail };
  if (text.trim()) return { answered: true, sample: clip(text.trim()) };
  if (sawFinish) {
    return {
      answered: false,
      reason: "the stream finished without the model producing any text",
    };
  }
  return {
    answered: false,
    reason: "the stream ended before the model produced any text",
  };
}

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * HOW LONG A VERIFICATION IS WORTH BELIEVING.
 *
 * The old check ran on demand because it claimed to cost a call. Now it
 * genuinely does, and it runs on page load — so without this, every visit and
 * every refresh of /settings would spend one. That is a real cost regression
 * and a person would hit it immediately by pressing F5.
 *
 * A cached verdict is also more honest than a fresh one pretending to be
 * instantaneous: the panel already renders an age for every row, so a result
 * from four minutes ago is displayed as exactly that.
 */
export const INFERENCE_TTL_MS = 5 * 60 * 1000;

export function isFresh(
  probedAt: number | undefined,
  now: number,
  ttlMs: number = INFERENCE_TTL_MS
): boolean {
  if (probedAt === undefined) return false;
  // A clock that moved backwards (NTP, a resumed laptop) must not make a stale
  // entry look fresh forever, so the comparison is on absolute distance.
  return Math.abs(now - probedAt) < ttlMs;
}
