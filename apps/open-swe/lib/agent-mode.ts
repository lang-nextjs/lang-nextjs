/**
 * Who actually answered — read off the response that carried the content.
 *
 * The one rule that matters: a MISSING header resolves to `unknown`, never to
 * `live`. If a forker points LANGGRAPH_PLATFORM_URL at some other backend, we
 * genuinely do not know what it is, and saying "live" would be a guess
 * rendered as a fact. `unknown` is the honest answer and the UI says so.
 *
 * Compare `/api/config`, which reports `fastapi: !!process.env.FASTAPI_URL` —
 * that value stays true while fastapi is down, because it describes
 * configuration rather than a responder. Nothing here may work that way.
 */
export const AGENT_MODE_HEADER = "x-openswe-agent-mode";
export const AGENT_MODE_REASON_HEADER = "x-openswe-agent-mode-reason";

export type AgentMode = "canned" | "live" | "unknown";

export interface AgentProvenance {
  mode: AgentMode;
  /**
   * Why the responder took that path.
   *
   * CARRIED FOR `unknown` TOO, since #282. A run that is still streaming has
   * not yet produced an answer to "what made this", and that is a different
   * unknown from "the backend did not identify itself" — one resolves in a few
   * seconds, the other never will. `run-in-progress` distinguishes them.
   */
  reason?: string;
}

/** The responder is still working; ask again when it has finished. */
export const REASON_IN_PROGRESS = "run-in-progress";

/** Parse provenance out of a response's headers. Absent ⇒ `unknown`. */
export function readProvenance(headers: Headers): AgentProvenance {
  const raw = headers.get(AGENT_MODE_HEADER);
  const reason = headers.get(AGENT_MODE_REASON_HEADER) ?? undefined;
  if (raw === "canned") return { mode: "canned", reason };
  if (raw === "live") return { mode: "live", reason };
  // The reason survives an unknown mode, so a responder that says "I do not
  // know YET" can be told apart from one that never identified itself.
  return { mode: "unknown", ...(reason ? { reason } : {}) };
}

/** What the banner says. Kept next to the parser so the two never drift. */
export function describeProvenance(p: AgentProvenance): {
  label: string;
  detail: string;
  tone: "canned" | "live" | "unknown";
} {
  switch (p.mode) {
    case "canned":
      return {
        label: "Scripted run — no LLM was called",
        detail:
          p.reason === "live-decided-per-run"
            ? // Deliberately does NOT name a provider. We know a key is set; the
              // header does not say WHICH, and naming the wrong one is exactly
              // the bug this replaced.
              //
              // It also no longer claims the graph is unwired. It IS wired: the
              // agent tries the model first and falls back only if nothing
              // answers. The previous wording said every run was scripted, which
              // was false for exactly the runs a person most wanted to trust.
              "A model API key is set. This particular run was served from the script because the model did not answer."
            : // Same wording as lib/readiness.ts, so the two places that tell you
              // to set a key cannot drift into naming different ones. This used
              // to name OPENROUTER_API_KEY alone, so somebody with NVIDIA set —
              // the free provider we recommend — was sent to fix a key they did
              // not need while the one they had went unmentioned.
              "Set NVIDIA_API_KEY (free at build.nvidia.com), OPENROUTER_API_KEY, or ANTHROPIC_API_KEY to run against a real model once a graph is configured.",
        tone: "canned",
      };
    case "live":
      return {
        label: "Live agent run",
        detail: "A real graph produced this run.",
        tone: "live",
      };
    default:
      if (p.reason === REASON_IN_PROGRESS) {
        // NOT "Scripted run", which is what this said before #282 gave the
        // queue a live path. The banner was rendered from `resolveMode()` —
        // a prediction from configuration — so a run that was calling a model
        // right then displayed "Scripted run — no LLM was called" and flipped
        // to "Live agent run" when it finished. The first of those was a
        // positive claim, and it was false while it was on screen.
        return {
          label: "Still running",
          detail:
            "This run is in progress. We will say what produced it once it finishes — guessing now is how a scripted run gets mistaken for a real one, and the reverse.",
          tone: "unknown",
        };
      }
      return {
        label: "Unknown backend",
        detail:
          "This backend did not identify itself, so we cannot tell you whether the output came from a real agent.",
        tone: "unknown",
      };
  }
}
