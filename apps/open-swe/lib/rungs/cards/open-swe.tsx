import { ApprovalCard, PlanCard } from "@deepagents-nextjs/react";
import { CARD } from "./card-class";
import type { CardPack } from "./registry";

/**
 * RUNG-4-OWNED — see ./deepagents.tsx for why the named import is safe here.
 *
 * `data-plan` is emitted only by openSweEnrich, so PlanCard is rung 4's. PlanProgress renders
 * INSIDE PlanCard and moves with it, which is why it needs no entry of its own. rungs.json's
 * `shared._rendererNote` is the ruling this follows.
 */
/*
 * THE APPROVAL CARD IS SHARED; THIS PART TYPE IS NOT (#492).
 *
 * `ApprovalCard` stays in `@deepagents-nextjs/react` and /chat still renders it inline for
 * `data-approval-required` — that part comes from approval-gating.ts, which #30 moved into
 * core, and filing it under a rung would delete the UI for a core feature. That ruling is
 * recorded in rungs.json's `shared._rendererNote` and it is correct.
 *
 * It names `data-approval-required`. The BARE `data-approval` is a different part with a
 * different emitter: openSweEnrich, which is rung-4-owned. Under the manifest's own rule —
 * assign to the LOWEST rung that EMITS the payload — it belongs here, exactly as `data-plan`
 * does, and for exactly the same reason.
 *
 * The distinction is per PART TYPE, not per CARD. A shared component can render a rung-owned
 * part; what ejection must prune is the entry that says "this build renders this part", not
 * the component. Reasoning per card is what left this branch inline while its emitter was
 * pruned, so every fork below rung 4 shipped a renderer for a frame it could never receive.
 */
const APPROVAL_CARD = `${CARD} flex flex-col gap-2`;

export const pack: CardPack = {
  "data-plan": (data) => <PlanCard plan={data as never} className={CARD} />,
  "data-approval": (data) => (
    <div>
      <ApprovalCard
        approval={data as never}
        className={APPROVAL_CARD}
        disabled
        onApprove={() => {}}
        onReject={() => {}}
      />
      <p
        data-testid="approval-not-gated"
        role="status"
        className="text-warning border-warning/30 bg-warning/10 mt-1 rounded border px-2 py-1 text-[11px]"
      >
        This approval did not come from the run gate, so it cannot be resolved
        here.
      </p>
    </div>
  ),
};
