import { PlanCard } from "@deepagents-nextjs/react";
import { CARD, type CardPack } from "./registry";

/**
 * RUNG-4-OWNED — see ./deepagents.tsx for why the named import is safe here.
 *
 * `data-plan` is emitted only by openSweEnrich, so PlanCard is rung 4's. PlanProgress renders
 * INSIDE PlanCard and moves with it, which is why it needs no entry of its own. rungs.json's
 * `shared._rendererNote` is the ruling this follows.
 */
export const pack: CardPack = {
  "data-plan": (data) => <PlanCard plan={data as never} className={CARD} />,
};
