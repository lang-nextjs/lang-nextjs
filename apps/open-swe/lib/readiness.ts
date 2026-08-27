/**
 * Is this surface actually able to do the thing it looks able to do?
 *
 * THE BUG THIS EXISTS TO KILL. The chat header showed a green dot whenever
 * `status === "idle"`, and idle means "the UI is not currently streaming". It
 * does NOT mean a model is reachable. With no API key configured the dot was
 * green, the composer was enabled, and the first thing a person learned was a
 * failed send — a status reporting a verdict it never computed, which is the
 * same shape as every other defect this repo has been pulling out of its
 * checks. The green was not wrong about idleness; it was answering a question
 * nobody was asking.
 *
 * So readiness is computed from PREREQUISITES first and activity second.
 * "Blocked" outranks "idle", because a surface that cannot run is not idle —
 * it is broken, and saying so before the send is the entire point.
 */

import { assertNever } from "@deepagents-nextjs/rungs";
import type { Tone } from "./dependency-status";

export type ReadinessState = "blocked" | "error" | "busy" | "ready" | "unknown";

export interface ReadinessInput {
  /** null while the probe is in flight — deliberately distinct from false. */
  llmConfigured: boolean | null;
  /**
   * WHO ANSWERED THE MODEL QUESTION — and therefore what a `false` means.
   *
   * `/api/config` has always returned this and nothing consumed it, which
   * produced a message that blamed the wrong thing. With the backend stopped:
   *
   *   backend /health   unreachable
   *   /api/config       activeLlm: null, llmSource: "local-env"
   *   the banner        "No model API key configured — set NVIDIA_API_KEY…"
   *
   * The key was set the whole time, in the repo-root .env the BACKEND reads
   * through docker's env_file. open-swe never reads it directly and should
   * not: a key present only in this process would read as configured while
   * every completion failed. But when the process that WOULD know cannot be
   * reached, "no key is configured" is a verdict nobody computed.
   *
   * "backend"   — the backend answered. A false here is a real answer.
   * "local-env" — the backend did NOT answer, so this is a fallback reading
   *               of a process that is the wrong subject.
   * null        — not known yet, or an older payload without the field.
   */
  llmSource?: "backend" | "local-env" | null;
  /** Does the selected surface need a sandbox at all? */
  sandboxRequired: boolean;
  /** null while probing; false means every provider reported unavailable. */
  sandboxAvailable: boolean | null;
  /** The stream's own status, e.g. idle | streaming | error. */
  streamStatus: string;
}

export interface Readiness {
  state: ReadinessState;
  /** Short text for the indicator. */
  label: string;
  /** Every unmet prerequisite, not just the first — fixing one at a time is slow. */
  reasons: string[];
}

const BUSY_STATUSES = new Set([
  "streaming",
  "connecting",
  "submitted",
  "loading",
]);

export function computeReadiness(input: ReadinessInput): Readiness {
  const {
    llmConfigured,
    llmSource,
    sandboxRequired,
    sandboxAvailable,
    streamStatus,
  } = input;

  // A live error outranks everything: it is a fact about this surface now,
  // not a prediction about whether it could work.
  if (streamStatus === "error") {
    return { state: "error", label: "error", reasons: [] };
  }

  const reasons: string[] = [];
  if (llmConfigured === false) {
    reasons.push(
      llmSource === "local-env"
        ? // WRITTEN FOR A BANNER, NOT FOR A README. The first version of this
          // was three sentences of architecture — where the key lives, which
          // process reads it, what Ctrl-C does — rendered inside a small
          // "Not ready to run" box on two surfaces. It also carried markdown
          // backticks around `pnpm dev`, which reach the screen as literal
          // backticks: reasons render as {why} in a <li>, with no formatter.
          //
          // What a person needs here is the action and the one fact that
          // resolves the confusion — that their key is not what is missing.
          // The rest is in this comment, where the next reader of the CODE
          // wants it and the person staring at a blocked composer does not.
          "The model backend isn't answering, so no key could be checked — start it with pnpm dev, then reload. This app never reads your API key; the backend does."
        : "No model API key configured — set NVIDIA_API_KEY (free at build.nvidia.com), OPENROUTER_API_KEY, or ANTHROPIC_API_KEY"
    );
  }
  if (sandboxRequired && sandboxAvailable === false) {
    reasons.push(
      // NAMES THE ACTION, not just the diagnosis. This read "…this surface runs
      // code and cannot without one", which is true and leaves a person with
      // nowhere to go. Docker is the default provider, and "is it running" is
      // the question that resolves this nine times in ten.
      "No sandbox provider is available — this surface runs code and needs one. Start Docker, then reload."
    );
  }

  // ALL unmet prerequisites are reported, and blocked beats busy: a run that
  // is streaming toward a failure is still blocked, and hiding that behind an
  // activity spinner is how the original green dot happened.
  if (reasons.length > 0) {
    return { state: "blocked", label: "not ready", reasons };
  }

  // Still probing. `unknown` rather than optimistic `ready`: a probe in flight
  // is an absence of evidence, and rendering it as green would reintroduce the
  // exact defect one state over.
  if (
    llmConfigured === null ||
    (sandboxRequired && sandboxAvailable === null)
  ) {
    return { state: "unknown", label: "checking…", reasons: [] };
  }

  if (BUSY_STATUSES.has(streamStatus)) {
    return { state: "busy", label: streamStatus, reasons: [] };
  }

  return { state: "ready", label: streamStatus || "ready", reasons: [] };
}

/** Only a fully-ready surface should let you send. */
export function canSend(r: Readiness): boolean {
  return r.state === "ready";
}

/**
 * Readiness state -> tone, EXHAUSTIVE BY CONSTRUCTION.
 *
 * Replaces a ternary chain in chat/page.tsx that ended `: "bg-success"`. That was correct
 * only because this union has five members and the else was reachable solely by "ready" —
 * **defused by accident, not by design. A sixth state shipped HEALTHY**, which is the exact
 * defect this indicator exists to fix, one state over.
 *
 * `describeDependency` in ./dependency-status.ts already solved this for the dependency union.
 * This is that pattern carried to the call site it had not reached — and it reuses that
 * module's `Tone` rather than declaring a second colour vocabulary for the same idea, per
 * PRODUCT's one-home requirement.
 */
export function toneForReadiness(state: ReadinessState): Tone {
  switch (state) {
    case "ready":
      return "success";
    case "busy":
      // Activity, not health. Reading it as green IS the original bug — "the UI is not busy"
      // mistaken for "the system is ready".
      return "info";
    case "unknown":
      // A probe in flight is an absence of evidence, and absence must not render as health.
      return "muted";
    case "blocked":
    case "error":
      return "destructive";
    default:
      return assertNever(state);
  }
}
