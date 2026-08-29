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
 * PRUNING IS NOW LIVE, and this is the moment the previous version of this note
 * warned about. `langchain` is rung 1 and survives every ejection, so its
 * static import can never dangle. `langgraph` is rung 2 and CAN: `pnpm eject
 * langchain` deletes ai_backends/langgraph.ts, and an import left pointing at
 * it would break boot for exactly the fork that removed it — not one rung, the
 * whole backend, which is how main.py died with `NameError: name 'deepagents'
 * is not defined`.
 *
 * `pnpm eject` prunes an import whose target it deleted, and the eject
 * self-tests exercise that. What this file must not do is reference a module
 * anywhere OTHER than the import and this map — a name inside a function body
 * is not rewritten, and that is the precise shape of the main.py failure.
 * Everything downstream reads AI_BACKENDS.
 */
import * as langchain from "./ai_backends/langchain.js";
import * as langgraph from "./ai_backends/langgraph.js";
import type { ChatMessage } from "./ai_backends/langchain.js";

export interface AiBackendModule {
  TOPOLOGIES: Record<string, (messages: ChatMessage[]) => AsyncGenerator<string>>;
  warmup?: () => void;
}

export const AI_BACKENDS: Record<string, AiBackendModule> = {
  langchain,
  langgraph,
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
