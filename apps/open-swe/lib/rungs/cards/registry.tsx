import type { ReactNode } from "react";

/**
 * THE CARD BARREL — re-exports of rung-owned card packs, and nothing else.
 *
 * Same mechanism as ../chat/registry.ts and apps/example/lib/rungs/cards/registry.tsx:
 * each line points at a module declared under a rung's `owns.ts`; `pnpm eject` deletes the
 * module and prunes the line, derived from the deletion set.
 *
 * ONLY RUNG-OWNED CARDS BELONG HERE. app/chat/page.tsx named PlanCard, FileCard,
 * SubAgentCard and TodoCard directly, and all four are pruned out of
 * @deepagents-nextjs/react by eject — three at rung 3, PlanCard at rung 4 — so a rung-1
 * fork failed to compile on four dangling symbols.
 *
 * THE ANCHOR BELOW IS LOAD-BEARING — see ../chat/registry.ts.
 */
export type CardRenderer = (data: unknown) => ReactNode;

/** Stream part type (`data-todo`, `data-plan`, …) → the component that renders it. */
export type CardPack = Readonly<Record<string, CardRenderer>>;

export { pack as deepagentsCards } from "./deepagents";
export { pack as openSweCards } from "./open-swe";
