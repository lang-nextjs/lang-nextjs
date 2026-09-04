"use client";

import { Suspense, useEffect } from "react";
import { BOARD_ROUTE } from "../../../lib/routes";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useRunStream } from "../../../lib/hooks/useRunStream";
import { useBackendTopology } from "../../../lib/hooks/useBackendTopology";
import { RunTopologyNotice } from "../../../components/RunTopologyNotice";
import { useToolState } from "../../../lib/hooks/useToolState";
import { useThreadState } from "../../../lib/hooks/useThreadState";
import { AgentNarrative } from "../../../components/AgentNarrative";
import { ConversationView } from "../../../components/ConversationView";
import { RunFacts } from "../../../components/RunFacts";
import {
  AgentModeBanner,
  bannerDensity,
} from "../../../components/AgentModeBanner";
import type { ThreadRunStatus } from "../../../lib/thread-state";

function StatusBadge({
  status,
}: {
  /*
   * NO STREAM STATES HERE (#719). This deliberately does NOT accept
   * "streaming": this badge is labelled THREAD, and admitting a member of
   * RunStreamStatus's union is what let a stream value be rendered as a thread
   * fact for the entire live branch. Removing it from the type means the
   * regression is a compile error rather than a code review.
   */
  status: ThreadRunStatus | "loading";
}) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
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
      cls: "text-destructive-ink border-destructive/20 bg-destructive/10",
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
    cancelError,
    cancel,
  } = useRunStream({ runId, threadId, enabled: isLive });

  const topology = useBackendTopology();
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
        <p
          data-testid="missing-thread-id"
          className="text-sm text-destructive-ink"
        >
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
        {/*
         * #154 — BOARD_ROUTE, not a literal. This link means BACK TO THE
         * BOARD, and it was spelled "/" only because the board happened to
         * be the front page. Left as a literal it would have kept resolving
         * after the move and quietly gone to the chat instead — a mutation
         * planting exactly that passed all 904 unit tests.
         */}
        <Link
          href={BOARD_ROUTE}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm transition-colors"
        >
          <span className="text-base">←</span> Open SWE
        </Link>

        {/*
         * ONE STATUS LINE, WITH EACH FACT NAMED (#709).
         *
         * These three things used to be rendered in three places: a green
         * "Live agent run" banner at the top, a grey "Idle (thread)" pill in
         * the far corner, and a third `STATUS idle` row inside RunFacts. Every
         * one of them was correct. Together they read as a page disagreeing
         * with itself, because they answer DIFFERENT QUESTIONS and nothing on
         * screen said which question either was answering:
         *
         *   THREAD — is this thread executing right now?
         *   SOURCE — what produced the output below: a real graph, or a script?
         *
         * A green "live" above a grey "idle" invites exactly one reading, and
         * it is the wrong one. `lib/agent-mode.ts` and `lib/run-identity.ts`
         * both model this correctly; the loss happened only here, at the point
         * of rendering. So: adjacent, labelled, and stated once.
         *
         * The duplicate `STATUS` row is dropped by passing `status={undefined}`
         * below rather than by editing `runFacts()`, which is a tested pure
         * function whose behaviour is right.
         */}
        <div
          data-testid="run-header"
          className="border-border/60 mt-5 mb-6 border-b pb-5"
        >
          {task && (
            <div className="mb-3">
              <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wide uppercase">
                Task
              </div>
              <h1 className="text-foreground text-xl leading-snug font-medium">
                {task}
              </h1>
            </div>
          )}

          <div
            data-testid="run-status-line"
            className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-2"
          >
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
              Thread
            </span>
            {/*
             * THREAD STATE, ON THE LIVE BRANCH TOO (#719). This used to read
             * `isLive ? "streaming" : threadStatus`, so for the whole live
             * branch the badge under the label "Thread" was driven by a value
             * from the STREAM's vocabulary. It is not a missing row, it is a
             * fabricated one — and it is visible: a `pending` thread rendered
             * as "Running", because the map sends `streaming` there.
             *
             * The stream's own state stays sr-only (see `stream-status`
             * below). The badge answers "is this thread executing", and a
             * stream that is connecting or dead is not an answer to that.
             */}
            <StatusBadge
              status={stateLoading ? "loading" : threadStatus ?? "unknown"}
            />
            {/*
             * The label is rendered only beside the COMPACT chip. A full box is
             * `w-full`, so it wraps onto its own line in this flex container and
             * a "Source" label left on the previous line would be orphaned —
             * and the full box is three lines of self-describing text anyway.
             * `bannerDensity` is the banner's own rule, imported rather than
             * restated, so the two cannot drift apart.
             */}
            {provenance && bannerDensity(provenance) === "compact" && (
              <span className="text-muted-foreground ml-2 text-[10px] font-semibold tracking-wide uppercase">
                Source
              </span>
            )}
            {/* Provenance stays above the run content and is still always
                rendered — it has stopped being a full-bleed box for the one
                tone where nobody was at risk of a false belief (#710). */}
            <AgentModeBanner provenance={provenance} />
          </div>

          {/*
           * OUTSIDE `{task && …}`, deliberately. The line this replaces lived
           * inside it, so a run whose task failed to load showed no identifiers
           * at all — and that is exactly the run whose id you need in order to
           * go and ask what happened to it.
           */}
          <RunFacts
            runId={runId}
            threadId={threadId}
            status={undefined}
            agentMode={provenance?.mode}
            agentReason={
              provenance && "reason" in provenance
                ? (provenance.reason as string | undefined)
                : undefined
            }
          />
        </div>

        {/*
         * WHETHER THIS VIEW IS THE WHOLE AGENT (#423). Above the transcript,
         * because it qualifies everything below it: a reader who scrolls the
         * events first has already formed the impression this component exists
         * to correct. Renders nothing at all against the single-run backend
         * this repo ships.
         */}
        <div className="mb-3">
          <RunTopologyNotice topology={topology} />
        </div>

        {/*
         * streamStatus, for tests + tooling. Named, because #719 was partly a
         * reader being unable to tell WHICH status this carries — it is the
         * stream's, and it is the reason the visible badge does not need to be.
         */}
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
          <div className="rounded-lg border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-destructive-ink">
            <p data-testid="stream-error">
              Couldn’t load this run: {stateError.message}
            </p>
            <button
              type="button"
              onClick={refetch}
              className="mt-2 rounded-md border border-destructive px-3 py-1 text-xs text-destructive-ink hover:bg-destructive/15"
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
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:border-destructive hover:text-destructive-ink"
              >
                Cancel run
              </button>
            )}
            {/*
             * A REFUSED CANCEL IS ITS OWN EVENT (#236).
             *
             * This used to arrive as `streamError` and render below as the
             * muted "Live stream ended. Load result" — with the status code and
             * the platform's message discarded. For a stream that finished that
             * line is right. For a cancel that was rejected it says the one
             * thing that is not true: the run is still going, and the person
             * who asked it to stop walked away believing it had.
             *
             * Rendered where the button is, because that is where the person
             * was looking when they clicked it.
             */}
            {cancelError && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-destructive-ink"
              >
                <p data-testid="cancel-error">
                  Couldn’t cancel this run: {cancelError.message}
                </p>
                <p className="mt-1 text-xs">
                  The run is still going. The Cancel button above is live — try
                  again, or leave it to finish on its own.
                </p>
              </div>
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
                  className="text-foreground max-w-[68ch] font-sans text-[15px] leading-7 whitespace-pre-wrap"
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
            <>
              <ConversationView items={items} />
              {/*
               * A FLOOR (#711). The page used to stop into roughly 40% of empty
               * viewport, with nothing saying whether the transcript had ended,
               * been truncated, or was still filling in.
               *
               * It says RECORDED HISTORY rather than "end of thread", because
               * that is the claim this page can actually support: it is the end
               * of what thread state returned. Whether the run itself is
               * finished is a different question, and the same one the `idle`
               * badge declines to answer (#176). Same wording as the empty
               * state above, so the two cannot drift into naming different
               * things.
               */}
              <div
                data-testid="transcript-end"
                className="text-muted-foreground mt-8 flex items-center gap-3 text-[10px] font-semibold tracking-wide uppercase"
              >
                <span aria-hidden="true" className="bg-border h-px flex-1" />
                End of recorded history
                <span aria-hidden="true" className="bg-border h-px flex-1" />
              </div>
            </>
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
        <p
          data-testid="stream-status"
          className="p-5 text-sm text-muted-foreground"
        >
          Status: loading
        </p>
      }
    >
      <RunDetailContent />
    </Suspense>
  );
}
