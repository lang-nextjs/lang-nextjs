"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useRunStream } from "../../../lib/hooks/useRunStream";
import { useToolState } from "../../../lib/hooks/useToolState";
import { useThreadState } from "../../../lib/hooks/useThreadState";
import { AgentNarrative } from "../../../components/AgentNarrative";
import { ConversationView } from "../../../components/ConversationView";
import { AgentModeBanner } from "../../../components/AgentModeBanner";
import type { ThreadRunStatus } from "../../../lib/thread-state";

function StatusBadge({
  status,
}: {
  status: ThreadRunStatus | "streaming" | "loading";
}) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    streaming: {
      label: "Running",
      cls: "text-info border-info/20 bg-info/10",
      dot: "bg-info animate-pulse",
    },
    running: {
      label: "Running",
      cls: "text-info border-info/20 bg-info/10",
      dot: "bg-info animate-pulse",
    },
    pending: {
      label: "Pending",
      cls: "text-warning border-warning/20 bg-warning/10",
      dot: "bg-warning",
    },
    interrupted: {
      label: "Awaiting approval",
      cls: "text-warning border-warning/20 bg-warning/10",
      dot: "bg-warning",
    },
    completed: {
      label: "Completed",
      cls: "text-success border-success/20 bg-success/10",
      dot: "bg-success",
    },
    failed: {
      label: "Failed",
      cls: "text-destructive border-destructive/20 bg-destructive/10",
      dot: "bg-destructive",
    },
    idle: {
      // Deliberately not green and deliberately not "Completed". The thread is
      // not executing; whether its run finished is a different question this
      // page cannot answer from thread state alone (#176).
      label: "Idle (thread)",
      cls: "text-muted-foreground border-border/30 bg-muted/30",
      dot: "bg-muted-foreground",
    },
    unknown: {
      // Warning, not success. A status we could not read is the one case where
      // guessing "finished" is actively misleading.
      label: "Unknown",
      cls: "text-warning border-warning/20 bg-warning/10",
      dot: "bg-warning",
    },
    loading: {
      label: "Loading",
      cls: "text-muted-foreground border-border/30 bg-muted/30",
      dot: "bg-muted-foreground",
    },
  };
  const b = map[status] ?? map.loading;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${b.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />
      {b.label}
    </span>
  );
}

function RunDetailContent() {
  const { runId } = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("threadId") ?? "";

  const {
    items,
    status: threadStatus,
    loading: stateLoading,
    error: stateError,
    refetch,
    provenance,
  } = useThreadState(runId, threadId, !!threadId);

  // Stream only while the run is actually active. A finished run can't be
  // live-streamed (its stream is already closed) — render history instead,
  // which is why clicking a completed run no longer shows a bogus error.
  const isLive = threadStatus === "running" || threadStatus === "pending";

  const {
    events,
    status: streamStatus,
    error: streamError,
    cancel,
  } = useRunStream({ runId, threadId, enabled: isLive });

  const toolCalls = useToolState(events);
  const streamText = events
    .filter((e) => e.type === "text-delta")
    .map((e) => (e as { type: "text-delta"; delta: string }).delta)
    .join("");

  // When a live run finishes streaming, reload thread state so the page flips
  // from the live view to the persisted history (final messages + files).
  useEffect(() => {
    if (isLive && streamStatus === "done") refetch();
  }, [isLive, streamStatus, refetch]);

  if (!threadId) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 lg:p-6">
        <p data-testid="missing-thread-id" className="text-sm text-destructive">
          threadId is required. Pass ?threadId=… in the URL.
        </p>
      </div>
    );
  }

  const task = items.find((i) => i.kind === "user")?.text ?? "";
  const canCancel =
    streamStatus === "streaming" || streamStatus === "connecting";

  return (
    <div className="min-h-full">
      {/*
       * A content toolbar, not a second header bar. The back link and live
       * status are navigation and state — worth keeping — but AppShell already
       * renders the app header, so stacking another full-bleed bar under it
       * read as two chrome rows, and the <main> below was a second landmark
       * inside SidebarInset's.
       */}
      <div className="mx-auto w-full max-w-5xl p-4 lg:p-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
          >
            <span className="text-base">←</span> Open SWE
          </Link>
          <StatusBadge
            status={
              stateLoading
                ? "loading"
                : isLive
                  ? "streaming"
                  : (threadStatus ?? "unknown")
            }
          />
        </div>
        {/* Provenance first — before any run content, so it is impossible to
            read the output below without having seen who produced it. */}
        <AgentModeBanner provenance={provenance} />

        {task && (
          <div className="mb-6">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Task
            </div>
            <h1 className="text-base font-medium text-foreground">{task}</h1>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              run {runId.slice(0, 18)}…
            </p>
          </div>
        )}

        {/* status hook for tests + tooling */}
        <p data-testid="stream-status" className="sr-only">
          Status:{" "}
          {stateLoading
            ? "loading"
            : isLive
            ? streamStatus
            : threadStatus ?? "unknown"}
        </p>

        {stateLoading && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            Loading run…
          </div>
        )}

        {!stateLoading && stateError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-destructive">
            <p data-testid="stream-error">
              Couldn’t load this run: {stateError.message}
            </p>
            <button
              type="button"
              onClick={refetch}
              className="mt-2 rounded-md border border-destructive px-3 py-1 text-xs text-destructive hover:bg-destructive/15"
            >
              Retry
            </button>
          </div>
        )}

        {/* LIVE: stream the active run */}
        {!stateLoading && !stateError && isLive && (
          <div className="space-y-5">
            {canCancel && (
              <button
                type="button"
                data-testid="cancel-run-button"
                onClick={cancel}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:border-destructive hover:text-destructive"
              >
                Cancel run
              </button>
            )}
            {streamError && (
              <p className="text-xs text-muted-foreground">
                Live stream ended.{" "}
                <button
                  onClick={refetch}
                  className="underline hover:text-foreground"
                >
                  Load result
                </button>
              </p>
            )}
            {events.length === 0 && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-foreground" />
                Agent is working…
              </div>
            )}
            {streamText && (
              <section aria-label="Agent output" className="px-1">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-success/80">
                  Agent
                </div>
                <pre
                  data-testid="agent-text"
                  className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground"
                >
                  {streamText}
                </pre>
              </section>
            )}
            <AgentNarrative
              events={events}
              toolCalls={toolCalls}
              threadId={threadId}
              runId={runId}
            />
          </div>
        )}

        {/* DONE: render history from thread state */}
        {!stateLoading &&
          !stateError &&
          !isLive &&
          (items.length > 0 ? (
            <ConversationView items={items} />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              This run has no recorded history yet.
            </p>
          ))}
      </div>
    </div>
  );
}

export default function RunDetailPage() {
  return (
    <Suspense
      fallback={
        <p data-testid="stream-status" className="p-5 text-sm text-muted-foreground">
          Status: loading
        </p>
      }
    >
      <RunDetailContent />
    </Suspense>
  );
}
