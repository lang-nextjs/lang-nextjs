"use client";

import Link from "next/link";
import type { Run } from "../lib/types";

export interface RunListCardProps {
  run: Run;
  className?: string;
}

function statusBadge(status: Run["status"]): { label: string; cls: string; dot: string } {
  if (status === "completed")
    return { label: "Completed", cls: "text-emerald-400 border-emerald-500/20 bg-emerald-500/10", dot: "bg-emerald-400" };
  if (status === "failed")
    return { label: "Failed", cls: "text-red-400 border-red-500/20 bg-red-500/10", dot: "bg-red-400" };
  if (status === "running")
    return { label: "Running", cls: "text-blue-400 border-blue-500/20 bg-blue-500/10", dot: "bg-blue-400 animate-pulse" };
  return { label: status, cls: "text-neutral-400 border-neutral-600/30 bg-neutral-700/30", dot: "bg-neutral-500" };
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
        className={`group h-full rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900 ${className ?? ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <p
            data-testid="run-task"
            className="line-clamp-2 text-sm font-medium text-neutral-100"
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
        <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-neutral-500">
          <span>local/workdir</span>
          <span className="text-neutral-700">·</span>
          <time data-testid="run-created-at" dateTime={run.created_at}>
            {relativeTime(run.created_at)}
          </time>
        </div>
      </article>
    </Link>
  );
}
