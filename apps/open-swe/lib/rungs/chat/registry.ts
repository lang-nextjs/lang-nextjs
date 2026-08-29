import type { SseAdapter, SseTransform } from "@deepagents-nextjs/server";

/**
 * THE CHAT ADAPTER BARREL — nothing but re-exports of rung-owned modules, on purpose.
 *
 * Each `export … from "./<rung>"` line points at a module that rungs.json declares under
 * that rung's `owns.ts`. `pnpm eject` deletes the module and then prunes the line, derived
 * from the deletion set rather than from any list kept here (scripts/eject.mjs, "Prune barrel
 * re-exports whose target no longer exists"). So this file shrinks to exactly the rungs a
 * fork retained, and needs no eject machinery of its own.
 *
 * WHY THIS EXISTS AT ALL. /chat used to hold `const ADAPTER_FOR_AI = { deepagents:
 * deepagentsAdapter, langgraph: langGraphAdapter, langchain: langchainAdapter }` — three
 * named imports of rung-owned symbols in a route that is supposed to be shared. `pnpm eject
 * langchain` prunes `deepagentsAdapter` and `langGraphAdapter` out of
 * `@deepagents-nextjs/server`, and the fork then fails to compile. You cannot conditionally
 * import. Making the import EDGES rung-owned moves the problem to where eject already solves
 * it. Same mechanism as apps/example/lib/rungs/adapters/registry.ts; see that file for the
 * longer form of the argument.
 *
 * THE ANCHOR BELOW IS LOAD-BEARING — DO NOT DELETE IT.
 *   `eject langchain` prunes every re-export in this file down to one. A file with no
 *   imports and no exports is not a module, and `import * as` against it fails with TS2306.
 *   `ChatRungEntry` carries no relative specifier, and the pruner only removes lines matching
 *   `export … from "./x"`, so this stays a module even when it holds no entries.
 */
export interface ChatRungEntry {
  /** The rung id, which is also the `aiBackend` the chat surface selects by. */
  readonly id: string;
  readonly adapter: SseAdapter;
  /**
   * Stream transforms this rung contributes, built fresh per request.
   *
   * A FUNCTION, not an array: `createDeepAgentsEnrichTransform()` returns a stateful closure
   * and a module-level instance would be shared across every concurrent chat. The route calls
   * this once per request, which is the same lifetime the inline `transforms: [...]` array it
   * replaces had.
   *
   * The APPROVAL GATE is deliberately NOT here. It is core — approval-gating.ts was moved
   * into core by #30 — so a rung entry contributing it would make `eject langgraph` delete
   * the gate for a feature every fork keeps. The shared route appends it AFTER whatever this
   * returns, which preserves the ordering the gate depends on: enrichment rewrites the frames
   * first, and the gate decides on the tool-input-start frames that survive that.
   */
  readonly transforms?: () => SseTransform[];
}

export { entry as langchain } from "./langchain";
export { entry as langgraph } from "./langgraph";
export { entry as deepagents } from "./deepagents";
