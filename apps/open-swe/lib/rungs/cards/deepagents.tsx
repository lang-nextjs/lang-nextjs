import { FileCard, SubAgentCard, TodoCard } from "@deepagents-nextjs/react";
import { CARD, type CardPack } from "./registry";

/**
 * RUNG-3-OWNED. Declared in rungs.json under `deepagents.owns.ts`, so `pnpm eject` deletes
 * this file with the rung and prunes the barrel line that re-exported it.
 *
 * These three cards render parts that deepagentsEnrich emits — the transform rung 3
 * contributes in ../chat/deepagents.ts. Rung 4 inherits them through `requires`, which is why
 * they belong to rung 3 rather than being duplicated: assign a card to the LOWEST rung that
 * emits its payload.
 *
 * Naming the cards here is correct precisely because this file dies with them. The same
 * import from a shared file is what made /chat unejectable.
 */
export const pack: CardPack = {
  "data-file": (data) => <FileCard file={data as never} className={CARD} />,
  "data-sub-agent": (data) => (
    <SubAgentCard subAgent={data as never} className={CARD} />
  ),
  "data-todo": (data) => <TodoCard todo={data as never} className={CARD} />,
};
