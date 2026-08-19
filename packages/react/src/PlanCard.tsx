"use client";

import { useRef } from "react";
import type { DataPlan, PlanSubtask } from "./schemas";
import { PlanProgress } from "./PlanProgress";

export interface PlanCardProps {
  /** Parsed data-plan payload from the stream. */
  plan: DataPlan;
  /** Optional click handler per-subtask — useful for letting the user toggle. */
  onSubtaskClick?: (subtask: PlanSubtask) => void;
  /** Pass-through className for the outer wrapper — consumers style it. */
  className?: string;
  /**
   * When true, render plan.markdown as a preformatted block. Default true.
   * Set false to suppress (e.g. if the consumer renders its own markdown).
   */
  showMarkdown?: boolean;
}

function subtaskStatusLabel(status: PlanSubtask["status"]): string {
  if (status === "done") return "✓";
  if (status === "in-progress") return "◐";
  return "○";
}

export function PlanCard({
  plan,
  onSubtaskClick,
  className,
  showMarkdown = true,
}: PlanCardProps): React.JSX.Element {
  const prevSubtasksRef = useRef<Map<string, PlanSubtask>>(new Map());
  const prevMap = prevSubtasksRef.current;
  const currentMap = new Map(plan.subtasks.map((s) => [s.id, s]));

  const counts = plan.subtasks.reduce(
    (acc, s) => {
      acc[s.status] += 1;
      return acc;
    },
    { pending: 0, "in-progress": 0, done: 0 } as Record<
      PlanSubtask["status"],
      number
    >
  );

  const doneCount = counts.done;
  const totalCount = plan.subtasks.length;

  const result = (
    <section
      data-testid="plan-card"
      data-plan-id={plan.id}
      data-plan-seq={plan.seq}
      className={className}
      aria-label={`Plan: ${plan.title}`}
    >
      <header>
        <h3 data-testid="plan-title">{plan.title}</h3>
        <p data-testid="plan-summary">
          {counts.done} of {plan.subtasks.length} done
        </p>
        <time data-testid="plan-updated-at" dateTime={plan.updatedAt}>
          {plan.updatedAt}
        </time>
      </header>

      <PlanProgress doneCount={doneCount} totalCount={totalCount} />

      {showMarkdown && plan.markdown && (
        <pre data-testid="plan-markdown">{plan.markdown}</pre>
      )}

      <ol data-testid="plan-subtasks">
        {plan.subtasks.map((sub) => {
          const prev = prevMap.get(sub.id);
          const isNew = !prev;
          const transition =
            prev && prev.status !== sub.status
              ? `${prev.status}->${sub.status}`
              : undefined;

          return (
            <li
              key={sub.id}
              data-testid="plan-subtask"
              data-subtask-id={sub.id}
              data-subtask-status={sub.status}
              {...(transition ? { "data-subtask-transition": transition } : {})}
              {...(isNew ? { "data-subtask-new": "true" } : {})}
            >
              {onSubtaskClick ? (
                <button
                  type="button"
                  data-testid="plan-subtask-button"
                  onClick={() => onSubtaskClick(sub)}
                >
                  <span data-testid="plan-subtask-icon" aria-hidden>
                    {subtaskStatusLabel(sub.status)}
                  </span>
                  <span data-testid="plan-subtask-label">{sub.label}</span>
                </button>
              ) : (
                <>
                  <span data-testid="plan-subtask-icon" aria-hidden>
                    {subtaskStatusLabel(sub.status)}
                  </span>
                  <span data-testid="plan-subtask-label">{sub.label}</span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );

  prevSubtasksRef.current = currentMap;
  return result;
}
