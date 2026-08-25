"use client";

import { useState, useCallback } from "react";
import {
  PlanCard,
  ApprovalCard,
  SubAgentCard,
  FileCard,
} from "@deepagents-nextjs/react";
import { collectAgentParts } from "../lib/agent-parts";
import type { StreamEvent, ToolCallState } from "../lib/types";
import { ToolCard } from "./ToolCard";

interface AgentNarrativeProps {
  events: StreamEvent[];
  toolCalls: ToolCallState[];
  /** Thread the run belongs to — needed to dispatch the plan-approval follow-up run. */
  threadId: string;
  runId: string;
}

/**
 * Renders open-swe's full agent narrative from the stream: plan, human-in-the-
 * loop plan-approval gate, sub-agents, file artifacts, and the remaining tool
 * calls (those NOT already shown as a rich card). Replaces the previous
 * raw-text + flat-ToolCard view.
 */
export function AgentNarrative({
  events,
  toolCalls,
  threadId,
  runId,
}: AgentNarrativeProps) {
  const { plan, files, subAgents, approvals, enrichedToolCallIds } =
    collectAgentParts(events);

  // Track which approvals have a decision in flight / resolved locally, so the
  // ApprovalCard buttons disable immediately (open-swe resolves the gate by
  // dispatching a NEW run — this stream does not change after the POST).
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolved, setResolved] = useState<
    Record<string, "approve" | "reject">
  >({});

  const decide = useCallback(
    async (
      approvalId: string,
      decision: "approve" | "reject",
      feedback?: string
    ) => {
      setResolving((r) => ({ ...r, [approvalId]: true }));
      try {
        const res = await fetch(`/api/open-swe/runs/${runId}/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, decision, feedback }),
        });
        if (!res.ok) throw new Error(`plan ${decision} failed: ${res.status}`);
        setResolved((r) => ({ ...r, [approvalId]: decision }));
      } finally {
        setResolving((r) => ({ ...r, [approvalId]: false }));
      }
    },
    [runId, threadId]
  );

  const unenrichedTools = toolCalls.filter(
    (t) => !enrichedToolCallIds.has(t.toolCallId)
  );

  return (
    <div data-testid="agent-narrative">
      {plan && (
        <section aria-label="Plan">
          <PlanCard plan={plan} />
        </section>
      )}

      {approvals.length > 0 && (
        <section aria-label="Approvals">
          {approvals.map((approval) => {
            const localDecision = resolved[approval.id];
            // Reflect a locally-resolved decision in the card status so it
            // stops showing "waiting" before the next run's stream arrives.
            const shown =
              localDecision === "approve"
                ? { ...approval, status: "approved" as const }
                : localDecision === "reject"
                ? { ...approval, status: "rejected" as const }
                : approval;
            return (
              <ApprovalCard
                key={approval.id}
                approval={shown}
                disabled={shown.status !== "waiting" || resolving[approval.id]}
                onApprove={() => decide(approval.id, "approve")}
                onReject={() => decide(approval.id, "reject")}
                onRespond={(text) => decide(approval.id, "reject", text)}
              />
            );
          })}
        </section>
      )}

      {subAgents.length > 0 && (
        <section aria-label="Sub-agents">
          {subAgents.map((sa) => (
            <SubAgentCard key={sa.id} subAgent={sa} />
          ))}
        </section>
      )}

      {files.length > 0 && (
        <section aria-label="Files">
          {files.map((f) => (
            <FileCard key={f.id} file={f} />
          ))}
        </section>
      )}

      {unenrichedTools.length > 0 && (
        <section aria-label="Tool calls">
          {unenrichedTools.map((tool) => (
            <ToolCard key={tool.toolCallId} tool={tool} />
          ))}
        </section>
      )}
    </div>
  );
}
