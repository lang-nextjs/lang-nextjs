/**
 * WHICH AI BACKENDS THIS RUNTIME SERVES — the `_MODULES` of main.py.
 *
 * EVERYTHING DOWNSTREAM READS THIS MAP AND NEVER NAMES A MODULE. That rule is
 * inherited rather than invented: main.py's warmup block and its `/api/tools`
 * handler both used to reference `deepagents.*` and `langgraph.*` literally,
 * and `pnpm eject langchain` — which prunes the import list and the dict but
 * does not rewrite function bodies — produced a fork that died at boot with
 * `NameError: name 'deepagents' is not defined`. Not one rung: the whole
 * backend.
 *
 * TODAY THIS MAP HAS ONE ENTRY AND CANNOT BE PRUNED. `langchain` is rung 1, the
 * bottom of the ladder, so every ejection keeps it — `eject langgraph` keeps
 * rungs 1-2, `eject deepagents` keeps 1-3, and `eject langchain` keeps rung 1
 * alone. So the static import below is safe in a way it will STOP being safe
 * the moment rung 2 or 3 lands here (#9, #10): those entries must be pruned by
 * eject along with their files, and an import left behind would break boot for
 * exactly the fork that removed them.
 */
import * as langchain from "./ai_backends/langchain.js";
import type { ChatMessage } from "./ai_backends/langchain.js";

export interface AiBackendModule {
  TOPOLOGIES: Record<string, (messages: ChatMessage[]) => AsyncGenerator<string>>;
  warmup?: () => void;
}

export const AI_BACKENDS: Record<string, AiBackendModule> = {
  langchain,
};

/** Mirrors main.py's module-level `DEFAULT_TOPOLOGY = "react"`. */
export const DEFAULT_TOPOLOGY = "react";

/**
 * The legacy single-backend endpoint's target.
 *
 * `POST /api/chat/stream` (no ai_backend in the path) defaults to "deepagents"
 * in both Python runtimes, and this runtime does not serve that rung yet. The
 * name is kept anyway rather than repointed at the one backend that IS here:
 * repointing would make the same URL mean different things on different
 * runtimes, which is the one property the shared contract exists to prevent.
 * As it stands the legacy route 404s naming what this runtime actually has,
 * which is true and diagnosable.
 */
export const LEGACY_AI_BACKEND = "deepagents";

export function topologiesByBackend(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(AI_BACKENDS).map(([id, mod]) => [
      id,
      Object.keys(mod.TOPOLOGIES),
    ])
  );
}

export function warmAll(): void {
  for (const mod of Object.values(AI_BACKENDS)) {
    mod.warmup?.();
  }
}

export type { ChatMessage };
