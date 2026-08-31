import type { ReactNode } from "react";

/**
 * THE CARD BARREL — re-exports of rung-owned card packs, and nothing else.
 *
 * Same mechanism as ../adapters/registry.ts: each line points at a module declared under a
 * rung's `owns.ts`, `pnpm eject` deletes the module and prunes the line. See that file for
 * why a barrel rather than a table, and why the anchor below must not be deleted.
 *
 * ONLY RUNG-OWNED PARTS BELONG HERE — and the unit is the PART TYPE, not the CARD (#492).
 *
 * This said "cards", and the imprecision cost something: `data-approval` is emitted only by
 * openSweEnrich (rung 4) but rendered by the SHARED ApprovalCard, so reasoning per card
 * filed it under "shared, renders inline" and left the branch in a file ejection cannot
 * touch. Its emitter was pruned with rung 4 and its renderer was not.
 *
 * A shared component may render a rung-owned part. What ejection has to prune is the ENTRY
 * that says "this build renders this part" — which is what a pack is. ApprovalCard, HumanResponseCard, TaskCard and
 * AgentsMdCard are `shared` — the parts they render come from approval-gating.ts, which #30
 * moved into core, or have no emitter at all (#50). Filing those under a rung would make
 * `eject langgraph` delete the UI for a core feature, so ConversationSurface renders them
 * inline. rungs.json's `shared._rendererNote` records that reasoning per card.
 */
/**
 * What a rung card may need beyond its payload.
 *
 * OPTIONAL, AND SECOND, so every existing renderer keeps its signature and is unaffected.
 * It exists because a card that MOVED out of a surface must not lose the surface's
 * behaviour on the way — the example app's approval card continues the conversation when
 * a decision is made, and a renderer taking only `data` could not do that. Rendering it
 * inert instead would have been a silent regression dressed as an ownership fix.
 */
export type CardContext = {
  /** Continue the conversation with a message, where the surface supports it. */
  readonly sendMessage?: (text: string) => void;
};

export type CardRenderer = (data: unknown, ctx?: CardContext) => ReactNode;

/** Stream part type (`data-todo`, `data-plan`, …) → the component that renders it. */
export type CardPack = Readonly<Record<string, CardRenderer>>;

export { pack as deepagentsCards } from "./deepagents";
export { pack as openSweCards } from "./open-swe";
