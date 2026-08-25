import type { SseAdapter, SseTransform } from "@deepagents-nextjs/server";

/**
 * THE CHAT-ADAPTER BARREL — nothing but re-exports of rung-owned modules.
 *
 * Same mechanism as apps/example/lib/rungs/adapters/registry.ts and
 * ../home/registry.tsx: each `export … from "./<rung>"` line points at a module declared
 * under that rung's `owns.ts`, and `pnpm eject` deletes the module then prunes the line,
 * derived from the deletion set.
 *
 * WHY THIS FILE EXISTS AT ALL. app/api/chat/stream/route.ts held the exact shape
 * apps/example's registry warns against:
 *
 *     const ADAPTER_FOR_AI = { deepagents: deepagentsAdapter, langgraph: …, langchain: … }
 *
 * The named imports that table needs are precisely what eject prunes out of
 * `@deepagents-nextjs/server`, so a rung-1 fork failed to compile with four dangling
 * symbols. A table cannot be conditional; an import edge can, once it is rung-owned.
 *
 * THE ANCHOR BELOW IS LOAD-BEARING — DO NOT DELETE IT. `eject langchain` prunes every
 * re-export here, and a file with no imports and no exports is not a module, so
 * `import * as` against it fails TS2306 in exactly the fork it exists for. `ChatRungEntry`
 * carries no relative specifier and the pruner only removes `export … from "./x"` lines.
 */
export interface ChatRungEntry {
  /** The rung id, which is also the `aiBackend` the chat surface selects by. */
  readonly id: string;
  readonly adapter: SseAdapter;
  /**
   * Extra transforms this rung contributes to EVERY chat request.
   *
   * Optional, and only deepagents declares any today. See ./deepagents.ts for why they
   * apply to every backend rather than only to their own — it is pre-existing behaviour,
   * preserved deliberately rather than changed inside a severability fix.
   */
  readonly transforms?: () => SseTransform[];
}

export { entry as langchain } from "./langchain";
export { entry as langgraph } from "./langgraph";
export { entry as deepagents } from "./deepagents";
