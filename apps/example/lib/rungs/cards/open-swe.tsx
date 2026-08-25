import { PlanCard } from "@deepagents-nextjs/react";
import type { DataPlan } from "@deepagents-nextjs/react";
import type { CardPack } from "./registry";

/**
 * RUNG-4-OWNED — see ./deepagents.tsx for why the named import is safe here.
 *
 * `data-plan` is emitted only by openSweEnrich, so PlanCard is rung 4's. PlanProgress
 * renders INSIDE PlanCard and moves with it, which is why it needs no entry of its own.
 *
 * This is the single symbol that made `eject deepagents` fail: one import, in one file,
 * breaking the whole fork's build.
 */
const BUBBLE = "max-w-sm rounded-xl border px-4 py-2 text-sm";

export const pack: CardPack = {
  "data-plan": (data) => (
    <PlanCard
      plan={data as DataPlan}
      className={`${BUBBLE} bg-info/10 border-info/40`}
    />
  ),
};
