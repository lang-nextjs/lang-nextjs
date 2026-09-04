"use client";

import {
  describeProvenance,
  type AgentMode,
  type AgentProvenance,
} from "../lib/agent-mode";

type Tone = ReturnType<typeof describeProvenance>["tone"];
type Density = "compact" | "full";

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
 * WHAT EACH TONE LOOKS LIKE, AT EITHER DENSITY — the single source of truth.
 *
 * WHY THIS TABLE EXISTS (#718). The compact chip used to state its colour as a
 * literal (`text-success border-success/25 bg-success/10`) while the dot right
 * beside it read its colour from `tone`. That is two independent statements of
 * one fact — "this is the live tone" — with nothing asserting they agree. They
 * agreed only because `bannerDensity` happens to return `compact` for exactly
 * one tone, so the literal and the derivation could not yet disagree.
 *
 * The failure that shape permits is silent and is precisely the one this
 * component exists to prevent: widen the compact rule by one tone — `unknown`
 * is the obvious candidate — and a scripted or unidentified run renders in
 * SUCCESS GREEN under a warning dot. Nothing goes red; the page simply tells a
 * forker that a scripted run was live.
 *
 * WHY WHOLE CLASS STRINGS RATHER THAN A COMPOSED HUE. Tailwind scans source for
 * complete class names, so `border-${hue}/25` would produce a class that is
 * never generated and a chip with no border. The repetition here is not
 * redundancy to be factored out — it is the literal form the scanner requires.
 *
 * The two densities keep their own border opacities (25 vs 30, as before) so
 * this change is a refactor of WHERE the colour comes from and not a restyle.
 * What matters is that both are stated per tone: a row cannot disagree with
 * itself about which tone it is.
 */
const TONE_STYLES: Record<
  Tone,
  { dot: string; compact: string; full: string }
> = {
  canned: {
    dot: "bg-warning",
    compact: "text-warning border-warning/25 bg-warning/10",
    full: "border-warning/30 bg-warning/10 text-warning",
  },
  live: {
    dot: "bg-success",
    compact: "text-success border-success/25 bg-success/10",
    full: "border-success/30 bg-success/10 text-success",
  },
  unknown: {
    dot: "bg-muted-foreground",
    compact: "text-foreground border-border/40 bg-muted/40",
    full: "border-border/40 bg-muted/40 text-foreground",
  },
};

/**
 * The surface and dot colours for one tone at one density.
 *
 * Exported so a test can ask the question the render path cannot yet reach:
 * today no provenance produces (canned, compact), so no amount of rendering
 * `AgentModeBanner` can observe whether the compact colour is derived. Asked
 * directly, it can.
 */
export function bannerStyles(
  tone: Tone,
  density: Density
): { surface: string; dot: string } {
  const styles = TONE_STYLES[tone];
  return { surface: styles[density], dot: styles.dot };
}

/**
 * WHICH TONES GET THE FULL BOX — the single source of truth.
 *
 * Exported because the page needs the same answer: it renders an inline
 * "Source" label beside the compact chip, and that label would be orphaned on
 * the previous line if the banner were a full-width box. Deriving it here means
 * a later change to the rule moves BOTH, instead of leaving the page asserting
 * a layout the component no longer produces.
 */
export function bannerDensity(p: AgentProvenance): Density {
  return describeProvenance(p).tone === "live" ? "compact" : "full";
}

/**
 * The banner as pixels, given a tone and a density — no policy.
 *
 * Split out from `AgentModeBanner` so that "which density does this provenance
 * get" and "what does that density look like" are separately reachable. The
 * policy has exactly one compact tone today, which means a test driven through
 * provenance can only ever see the compact branch coloured live-green, and so
 * cannot tell a derived colour from a hardcoded one. Rendering this directly
 * with a tone the policy does not currently pair with `compact` is the only
 * assertion that can fail against that hardcoded literal.
 */
export function AgentModeBannerView({
  mode,
  tone,
  label,
  detail,
  density,
}: {
  mode: AgentMode;
  tone: Tone;
  label: string;
  detail: string;
  density: Density;
}) {
  const { surface, dot } = bannerStyles(tone, density);

  if (density === "compact") {
    return (
      <span
        data-testid="agent-mode-banner"
        data-agent-mode={mode}
        data-density="compact"
        role="status"
        title={detail}
        className={`${surface} inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${dot}`}
        />
        {label}
      </span>
    );
  }

  return (
    <div
      data-testid="agent-mode-banner"
      data-agent-mode={mode}
      data-density="full"
      role="status"
      className={`flex w-full items-start gap-3 rounded-lg border px-4 py-3 ${surface}`}
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

export function AgentModeBanner({
  provenance,
}: {
  provenance?: AgentProvenance | null;
}) {
  // Before the first response resolves we know nothing, so we claim nothing.
  if (!provenance) return null;

  const { label, detail, tone } = describeProvenance(provenance);

  return (
    <AgentModeBannerView
      mode={provenance.mode}
      tone={tone}
      label={label}
      detail={detail}
      density={bannerDensity(provenance)}
    />
  );
}
