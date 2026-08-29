/**
 * What a person is told when a request fails (#262).
 *
 * Observed verbatim, in red, in the thread:
 *
 *     Upstream ended while an approval was still pending; releasing buffered frames
 *
 * That is a sentence about buffer management. It names an internal mechanism,
 * is not actionable, and appears exactly where someone expects to be told what
 * went wrong with THEIR request. The AI SDK docs are explicit about the general
 * case — show a generic message, to avoid leaking server information.
 *
 * BUT "SOMETHING WENT WRONG" FOR EVERYTHING IS ALSO WRONG. Several of these
 * codes describe situations a person can act on, and flattening them all to one
 * string trades a leak for a shrug. So: known codes get copy written for the
 * person, unknown codes get the generic line, and the raw text goes to the
 * console either way rather than being discarded.
 *
 * THE DEFAULT IS THE SAFE DIRECTION. A code added later that nobody maps lands
 * on the generic message, not on whatever the backend happened to say. Fail
 * closed: a new internal string cannot reach the DOM by being forgotten.
 */

export interface UserFacingError {
  /** What the person reads. Never contains the raw upstream text. */
  text: string;
  /** Whether offering "try again" is honest for this failure. */
  retryable: boolean;
  /** The original, for the console and observability. Never rendered. */
  detail: string | null;
}

const GENERIC = "Something went wrong. Your message was not completed.";

/**
 * Copy per code. Each says what happened in terms of the person's request, and
 * where it is worth saying, what they can do about it.
 */
const COPY: Record<string, { text: string; retryable: boolean }> = {
  upstream_disconnect: {
    text: "The connection to the agent dropped before the reply finished.",
    retryable: true,
  },
  upstream_unreachable: {
    text: "The agent backend could not be reached. It may not be running.",
    retryable: true,
  },
  backend_error: {
    text: "The agent backend failed while handling this message.",
    retryable: true,
  },
  approval_rejected: {
    text: "You rejected this action, so the reply stopped there.",
    retryable: false,
  },
  approval_timeout: {
    text: "The approval request expired before it was answered.",
    retryable: true,
  },
  // Both of these describe the gate firing after the fact (#256). The person
  // needs to know the action HAPPENED — that is the part that matters to them,
  // and the part the raw message buried in a sentence about frames.
  approval_pending_at_close: {
    text: "The reply ended while an approval was still waiting. Any action it had already taken has happened.",
    retryable: false,
  },
  tool_executed_without_approval: {
    text: "This action ran before the approval could be applied, so the decision could not prevent it.",
    retryable: false,
  },
};

export function userFacingError(
  code: string | null | undefined,
  rawMessage: string | null | undefined
): UserFacingError {
  const detail = rawMessage?.trim() ? rawMessage : null;
  const known = code ? COPY[code] : undefined;
  if (!known) return { text: GENERIC, retryable: true, detail };
  return { text: known.text, retryable: known.retryable, detail };
}

/** The codes this module has copy for — exported so a test can assert coverage. */
export const MAPPED_CODES = Object.keys(COPY);
export const GENERIC_TEXT = GENERIC;
