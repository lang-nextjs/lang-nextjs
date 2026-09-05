/**
 * Classifies a failed task submission into something a user can act on.
 *
 * #131: the catch in app/page.tsx was `console.error` only. A warning in a
 * console nobody has open is indistinguishable from silence — the user pressed
 * submit, nothing happened, and a failure looked exactly like a slow success.
 *
 * TWO RULES THIS ENCODES.
 *
 * 1. NEVER "something went wrong". 429, 502 and an unreachable network send the
 *    user to three different places: wait, fix configuration, check the
 *    connection. A message that does not distinguish them sends them nowhere.
 *
 * 2. ABSENCE IS NOT SUCCESS, and it is not a generic error either. When the
 *    request never got a response, `status` is null and the copy says the
 *    request never left — which is a different fact from "the server refused".
 *    Same principle as #176: an unknown state must not be rendered as a known
 *    one, in either direction.
 */

export interface SubmitFailure {
  /** HTTP status, or null when no response was received at all. */
  status: number | null;
  /** Names what happened. Never generic. */
  title: string;
  /** What to do about it — differs per class, which is the point. */
  hint: string;
  /** Server-supplied detail, when the response carried one. */
  detail?: string;
}

/**
 * Pull `{ error: "..." }` out of a response body without letting a parse
 * failure become the thing the user sees. Returns undefined rather than
 * throwing: a malformed body is a reason to show less, not to show a crash.
 */
export async function readErrorDetail(
  res: Response
): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not parseable. Two different situations hide here and they deserve
      // different answers:
      //
      //   "backend refused the task"   plain text -> a real message, surface it
      //   "{not json"                  BROKEN JSON -> a fragment of a failed
      //                                serialisation. Showing it to a user is
      //                                noise dressed as a reason.
      //
      // A body that opens with { or [ was meant to be JSON and is not. Drop it
      // rather than paste the wreckage into an error panel. A long body is
      // dropped too — that is an HTML error page.
      const trimmed = text.trim();
      const looksLikeFailedJson =
        trimmed.startsWith("{") || trimmed.startsWith("[");
      if (trimmed && !looksLikeFailedJson && trimmed.length <= 200)
        return trimmed;
    }
  } catch {
    // Body already consumed or the stream failed. Not worth surfacing.
  }
  return undefined;
}

/**
 * `status === null` means the fetch itself rejected — DNS failure, offline,
 * connection refused. The request never reached a server, which is why its copy
 * differs from every status-bearing case.
 */
export function classifySubmitFailure(
  status: number | null,
  detail?: string,
  retryAfterSeconds?: number
): SubmitFailure {
  if (status === null) {
    return {
      status: null,
      title: "Couldn’t reach the server",
      hint: "The request never left this machine. Check your connection, then retry.",
      detail,
    };
  }

  if (status === 429) {
    const wait = retryAfterSeconds
      ? `Wait ${retryAfterSeconds}s and retry.`
      : "Wait a moment and retry.";
    return {
      status,
      title: "Rate limit reached",
      hint: `Too many requests in the last minute. ${wait} Leaving this page open also consumes the budget.`,
      detail,
    };
  }

  if (status === 502 || status === 503 || status === 504) {
    return {
      status,
      title: "The agent backend is unreachable",
      hint: "The dashboard reached this app, but this app could not reach the agent. Check that the backend is running and configured.",
      detail,
    };
  }

  if (status === 422 || status === 400) {
    return {
      status,
      title: "The task was rejected",
      hint: "The server would not accept this task as written. Edit it and retry.",
      detail,
    };
  }

  if (status === 401 || status === 403) {
    return {
      status,
      title: "Not authorised to create runs",
      hint: "This app is running without the credentials the backend requires.",
      detail,
    };
  }

  if (status >= 500) {
    return {
      status,
      title: `The server errored (${status})`,
      hint: "This is a fault in the backend, not in your task. Retrying may work; the server log will say why.",
      detail,
    };
  }

  return {
    status,
    title: `The request failed (${status})`,
    hint: "The server refused this submission. The status above is the specific reason.",
    detail,
  };
}
