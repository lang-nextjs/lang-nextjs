"use client";

import type { DataTask } from "./schemas";

export interface TaskCardProps {
  /** Parsed data-task payload from the stream. */
  task: DataTask;
  /** Pass-through className for the outer wrapper. */
  className?: string;
}

function statusBadge(status: DataTask["status"]): string {
  if (status === "done") return "done";
  if (status === "in-progress") return "in-progress";
  return "pending";
}

/**
 * TaskCard — minimal UI for DeepAgents' data-task artifact.
 *
 * Renders the task name with a status badge plus optional description and
 * group label. No opinionated styling.
 */
export function TaskCard({ task, className }: TaskCardProps): React.JSX.Element {
  return (
    <article
      data-testid="task-card"
      data-task-id={task.id}
      data-task-seq={task.seq}
      data-task-status={task.status}
      className={className}
      aria-label={`Task: ${task.taskName}`}
    >
      {task.groupLabel ? (
        <p data-testid="task-group">{task.groupLabel}</p>
      ) : null}
      <h4 data-testid="task-name">{task.taskName}</h4>
      <span data-testid="task-status">{statusBadge(task.status)}</span>
      {task.description ? (
        <p data-testid="task-description">{task.description}</p>
      ) : null}
    </article>
  );
}
