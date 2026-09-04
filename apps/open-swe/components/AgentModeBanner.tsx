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
 *
 * WHY THE LOUDNESS IS KEYED TO TONE (#710).
 *
 * The reasoning above is sound and this component used to apply it
 * SYMMETRICALLY — the same full-bleed three-line box for all three tones. But
 * the guarantee it protects is not symmetric, and `describeProvenance` says so
 * in its own return values:
 *
 *   canned  — `detail` is a PARAGRAPH of specific diagnosis ("Set MODEL_BACKEND
 *             to a running backend", "This is the BACKEND to check, not your API
 *             key", the provider's own refusal text). The reader is about to
 *             form a false belief and the box is carrying the payload that
 *             prevents it. Loud is the entire point.
 *   unknown — the backend did not identify itself. Silence would read as "fine".
 *   live    — `detail` is one short sentence. There is no false belief available
 *             to prevent: nobody is misled by a live run being live.
 *
 * So `live` — and only `live` — renders as a compact chip. It is still always
 * rendered, still tone-coloured, still above the run content; it simply stops
 * outweighing the answer it introduces. The detail sentence moves to `title`
 * rather than being dropped.
 *
 * `data-density` is stated by the component so a test can key on the CLAIM
 * ("this is the compact render") rather than on utility classes. A later
 * restyle must not be able to silently invert that verdict.
 */
/**
 * WHICH TONES GET THE FULL BOX — the single source of truth.
 *
 * Exported because the page needs the same answer: it renders an inline
 * "Source" label beside the compact chip, and that label would be orphaned on
 * the previous line if the banner were a full-width box. Deriving it here means
 * a later change to the rule moves BOTH, instead of leaving the page asserting
 * a layout the component no longer produces.
 */
export function bannerDensity(p: AgentProvenance): "compact" | "full" {
  return describeProvenance(p).tone === "live" ? "compact" : "full";
}

export function AgentModeBanner({
  provenance,
}: {
  provenance?: AgentProvenance | null;
}) {
  // Before the first response resolves we know nothing, so we claim nothing.
  if (!provenance) return null;

  const { label, detail, tone } = describeProvenance(provenance);

  const dot = {
    canned: "bg-warning",
    live: "bg-success",
    unknown: "bg-muted-foreground",
  }[tone];

  if (bannerDensity(provenance) === "compact") {
    return (
      <span
        data-testid="agent-mode-banner"
        data-agent-mode={provenance.mode}
        data-density="compact"
        role="status"
        title={detail}
        className="text-success border-success/25 bg-success/10 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${dot}`}
        />
        {label}
      </span>
    );
  }

  const palette = {
    canned: "border-warning/30 bg-warning/10 text-warning",
    live: "border-success/30 bg-success/10 text-success",
    unknown: "border-border/40 bg-muted/40 text-foreground",
  }[tone];

  return (
    <div
      data-testid="agent-mode-banner"
      data-agent-mode={provenance.mode}
      data-density="full"
      role="status"
      className={`flex w-full items-start gap-3 rounded-lg border px-4 py-3 ${palette}`}
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
