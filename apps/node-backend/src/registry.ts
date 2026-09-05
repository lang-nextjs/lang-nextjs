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
 * PRUNING IS NOW LIVE, and the first version of this file got it wrong. It
 * imported each rung by name and asserted eject would prune the import. IT DOES
 * NOT — eject's registry pruning is a hardcoded list of Python files with
 * Python-specific regexes, and it caught the claim by refusing to eject:
 *
 *   FAIL: ejecting to "langchain" would leave 1 dangling reference(s):
 *          registry.ts imports "./ai_backends/langgraph.js", which this eject deleted
 *
 * What eject prunes generically is a BARREL re-export whose target is gone. So
 * the rung modules are reached through ai_backends/index.ts, which is the only
 * file that names any of them, and the map below is DERIVED from it.
 */
import * as backends from "./ai_backends/index.js";
import type { ChatMessage } from "./ai_backends/langchain.js";

export interface AiBackendModule {
  TOPOLOGIES: Record<
    string,
    (messages: ChatMessage[]) => AsyncGenerator<string>
  >;
  warmup?: () => void;
}

/**
 * DERIVED FROM THE BARREL, never listed here.
 *
 * A literal map would name every rung a second time, and eject prunes the
 * barrel line but not a map entry — so `eject langchain` would leave
 * `langgraph` in this object pointing at nothing. Deriving it means the map
 * follows what is actually present, and adding a rung touches one line in
 * ai_backends/index.ts and nothing at all here.
 *
 * The `TOPOLOGIES` test is what distinguishes a backend module from anything
 * else the barrel might one day re-export; it is the same contract main.py's
 * `_MODULES` requires of its entries.
 *
 * Keys are SORTED so /health is deterministic. ESM namespace objects already
 * enumerate in sorted order, but relying on that silently would make the
 * response shape depend on a language detail nothing here states.
 */
export const AI_BACKENDS: Record<string, AiBackendModule> = Object.fromEntries(
  Object.entries(backends as Record<string, unknown>)
    .filter(
      (entry): entry is [string, AiBackendModule] =>
        typeof entry[1] === "object" &&
        entry[1] !== null &&
        "TOPOLOGIES" in (entry[1] as Record<string, unknown>)
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
);

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

/**
 * Warm every backend, and REPORT rather than die.
 *
 * This threw the process away at boot. index.ts asserted the opposite — "a missing model key
 * is NOT a construction error here; makeLlm() falls through to Anthropic and only fails on
 * use" — and that was never true: `new ChatAnthropic(...)` validates its key in the
 * constructor, so `warmAll()` raised "Anthropic API key not found" before `listen()` was ever
 * reached. A comment describing behaviour nobody had run (#360).
 *
 * It matters beyond tidiness. Django and FastAPI both start without a model key, which is why
 * the routing suite can prove which process answered without one; node could not, so no e2e
 * job could ever drive it live. The backend that claims to be a translation of main.py has to
 * boot on the same inputs main.py boots on.
 *
 * The original intent survives: a WIRING error still surfaces at startup instead of on a
 * user's first message — it is named in the returned status and logged by the caller. What
 * changes is that it no longer takes /health down with it, and a process that cannot answer
 * /health is a process nobody can diagnose.
 */
export function warmAll(): { backend: string; ok: boolean; error?: string }[] {
  return Object.entries(AI_BACKENDS).map(([backend, mod]) => {
    try {
      mod.warmup?.();
      return { backend, ok: true };
    } catch (err) {
      return {
        backend,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export type { ChatMessage };
