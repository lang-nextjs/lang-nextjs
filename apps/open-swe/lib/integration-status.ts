import { assertNever } from "@deepagents-nextjs/rungs";

/**
 * THE ONE HOME for what an integration's status MEANS. Import it; do not re-derive it.
 *
 * PRODUCT made that a requirement rather than a preference, and the reason is #36's
 * sixteenth entry: a lesson recorded at one call site has no mechanism to reach the next
 * unless a person carries it. This is the fifth artifact in the repo needing a shared
 * derivation (nav, perf budgets, frame schema, dependency inventory, and now this), and five
 * hand-rolled versions of one idea is how that entry happens again.
 *
 * WHY FOUR STATES AND NOT A BOOLEAN. `configured` says a key was SUPPLIED. Only a live call
 * says it ANSWERS. Collapsing those launders inference as observation — which is live today:
 * `_common.py` computes LangSmith's `tracing` from the SAME EXPRESSION as its `configured`,
 * so `tracing: true` there means "two environment variables are set", not "a span arrived".
 *
 * And "never probed" is not "probed and failed". PRODUCT specified three states, then
 * corrected to four, because those two are DIFFERENTLY ACTIONABLE: the first may just need
 * triggering, the second means something is broken. Collapsing them loses the distinction
 * that tells an operator what to do next, which is the only reason a status panel exists.
 */

/** Build-time capability, env inference, and the runtime observation — three facts, not one. */
export interface IntegrationInput {
  /**
   * Does THIS BUILD wire the integration at all?
   *
   * A build-time literal in `_common.py` — nothing opens a socket. So it answers whether the
   * row APPLIES, never whether a host is reachable. Rendering it as reachability is wrong the
   * first time someone points LANGFUSE_HOST at a dead box.
   */
  supported: boolean;
  /** Env inference: keys are present. Cheap, always knowable, and not evidence of anything. */
  configured: boolean;
  /**
   * The only field that is an OBSERVATION.
   *   true  — a span was accepted
   *   false — a send was attempted and failed
   *   null  — never probed
   * `null` is deliberately distinct from `false`, the same way `readiness.ts` treats a probe
   * in flight: an absence of evidence is not evidence of absence.
   */
  tracing: boolean | null;
  /**
   * The backend's own explanation, preferred over ours when present.
   *
   * It knows more than we can infer: the live backend distinguishes "Langfuse refused the
   * keys" from "the SDK is missing", and both are more actionable than anything derivable
   * from three booleans. We supply a fallback so a backend that omits it still yields a next
   * action rather than a bare state.
   */
  detail?: string | null;
}

export type IntegrationState =
  | "unsupported"
  | "not-configured"
  | "unverified"
  | "failed"
  | "verified";

/**
 * How a state should READ, separated from what it IS.
 *
 * `positive` is reachable from exactly one state, and that is asserted in the tests rather
 * than left to inspection — a tone mapping with a default branch is the green-dot bug with a
 * different coat on.
 */
export type StatusTone = "positive" | "warning" | "negative" | "neutral";

export interface IntegrationStatus {
  state: IntegrationState;
  /** Short text for the row. */
  label: string;
  /** What an operator should do about it. A status with no next action is decoration. */
  detail: string;
}

export function computeIntegrationStatus(
  input: IntegrationInput,
): IntegrationStatus {
  const { supported, configured, tracing } = input;
  const given = input.detail?.trim() || null;

  // APPLICABILITY IS ANSWERED FIRST. If the build cannot send spans, a `tracing` claim from
  // that build is not evidence of anything, so it is not consulted. Not a failure either:
  // an unwired integration is a capability that does not exist, and a red indicator there is
  // a false alarm. False alarms are how operators learn to stop reading a panel.
  if (!supported) {
    return {
      state: "unsupported",
      label: "not wired",
      detail: given ?? "Not integrated in this build — nothing is expected to be sent.",
    };
  }

  if (!configured) {
    return {
      state: "not-configured",
      label: "not configured",
      detail: given ?? "No credentials set. This is optional; set them to enable tracing.",
    };
  }

  // Configured from here on, so every branch below is about the OBSERVATION.
  if (tracing === true) {
    return {
      state: "verified",
      label: "tracing",
      detail: given ?? "A span was accepted — traces are arriving.",
    };
  }
  if (tracing === false) {
    return {
      state: "failed",
      label: "not reaching",
      detail:
        given ??
        "Credentials are set and a send was attempted, but no span was accepted. Check the host and key.",
    };
  }
  return {
    state: "unverified",
    label: "configured, unverified",
    detail:
      given ??
      "Credentials are set but no span has been observed yet. This is not a failure — nothing has been sent to check.",
  };
}

/**
 * Exhaustive by construction. A new `IntegrationState` fails to COMPILE here rather than
 * inheriting a tone — which is the difference between this and the mapping it replaces, where
 * a trailing `: "bg-success"` meant a sixth state would have shipped healthy.
 */
export function toneFor(state: IntegrationState): StatusTone {
  switch (state) {
    case "verified":
      return "positive";
    case "unverified":
      // WARNING, NOT POSITIVE, AND THIS IS THE WHOLE REQUIREMENT: configured-but-unverified
      // must be visually distinct from verified, or the panel launders inference as
      // observation. LangSmith is in this state right now and will stay in it until
      // something actually watches a span land.
      return "warning";
    case "failed":
      return "negative";
    case "not-configured":
    case "unsupported":
      // Neither is an alarm. Not having set something up, and a build not wiring something,
      // are both explanations rather than faults.
      return "neutral";
    default:
      return assertNever(state);
  }
}

/**
 * Tone -> the dot class. Exhaustive for the same reason `toneFor` is.
 *
 * This is the last place a colour is decided, so it is the last place a default branch could
 * reintroduce the bug. Both surfaces call it; neither inlines a ternary. A ternary chain
 * ending in `: "bg-success"` is how the original defect survived — safe only while the union
 * happened to be closed, which is defused by accident rather than by construction.
 */
export function toneClass(tone: StatusTone): string {
  switch (tone) {
    case "positive":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "negative":
      return "bg-destructive";
    case "neutral":
      return "bg-muted-foreground";
    default:
      return assertNever(tone);
  }
}
