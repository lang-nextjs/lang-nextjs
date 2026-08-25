import { PlanCard } from "@deepagents-nextjs/react";
import type { CardPack } from "./registry";

/**
 * RUNG-4-OWNED. PlanCard renders `data-plan`, which openSweEnrich emits — so the card
 * belongs to rung 4 even though it appears on the shared /chat surface. A fork below rung 4
 * keeps /chat and simply never receives a data-plan part to render.
 */
const CARD = "w-full";

export const pack: CardPack = {
  "data-plan": (d) => <PlanCard plan={d as never} className={CARD} />,
};
