/**
 * The two axes of this app's chat surface — WHICH FRAMEWORK and WHICH RUNTIME —
 * both derived from the manifest rather than restated here.
 *
 * Extracted from app/chat/page.tsx so they can be tested without rendering a
 * client component. The page is where these are displayed; it is not where the
 * question "which frameworks exist, and what can each of them do" should be
 * answered — that is rungs.json's job, and this module is the reading of it.
 *
 * WHY THE TOPOLOGY LIST IS DERIVED FROM BOTH AXES. The (rung, runtime) pairs
 * are not uniform, and a hardcoded topology list offers every mode in every
 * cell — so a user on a runtime that cannot serve a mode is handed a button
 * that produces a backend error. The grid is pinned as a literal in the test
 * file, deliberately independent of this derivation.
 */
import { RUNGS, RUNG_BY_ID } from "@deepagents-nextjs/rungs";

/**
 * A conversation rung's id, and a topology's.
 *
 * Deliberately `string` rather than a union of today's three values: the set
 * comes from the manifest, so a union here is a second source of truth that
 * goes stale the moment a fork adds a rung — and `labelFor` is built to render
 * a topology this file has never heard of rather than drop it.
 */
export type AiBackend = string;
export type Topology = string;

/** The Python runtimes /chat can proxy to. */
export const PYTHON_BACKENDS = ["django", "fastapi"] as const;
export type PythonBackend = (typeof PYTHON_BACKENDS)[number];

/** Narrow an untrusted value to a PythonBackend, defaulting to fastapi. */
export function asPythonBackend(value: unknown): PythonBackend {
  return value === "django" || value === "fastapi" ? value : "fastapi";
}

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

export function isKnownFramework(
  id: string | null | undefined
): id is AiBackend {
  return id != null && FRAMEWORKS.some((f) => f.id === id);
}

/**
 * Topologies a (rung, runtime) pair declares.
 *
 * `runtime` IS REQUIRED, and deliberately has no default. This function used to
 * take only a rung and read a module-level `RUNTIME = "fastapi"` constant,
 * which was honest while the route always forwarded to FASTAPI_URL — and became
 * a lie the moment the runtime became a user choice. Giving the parameter a
 * default would reintroduce exactly that: a caller who forgot the argument
 * would silently get fastapi's answer while the user was on django. Requiring
 * it forces every call site to say which runtime it is asking about.
 *
 * Falls back to ["react"] rather than [] so the axis is never empty: a pair with
 * no declared topologies would render zero buttons and strand the surface with
 * no way to send.
 */
/**
 * What happened when we tried to honour `?framework=` (#211).
 *
 * ABSENT AND PRESENT-BUT-UNKNOWN ARE DIFFERENT USER INTENTS, and the code treated them
 * identically: any invalid value fell through to DEFAULT_FRAMEWORK with no signal. A typo'd or
 * stale deep link landed on langchain, the toolbar showed langchain, the conversation worked,
 * and nothing said the request had been discarded — a wrong value producing a plausible screen.
 *
 * Absent is not an error: no intent was expressed and defaulting is right. Present-but-unknown
 * is: an intent was expressed and cannot be honoured, so substituting silently is the defect.
 *
 * `requested` is carried on the substituted case so a caller can NAME what was asked for. The
 * severability case is why that matters: after `pnpm eject langchain`, FRAMEWORKS is a
 * one-rung list, and a bookmark to `?framework=deepagents` becomes langchain — a fork
 * answering for a rung it does not contain. "deepagents is not in this build" is information
 * the user needs; silently swapping it is the fork lying about itself.
 *
 * This RESOLVES rather than throws. A 404 would lose the user's conversation over a bad
 * bookmark, and the substitution is genuinely usable — it just must not be silent. The caller
 * renders the notice; this decides what is true.
 */
export type FrameworkResolution =
  | { kind: "default"; id: AiBackend }
  | { kind: "honoured"; id: AiBackend }
  | { kind: "substituted"; id: AiBackend; requested: string };

