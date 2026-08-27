/**
 * THE TECHNICAL FACTS ABOUT A RUN, fit to render.
 *
 * The run page showed one line of them:
 *
 *   run {runId.slice(0, 18)}…
 *
 * which has two defects and hides a third.
 *
 * IT LIES ABOUT TRUNCATION. `slice(0, 18)` on `run-1` returns `run-1` and the
 * ellipsis is appended unconditionally, so a five-character id renders as
 * `run run-1…` — reported verbatim. An ellipsis means "there is more"; here
 * there is not, and a person copying that string gets a trailing character
 * that belongs to no id.
 *
 * THE THREAD ID IS NEVER SHOWN AT ALL, though it is in the URL, required for
 * the page to work, and the thing you need when the board and the detail page
 * disagree — which they did, twice this week.
 *
 * AND IT IS INSIDE `{task && (…)}`, so a run with no task shows no identifiers
 * whatever. That is exactly the run you most need to identify.
 */

export interface RunFact {
  /** Short uppercase label, e.g. "RUN". */
  label: string;
  /** The full value. Never abbreviated — see `display`. */
  value: string;
  /** What to render. Equal to `value` unless it is genuinely too long. */
  display: string;
  /** True only when `display` is actually shorter than `value`. */
  truncated: boolean;
}

/**
 * Abbreviate only when there is something to abbreviate.
 *
 * The ellipsis is the CLAIM, and it must be earned. A value that fits is
 * returned whole and reports `truncated: false`, so the caller can render the
 * marker on the same condition the truncation happened.
 */
export function abbreviate(value: string, max = 24): RunFact["display"] {
  const v = String(value ?? "");
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

export function fact(label: string, value: unknown, max = 24): RunFact | null {
  const v = typeof value === "string" ? value.trim() : "";
  // An absent id is not rendered as an empty row. A blank value under a label
  // reads as "this run has no id", which is a different and alarming claim.
  if (!v) return null;
  const display = abbreviate(v, max);
  return { label, value: v, display, truncated: display !== v };
}

/**
 * Every identifier this page can state about a run, in the order a person
 * reads them: what it is, where it lives, what produced it.
 *
 * Returns only what is KNOWN. A caller with no provenance yet gets two rows,
 * not two rows and a placeholder — the panel grows as facts arrive rather than
 * showing gaps that look like failures.
 */
export function runFacts(input: {
  runId?: string;
  threadId?: string;
  status?: string;
  agentMode?: string;
  agentReason?: string;
}): RunFact[] {
  return [
    fact("Run", input.runId),
    fact("Thread", input.threadId),
    fact("Status", input.status),
    // The reason carries framework/topology for a live run and the blocker for
    // a scripted one, which is more useful than the mode word on its own.
    fact("Agent", input.agentReason || input.agentMode, 40),
  ].filter((f): f is RunFact => f !== null);
}
