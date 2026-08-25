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
 * TaskCard — minimal UI for the data-task part.
 *
 * Renders the task name with a status badge plus optional description and
 * group label. No opinionated styling.
 *
 * DECLARED, NO PRODUCER (issue #50). Nothing in this repository emits a
 * `data-task` frame — not the Python backends, not the adapters, not the
 * transforms. The only code that constructs one is test fixtures, so this
 * component's tests prove it renders a well-formed part correctly and prove
 * nothing about the part being reachable in a live stream.
 *
 * The part stays declared in `docs/sse-frame-schema.json` on purpose: it is a
 * published contract a consumer may already build against, and deleting it
 * would silently narrow a schema this repo publishes. If you are forking and
 * this card never renders, that is EXPECTED — it is not a bug in your fork.
 * A producer is tracked as follow-up work.
 */
export function TaskCard({
  task,
  className,
}: TaskCardProps): React.JSX.Element {
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
