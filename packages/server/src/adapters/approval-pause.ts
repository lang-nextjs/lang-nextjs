/**
 * `event: approval_pending` → a `data-approval-pause` part, for EVERY gating rung.
 *
 * WHY THIS IS SHARED RATHER THAN PER-ADAPTER (#332 steps C2-C5). The conversion
 * lived inside the langchain adapter while langchain was the only rung that
 * gated. #332 arms the others, and the measured consequence of leaving it there
 * was not a wrong part but NO part: `adapters/langgraph.ts` opens with
 * `if (!line.startsWith("data: ")) return frame;`, so an `event:`-led frame is
 * passed through untouched, reaches the client in the backend's wire shape, and
 * is understood by nobody. The tool is correctly withheld and the person is told
 * nothing — the defect #413 held the whole gate disarmed to avoid, and #448 is
 * this same frame being emitted and consumed while parsed by nothing.
 *
 * A SECOND COPY WOULD HAVE BEEN THE OTHER FAILURE. Two adapters converting the
 * same frame independently is the "made twice" divergence that produced #232 and
 * #247/#302, and that check-run-axes-parity, check-langfuse-wiring and the
 * conformance suites all exist to catch. One conversion, called twice.
 *
 * IT NAMES NO RUNG AND IMPORTS NONE, deliberately. This file survives every
 * `pnpm eject`; the rung adapters do not. A shared module reaching for a
 * rung-owned one is green on the ladder and dies in a fork (#588, gated by #590
 * on the Python side). Everything here is expressed in terms of an SSE frame.
 *
 * CARRIED FAITHFULLY, NOT RESHAPED — the rule the langchain adapter established
 * and the reason this is a move rather than a rewrite. `interrupt` is upstream's
 * payload verbatim: `action_requests` paired BY INDEX with `review_configs`,
 * snake_case as LangChain and DeepAgents wrote them. Measured on the installed
 * versions, both emit `action_requests: [{name, args, description}]` and
 * `review_configs: [{action_name, allowed_decisions}]` — #332's issue body
 * quotes a flat `{action_name, allowed_decisions}` that neither produces, and
 * building a rung from that quote is how the langgraph plane first emitted a
 * shape the card's schema rejects.
 *
 * The four-way vocabulary cannot survive a translation into anything binary:
 * `respond` and `reject` both mean "do not run it" and produce OPPOSITE tool
 * statuses, and `edit` carries structured args no boolean can express.
 */

export const APPROVAL_PENDING_EVENT = "approval_pending";

/** The event name and data payload of an SSE frame, whichever lines carry them. */
function splitSseFrame(raw: string): { event: string | null; data: string } {
  let event: string | null = null;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return { event, data };
}

/**
 * The pause part for an `approval_pending` frame.
 *
 * Returns `undefined` when the frame is not an approval pause at all, which the
 * caller must treat as "carry on" rather than as a drop — the three states are
 * distinct and collapsing the first two silently eats every other event:
 *
 *   undefined  not an approval frame; the adapter continues as before
 *   null       an approval frame this cannot describe; DROP it
 *   SseFrame   the converted part
 *
 * A pause we cannot describe is worse than none: it renders an affordance with
 * no decisions on it, which is an approval control that cannot be answered.
 */
export function approvalPausePart(
  raw: string
): { raw: string } | null | undefined {
  const { event, data } = splitSseFrame(raw);
  if (event !== APPROVAL_PENDING_EVENT) return undefined;

  let parsed: { interrupt?: unknown };
  try {
    parsed = JSON.parse(data) as { interrupt?: unknown };
  } catch {
    return null;
  }
  const interrupt = parsed.interrupt;
  if (!interrupt || typeof interrupt !== "object") return null;

  return {
    raw: `data: ${JSON.stringify({
      type: "data-approval-pause",
      data: { interrupt },
    })}`,
  };
}
