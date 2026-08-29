/**
 * What the thread says while it is waiting (#231).
 *
 * Pressing send showed NOTHING in the thread until the first token arrived. The
 * only in-thread signal was a blinking caret rendered INSIDE an assistant
 * bubble — which does not exist yet during `submitted`, so the one window a
 * person most needs feedback in was the one window with none.
 *
 * EVERY VERB HERE IS DERIVED, NEVER DECORATIVE. A rotating whimsical verb that
 * does not track what the system is doing is this repo's cataloguing defect
 * exactly: a status reporting something it never determined. Flavour belongs in
 * the WORDING; it must not reach the MAPPING.
 *
 * The pure parts live here, apart from the component, because they are what the
 * acceptance criteria are actually about: which verb, how long, and — the one
 * that matters most — whether the token segment is shown at all.
 */

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export interface ProcessingState {
  status: ChatStatus;
  /** The tool currently in flight, if the stream has announced one. */
  activeTool?: string | null;
  /** True once any assistant text has arrived for this turn. */
  hasText?: boolean;
}

/**
 * Whether the row belongs on screen at all.
 *
 * `error` is FALSE deliberately: the existing error card owns that moment, and
 * two things claiming it is worse than one (criterion 7). `idle` is false
 * because an indicator that is always on is not an indicator.
 */
export function shouldShowProcessing(state: ProcessingState): boolean {
  return state.status === "submitted" || state.status === "streaming";
}

/**
 * The verb, from observable state only.
 *
 * A tool in flight outranks text: if the agent is running something, that is
 * the more specific true statement about what is happening right now.
 */
export function processingVerb(state: ProcessingState): string {
  if (state.activeTool) {
    const t = state.activeTool;
    if (/^(read|cat|open|view)/i.test(t)) return "Reading";
    if (/^(search|grep|find|web)/i.test(t)) return "Searching";
    if (/^(write|edit|patch)/i.test(t)) return "Writing files";
    return `Running ${t}`;
  }
  if (state.status === "streaming" && state.hasText) return "Writing";
  if (state.status === "streaming") return "Thinking";
  return "Thinking";
}

/**
 * Elapsed time, formatted at the boundaries the issue names: `8s`, `1m 04s`,
 * `15m 58s`.
 *
 * Seconds are zero-padded ONLY once minutes are present — `04s` alone reads as
 * a stopwatch fragment, `1m 04s` reads as a duration.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export interface Usage {
  /** Tokens received so far. `undefined` means NOT MEASURED. */
  outputTokens?: number;
}

/**
 * The token segment, or `null` when there is nothing measured to report.
 *
 * NULL IS NOT ZERO, AND THAT IS THE WHOLE POINT (criterion 4). There is no
 * usage data in the transport plane yet, and rendering `0 tokens` would make a
 * zero meaning "not measured" indistinguishable from a zero meaning "measured,
 * and it was zero". #36 catalogued nineteen instances of that confusion; this
 * one is cheap to avoid by never inventing the number.
 *
 * A measured zero IS rendered — that is a fact, and suppressing it would be the
 * same error pointed the other way.
 */
export function tokenSegment(usage?: Usage | null): string | null {
  const n = usage?.outputTokens;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 1000) return `↓ ${n} tokens`;
  const k = n / 1000;
  return `↓ ${k >= 10 ? Math.round(k) : k.toFixed(1)}k tokens`;
}

/**
 * The full parenthetical, e.g. `(15m 58s)` or `(15m 58s · ↓ 8.5k tokens)`.
 * Returns the duration alone when usage is unmeasured — never an empty slot.
 */
export function processingDetail(ms: number, usage?: Usage | null): string {
  const tokens = tokenSegment(usage);
  return tokens ? `${formatElapsed(ms)} · ${tokens}` : formatElapsed(ms);
}
