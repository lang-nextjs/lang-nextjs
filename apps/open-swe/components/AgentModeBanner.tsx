"use client";

import { describeProvenance, type AgentProvenance } from "../lib/agent-mode";

/**
 * Says who produced what you are looking at — while you are looking at it.
 *
 * This is deliberately not dismissible and not a footnote. A forker who
 * mistakes a scripted run for a live agent forms a false belief about what
 * they just saw work, and a reference implementation that produces false
 * beliefs is worse than one that does less. So the banner sits above the run
 * content, is always rendered, and is driven by the provenance of the very
 * response that carried the content below it.
 *
 * `unknown` is a first-class state, not an error: if you point this app at
 * some other LangGraph backend, we genuinely cannot tell whether a real agent
 * answered, and saying so is more useful than guessing.
 */
export function AgentModeBanner({
  provenance,
}: {
  provenance?: AgentProvenance | null;
}) {
  // Before the first response resolves we know nothing, so we claim nothing.
  if (!provenance) return null;

  const { label, detail, tone } = describeProvenance(provenance);

  const palette = {
    canned: "border-warning/30 bg-warning/10 text-warning",
    live: "border-success/30 bg-success/10 text-success",
    unknown: "border-border/40 bg-muted/40 text-foreground",
  }[tone];

  const dot = {
    canned: "bg-warning",
    live: "bg-success",
    unknown: "bg-muted-foreground",
  }[tone];

  return (
    <div
      data-testid="agent-mode-banner"
      data-agent-mode={provenance.mode}
      role="status"
      className={`mb-5 flex items-start gap-3 rounded-lg border px-4 py-3 ${palette}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`}
      />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-0.5 text-xs opacity-80">{detail}</p>
      </div>
    </div>
  );
}
