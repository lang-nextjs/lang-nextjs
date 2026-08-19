/**
 * Collect the DeepAgents `data-*` parts out of a run's stream events into the
 * latest-by-id card models the run page renders.
 *
 * The open-swe adapter emits a data-* part keyed by the originating toolCallId
 * (or, for the plan, the save_plan toolCallId). Parts are UPSERTED by id — a
 * later part with the same id replaces the earlier one (e.g. a sub-agent going
 * `starting` → `done`). Each consumed id is recorded in `enrichedToolCallIds`
 * so the run page can hide the raw ToolCard for tools that already render as a
 * rich card (avoids showing write_file as both a ToolCard and a FileCard).
 */
import {
  parseDataPart,
  type DataPlan,
  type DataFile,
  type DataSubAgent,
  type DataApproval,
} from "@deepagents-nextjs/react";
import type { StreamEvent } from "./types";

export interface AgentParts {
  /** Latest plan (highest seq), or null if the agent never planned. */
  plan: DataPlan | null;
  files: DataFile[];
  subAgents: DataSubAgent[];
  approvals: DataApproval[];
  /** toolCallIds that produced a rich card — hide their raw ToolCard. */
  enrichedToolCallIds: Set<string>;
}

export function collectAgentParts(events: StreamEvent[]): AgentParts {
  const plans = new Map<string, DataPlan>();
  const files = new Map<string, DataFile>();
  const subAgents = new Map<string, DataSubAgent>();
  const approvals = new Map<string, DataApproval>();
  const enriched = new Set<string>();

  for (const event of events) {
    if (typeof event.type !== "string" || !event.type.startsWith("data-")) {
      continue;
    }
    const result = parseDataPart(event);
    if (!result.ok) continue;
    switch (result.type) {
      case "data-plan": {
        const d = result.data as DataPlan;
        plans.set(d.id, d);
        enriched.add(d.id);
        break;
      }
      case "data-file": {
        const d = result.data as DataFile;
        files.set(d.id, d);
        enriched.add(d.id);
        break;
      }
      case "data-sub-agent": {
        const d = result.data as DataSubAgent;
        subAgents.set(d.id, d);
        enriched.add(d.id);
        break;
      }
      case "data-approval": {
        const d = result.data as DataApproval;
        approvals.set(d.id, d);
        enriched.add(d.id);
        break;
      }
      default:
        break;
    }
  }

  const bySeq = <T extends { seq: number }>(a: T, b: T) => a.seq - b.seq;
  const plan = [...plans.values()].sort(bySeq).pop() ?? null;

  return {
    plan,
    files: [...files.values()].sort(bySeq),
    subAgents: [...subAgents.values()].sort(bySeq),
    approvals: [...approvals.values()].sort(bySeq),
    enrichedToolCallIds: enriched,
  };
}
