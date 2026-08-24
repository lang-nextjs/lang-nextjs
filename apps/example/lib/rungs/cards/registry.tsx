import type { ReactNode } from "react";

/**
 * THE CARD BARREL — re-exports of rung-owned card packs, and nothing else.
 *
 * Same mechanism as ../adapters/registry.ts: each line points at a module declared under a
 * rung's `owns.ts`, `pnpm eject` deletes the module and prunes the line. See that file for
 * why a barrel rather than a table, and why the anchor below must not be deleted.
 *
 * ONLY RUNG-OWNED CARDS BELONG HERE. ApprovalCard, HumanResponseCard, TaskCard and
 * AgentsMdCard are `shared` — the parts they render come from approval-gating.ts, which #30
 * moved into core, or have no emitter at all (#50). Filing those under a rung would make
 * `eject langgraph` delete the UI for a core feature, so ConversationSurface renders them
 * inline. rungs.json's `shared._rendererNote` records that reasoning per card.
 */
export type CardRenderer = (data: unknown) => ReactNode;

/** Stream part type (`data-todo`, `data-plan`, …) → the component that renders it. */
export type CardPack = Readonly<Record<string, CardRenderer>>;

export { pack as deepagentsCards } from "./deepagents";
export { pack as openSweCards } from "./open-swe";
