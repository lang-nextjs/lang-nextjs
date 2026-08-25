"use client";

import Link from "next/link";
import type { Run } from "../lib/types";

export interface RunListCardProps {
  run: Run;
  className?: string;
}

function statusBadge(status: Run["status"]): {
  label: string;
  cls: string;
  dot: string;
} {
  if (status === "completed")
    return {
      label: "Completed",
      cls: "text-success border-success/20 bg-success/10",
      dot: "bg-success",
    };
  if (status === "failed")
    return {
      label: "Failed",
      cls: "text-destructive border-destructive/20 bg-destructive/10",
      dot: "bg-destructive",
    };
  if (status === "running")
    return {
      label: "Running",
      cls: "text-info border-info/20 bg-info/10",
      dot: "bg-info animate-pulse",
    };
  return {
    label: status,
    cls: "text-muted-foreground border-border/30 bg-muted/30",
    dot: "bg-muted-foreground",
  };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
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
