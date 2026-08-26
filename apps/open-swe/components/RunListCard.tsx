"use client";

import Link from "next/link";
import type { Run } from "../lib/types";
import { relativeTime, statusBadge } from "../lib/run-badge";

export interface RunListCardProps {
  run: Run;
  className?: string;
}

export function RunListCard({
  run,
  className,
}: RunListCardProps): React.JSX.Element {
  const badge = statusBadge(run.status);
  const threadParam = run.thread_id
    ? `?threadId=${encodeURIComponent(run.thread_id)}`
    : "?threadId=default";

  return (
    <Link
      data-testid="run-detail-link"
      href={`/runs/${run.run_id}${threadParam}`}
      className="block"
    >
      <article
        data-testid="run-list-card"
        data-run-id={run.run_id}
        className={`group h-full rounded-xl border border-border bg-card/50 p-4 transition-colors hover:border-border hover:bg-card ${
          className ?? ""
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <p
            data-testid="run-task"
            className="line-clamp-2 text-sm font-medium text-foreground"
          >
            {run.task || "Untitled task"}
          </p>
          <span
            data-testid="run-status"
            // The state as DATA, not only as a colour class. A test, a screen
            // reader, and anyone diffing a DOM snapshot can all read this; none
            // of them can read a tailwind class. `actionable` is separate from
            // the status because "does this need me" is the question a person
            // scans a board to answer, and it is not derivable from the label.
            data-status={run.status}
            data-actionable={badge.actionable ? "true" : "false"}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
            {badge.label}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>local/workdir</span>
          <span className="text-muted-foreground">·</span>
          <time data-testid="run-created-at" dateTime={run.created_at}>
            {relativeTime(run.created_at)}
          </time>
        </div>
      </article>
    </Link>
  );
}
