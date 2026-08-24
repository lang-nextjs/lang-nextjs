import type { SseAdapter } from "@deepagents-nextjs/server";

/**
 * THE ADAPTER BARREL — nothing but re-exports of rung-owned modules, on purpose.
 *
 * Each `export … from "./<rung>"` line points at a module that rungs.json declares under
 * that rung's `owns.ts`. `pnpm eject` deletes the module and then prunes the line, derived
 * from the deletion set rather than from any list kept here (scripts/eject.mjs, "Prune barrel
 * re-exports whose target no longer exists"). So this file shrinks to exactly the rungs a
 * fork retained, and needs no eject machinery of its own.
 *
 * WHY A BARREL RATHER THAN A TABLE
 *   `const ADAPTERS = { deepagents: deepagentsAdapter, … }` is the obvious shape and cannot
 *   work: the named imports it needs are exactly what eject prunes out of
 *   `@deepagents-nextjs/server`, so a fork fails to compile. You cannot conditionally import.
 *   Making the import edges themselves rung-owned moves the problem to where eject already
 *   solves it.
 *
 * THE ANCHOR BELOW IS LOAD-BEARING — DO NOT DELETE IT
 *   `eject langchain` prunes every re-export in this file. A file with no imports and no
 *   exports is not a module, and `import * as` against it fails with TS2306 — so the fix
 *   would break in precisely the fork it exists for. `AdapterEntry` carries no relative
 *   specifier, and the pruner only removes lines matching `export … from "./x"`, so this
 *   stays a module even when it holds no adapters. Verified by ejecting, not assumed.
 */
export interface AdapterEntry {
  /** The rung id, which is also the `aiBackend` the demo selects by. */
  readonly id: string;
  readonly adapter: SseAdapter;
}

export { entry as langchain } from "./langchain";
export { entry as langgraph } from "./langgraph";
export { entry as deepagents } from "./deepagents";
