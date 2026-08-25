import { RUNGS, RUNG_BY_ID } from "@deepagents-nextjs/rungs";

/**
 * The conversation axis of this app's chat surface, DERIVED FROM THE MANIFEST.
 *
 * Extracted from app/chat/page.tsx so it can be tested without rendering a
 * client component. The page is where these are displayed; it is not where the
 * question "which frameworks exist, and what can each of them do" should be
 * answered — that is rungs.json's job, and this module is the reading of it.
 */

/** A conversation rung's id. Deliberately `string`: the set comes from the manifest. */
export type AiBackend = string;
export type Topology = string;

/**
 * The runtime this app talks to.
 *
 * open-swe's chat route forwards to ONE configured backend and discards
 * `pythonBackend`, so there is no runtime selector here and this is not a
 * user choice. It is named rather than inlined so the day the route learns to
 * route by runtime, the topology derivation has one place to become dynamic.
 */
export const RUNTIME = "fastapi" as const;

const FRAMEWORK_LABELS: Record<string, string> = {
  langchain: "LangChain",
  langgraph: "LangGraph",
  deepagents: "DeepAgents",
};

/**
 * Conversation rungs in LADDER ORDER — simple to complex.
 *
 * The hardcoded array this replaced read langgraph, langchain, deepagents: a
 * second list beside rungs.json whose order contradicted the ladder it was
 * describing. Ordinals are not a presentation choice; `requires` makes each
 * rung a step above the one below, so sorting by ordinal IS sorting by
 * complexity.
 */
export const FRAMEWORKS: { id: AiBackend; label: string }[] = [...RUNGS]
  .filter((r) => r.shape === "conversation")
  .sort((a, b) => a.ordinal - b.ordinal)
  .map((r) => ({ id: r.id, label: FRAMEWORK_LABELS[r.id] ?? r.id }));

/**
 * The simplest rung on the ladder — first by ordinal, not a name repeated here.
 * Falls back to "langchain" only if the manifest somehow declares no
 * conversation rung, which a fork cannot produce today but a future one might.
 */
export const DEFAULT_FRAMEWORK: AiBackend = FRAMEWORKS[0]?.id ?? "langchain";

export function isKnownFramework(id: string | null | undefined): id is AiBackend {
  return id != null && FRAMEWORKS.some((f) => f.id === id);
}

/**
 * Which topologies a framework actually has.
 *
 * Falls back to ["react"] rather than [] so the axis is never empty: a pair
 * with no declared topologies would render zero Mode buttons and strand the
 * surface with no way to send.
 */
export function topologiesFor(rungId: string): readonly Topology[] {
  const declared =
    RUNG_BY_ID[rungId as keyof typeof RUNG_BY_ID]?.runtimes?.[RUNTIME]
      ?.topologies;
  return declared && declared.length > 0 ? declared : ["react"];
}

const TOPOLOGY_LABELS: Record<string, { label: string; title: string }> = {
  react: { label: "ReAct", title: "Single ReAct agent (reason ↔ act loop)" },
  "plan-execute": {
    label: "Plan-Execute",
    title: "Planner drafts steps, executor carries them out",
  },
  "deep-research": {
    label: "DeepResearch",
    title: "Web-search research agent (DuckDuckGo)",
  },
};

/**
 * Presentation only. A topology the manifest declares but this map has no entry
 * for still renders — titled by its id — rather than vanishing. A missing label
 * is a copy gap; silently dropping a real topology would be the manifest lying
 * in the other direction.
 */
export function labelFor(id: string): { label: string; title: string } {
  return TOPOLOGY_LABELS[id] ?? { label: id, title: id };
}
