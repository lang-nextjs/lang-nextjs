import { ApprovalCard, PlanCard } from "@deepagents-nextjs/react";
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

/*
 * `data-approval` IS RUNG 4'S, THOUGH `ApprovalCard` IS SHARED (#492).
 *
 * See the open-swe app's pack for the full argument. In short: the bare `data-approval` part
 * is emitted only by openSweEnrich, which is rung-4-owned, so under the manifest's own rule
 * it belongs here — while `data-approval-required`, which comes from core, stays inline.
 *
 * THE HANDLERS COME FROM THE CONTEXT rather than being dropped. This surface's approval
 * decisions continue the conversation, and that behaviour has to survive the move: a renderer
 * that took only `data` would have had to render the card inert, which is a silent regression
 * wearing an ownership fix's clothes.
 */
export const pack: CardPack = {
  "data-plan": (data) => (
    <PlanCard
      plan={data as DataPlan}
      className={`${BUBBLE} bg-info/10 border-info/40`}
    />
  ),
  "data-approval": (data, ctx) => {
    const approval = data as { actionName: string };
    return (
      <ApprovalCard
        approval={data as never}
        className={`${BUBBLE} bg-destructive/10 border-destructive/40`}
        onApprove={() => ctx?.sendMessage?.(`Approved: ${approval.actionName}`)}
        onReject={() => ctx?.sendMessage?.(`Rejected: ${approval.actionName}`)}
      />
    );
  },
};
