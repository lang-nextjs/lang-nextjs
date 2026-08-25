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
  /** Why the responder took that path. Absent for `unknown`. */
  reason?: string;
}

/** Parse provenance out of a response's headers. Absent ⇒ `unknown`. */
export function readProvenance(headers: Headers): AgentProvenance {
  const raw = headers.get(AGENT_MODE_HEADER);
  const reason = headers.get(AGENT_MODE_REASON_HEADER) ?? undefined;
  if (raw === "canned") return { mode: "canned", reason };
  if (raw === "live") return { mode: "live", reason };
  return { mode: "unknown" };
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
          p.reason === "live-graph-not-configured"
            ? // Deliberately does NOT name a provider. We know a key is set; the
              // header does not say WHICH, and naming the wrong one is exactly
              // the bug this replaced.
              "A model API key is set, but the live graph is not wired yet, so this run is scripted."
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
      return {
        label: "Unknown backend",
        detail:
          "This backend did not identify itself, so we cannot tell you whether the output came from a real agent.",
        tone: "unknown",
      };
  }
}
