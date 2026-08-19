"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useRunStream } from "../../../lib/hooks/useRunStream";
import { useToolState } from "../../../lib/hooks/useToolState";
import { useThreadState } from "../../../lib/hooks/useThreadState";
import { AgentNarrative } from "../../../components/AgentNarrative";
import { ConversationView } from "../../../components/ConversationView";
import type { ThreadRunStatus } from "../../../lib/thread-state";

function StatusBadge({
  status,
}: {
  status: ThreadRunStatus | "streaming" | "loading";
}) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    streaming: {
      label: "Running",
      cls: "text-blue-400 border-blue-500/20 bg-blue-500/10",
      dot: "bg-blue-400 animate-pulse",
    },
    running: {
      label: "Running",
      cls: "text-blue-400 border-blue-500/20 bg-blue-500/10",
      dot: "bg-blue-400 animate-pulse",
    },
    pending: {
      label: "Pending",
      cls: "text-amber-400 border-amber-500/20 bg-amber-500/10",
      dot: "bg-amber-400",
    },
    interrupted: {
      label: "Awaiting approval",
      cls: "text-amber-400 border-amber-500/20 bg-amber-500/10",
      dot: "bg-amber-400",
    },
    completed: {
      label: "Completed",
      cls: "text-emerald-400 border-emerald-500/20 bg-emerald-500/10",
      dot: "bg-emerald-400",
    },
    failed: {
      label: "Failed",
      cls: "text-red-400 border-red-500/20 bg-red-500/10",
      dot: "bg-red-400",
    },
    loading: {
      label: "Loading",
      cls: "text-neutral-400 border-neutral-600/30 bg-neutral-700/30",
      dot: "bg-neutral-500",
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
      <main className="mx-auto max-w-3xl px-5 py-10">
        <p data-testid="missing-thread-id" className="text-sm text-red-300">
          threadId is required. Pass ?threadId=… in the URL.
        </p>
      </main>
    );
  }

  const task = items.find((i) => i.kind === "user")?.text ?? "";
  const canCancel =
    streamStatus === "streaming" || streamStatus === "connecting";

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-neutral-100"
        >
          <span className="text-base">←</span> Open SWE
        </Link>
        <StatusBadge
          status={
            stateLoading
              ? "loading"
              : isLive
              ? "streaming"
              : threadStatus ?? "completed"
          }
        />
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        {task && (
          <div className="mb-6">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              Task
            </div>
            <h1 className="text-base font-medium text-neutral-100">{task}</h1>
            <p className="mt-1 font-mono text-[11px] text-neutral-600">
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
            : threadStatus ?? "completed"}
        </p>

        {stateLoading && (
          <div className="flex items-center gap-2 py-10 text-sm text-neutral-500">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
            Loading run…
          </div>
        )}

        {!stateLoading && stateError && (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            <p data-testid="stream-error">
              Couldn’t load this run: {stateError.message}
            </p>
            <button
              type="button"
              onClick={refetch}
              className="mt-2 rounded-md border border-red-800 px-3 py-1 text-xs text-red-200 hover:bg-red-900/40"
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
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-red-700 hover:text-red-300"
              >
                Cancel run
              </button>
            )}
            {streamError && (
              <p className="text-xs text-neutral-500">
                Live stream ended.{" "}
                <button
                  onClick={refetch}
                  className="underline hover:text-neutral-300"
                >
                  Load result
                </button>
              </p>
            )}
            {events.length === 0 && (
              <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
                Agent is working…
              </div>
            )}
            {streamText && (
              <section aria-label="Agent output" className="px-1">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-500/80">
                  Agent
                </div>
                <pre
                  data-testid="agent-text"
                  className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-200"
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
            <p className="py-10 text-center text-sm text-neutral-500">
              This run has no recorded history yet.
            </p>
          ))}
      </main>
    </div>
  );
}

export default function RunDetailPage() {
  return (
    <Suspense
      fallback={
        <p data-testid="stream-status" className="p-5 text-sm text-neutral-500">
          Status: loading
        </p>
      }
    >
      <RunDetailContent />
    </Suspense>
  );
}
