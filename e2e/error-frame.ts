/**
 * THE ERROR-FRAME EVIDENCE LINE — ONE PLACE, BECAUSE IT IS HALF OF A WIRE FORMAT (#664).
 *
 * `scripts/classify-live-failure.mjs` decides whether a red job is a provider outage or a
 * defect in this repository. It does that by scanning the job log for lines shaped
 *
 *     LIVE_TRANSPORT_ERROR_FRAME <cell> :: <the raw frame JSON>
 *
 * and reading `origin` out of the frame. NOTHING ELSE IN THE REPOSITORY PRODUCES THAT LINE —
 * before this file there was exactly one emitter, a private function in
 * `e2e/shell/live-transport.spec.ts`, and the classifier's regex three directories away. Two
 * halves of a format, no shared definition, and no test that they still agree.
 *
 * WHY THAT MATTERED ENOUGH TO EXTRACT. If the emitter and the parser drift, every failure
 * classifies as FAILED_UNCLASSIFIED — red, unattributed, "someone must look". That is
 * INDISTINGUISHABLE from the honest answer on a job that genuinely failed before producing any
 * frame, which is the state main is actually in for 18 of its last 24 runs. A silent drift here
 * would look exactly like the thing it was hiding.
 *
 * So: one definition, imported by every emitter, and `scripts/assert-error-frame-contract.mjs`
 * feeds a line built from THIS marker to the REAL classifier and asserts it attributes.
 */

/** The token the classifier scans for. Changing it is a wire-format change on both sides. */
export const ERROR_FRAME_MARKER = "LIVE_TRANSPORT_ERROR_FRAME";

/**
 * The first in-band error frame in an SSE body, or null.
 *
 * Matches `"type":"error"` and `"type":"data-error"` — the AI SDK emits the second shape for
 * an error surfaced as a data part, and a matcher for only the first would read a genuinely
 * failing stream as clean.
 */
export function inBandErrorFrame(body: string): string | null {
  return (
    body.split("\n").find((l) => /"type"\s*:\s*"(data-)?error"/.test(l)) ?? null
  );
}

/**
 * The evidence line for a failing assertion's message.
 *
 * `cell` names WHICH case produced it — a rung/topology pair, or a test name — because the
 * classifier de-duplicates frames by `cell::frame` and a shared constant would collapse
 * distinct failures into one.
 *
 * Emitted even when `frame` is null, deliberately. A run that failed with NO error frame is a
 * different fact from a run that produced one, and the classifier needs to see the absence to
 * report FAILED_UNCLASSIFIED rather than quietly finding nothing.
 */
export function errorFrameEvidence(cell: string, frame: string | null): string {
  return `${ERROR_FRAME_MARKER} ${cell} :: ${frame ?? ""}`;
}