export function resolveFramework(
  param: string | null | undefined
): FrameworkResolution {
  // An absent or empty param expresses no preference. Reporting it as a failed substitution
  // would be a false alarm on the most common path, and false alarms are how a notice earns
  // the reflex to be ignored.
  if (param == null || param === "") {
    return { kind: "default", id: DEFAULT_FRAMEWORK };
  }
  if (isKnownFramework(param)) {
    return { kind: "honoured", id: param as AiBackend };
  }
  // The id returned is always selectable — never the unknown value — so a caller cannot push
  // an unusable framework into the request body while showing the notice.
  return { kind: "substituted", id: DEFAULT_FRAMEWORK, requested: param };
}

export function topologiesFor(
  rungId: string,
  runtime: PythonBackend
): readonly Topology[] {
  const declared = RUNG_BY_ID[rungId as keyof typeof RUNG_BY_ID]?.runtimes?.[
    runtime
  ]?.topologies as readonly Topology[] | undefined;
  return declared && declared.length > 0 ? declared : ["react"];
}

/**
 * EVERY topology this build declares, across all conversation rungs and all
 * runtimes — the full mode vocabulary, not the subset the current cell serves.
 *
 * WHY THIS EXISTS ALONGSIDE `topologiesFor`. The two are deliberately different
 * questions and the Mode selector needs both:
 *
 *   topologiesFor(rung, runtime)  →  what you may choose right now
 *   ALL_TOPOLOGIES                →  what exists at all
 *
 * The selector RENDERS the first and COUNTS against the second, so it can say
 * "Mode (2 of 3)". The flat-button toolbar this replaced conveyed the shape of
 * the matrix for free — you could see there were three modes. A dropdown that
 * lists two and says nothing about the third loses that, and in a reference
 * implementation the shape of the matrix is part of what is being taught.
 *
 * It is NOT a list to render disabled. `deep-research` is absent from langchain
 * because langchain cannot run it — that is not obtainable, so it stays out of
 * the list. See the rule pair in components/ChatSelectors.tsx.
 *
 * Derived, never restated: a fork that adds a mode gets it here without editing
 * this file, and one that ejects a rung stops counting the modes only that rung
 * declared.
 */
export const ALL_TOPOLOGIES: readonly Topology[] = (() => {
  const seen = new Set<Topology>();
  for (const rung of RUNGS) {
    if (rung.shape !== "conversation") continue;
    for (const runtime of PYTHON_BACKENDS) {
      for (const t of topologiesFor(rung.id, runtime)) seen.add(t);
    }
  }
  return [...seen];
})();

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

/** The env var carrying a runtime's base URL. Named so errors can name it. */
export function envVarFor(runtime: PythonBackend): string {
  return runtime === "django" ? "DJANGO_URL" : "FASTAPI_URL";
}

/** The env var carrying a runtime's auth token, if any. */
export function authEnvVarFor(runtime: PythonBackend): string {
  return runtime === "django" ? "DJANGO_AUTH_TOKEN" : "FASTAPI_AUTH_TOKEN";
}

/**
 * Resolve a runtime's base URL and token from the environment.
 *
 * Takes `env` so this is testable without mutating the real process env.
 */
export function resolveBackendBase(
  runtime: PythonBackend,
  env: Record<string, string | undefined> = process.env
): { url: string | undefined; token: string | undefined } {
  return {
    url: env[envVarFor(runtime)],
    token: env[authEnvVarFor(runtime)],
  };
}

/**
 * Build the upstream URL for a (runtime, rung) pair.
 *
 * Django's URLconf requires the trailing slash and 404s without it; FastAPI
 * does not want one. apps/example handles this and open-swe's route did not,
 * because it only ever spoke to fastapi.
 */
export function buildBackendUrl(
  runtime: PythonBackend,
  baseUrl: string,
  aiBackend: string
): string {
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const trailing = runtime === "django" ? "/" : "";
  return `${root}/${aiBackend}${trailing}`;
}
