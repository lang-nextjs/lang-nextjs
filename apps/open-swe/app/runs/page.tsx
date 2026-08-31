"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRuns } from "../../lib/hooks/useRuns";
import { RunListCard } from "../../components/RunListCard";
import { groupRuns } from "../../lib/run-board";
import { useQueueReadiness } from "../../lib/hooks/useQueueReadiness";
import { canSend } from "../../lib/readiness";
import {
  classifySubmitFailure,
  readErrorDetail,
  type SubmitFailure,
} from "../../lib/submit-error";

export default function HomePage() {
  const router = useRouter();
  const { runs, loading, error, refresh } = useRuns();
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // #124: the queue runs code, so it needs a sandbox as well as a model. Before
  // this it computed no readiness at all — see the header literal it replaces.
  const { readiness, probeErrors, llmConfigured, sandboxAvailable } =
    useQueueReadiness(submitting ? "submitted" : "idle");
  // Submission has THREE states, not two: idle, in-flight, and failed-with-a-
  // reason. Before #131 the third had no representation at all, so a failure
  // rendered as idle — the same surface a user sees before they ever pressed
  // the button. This state is cleared only by a retry or an explicit dismiss;
  // it deliberately does NOT auto-expire, because a message that vanishes on a
  // timer is barely better than the console line it replaced.
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(
    null
  );

  // Grouped for the board. Derived on every render — the run list is small
  // and a memo here would be caching a map over a handful of items.
  const board = groupRuns(runs);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    // Clear the previous failure only now — retrying is the acknowledgement.
    setSubmitFailure(null);
    try {
      const res = await fetch("/api/open-swe/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: text }),
      });
      if (!res.ok) {
        // Read the body BEFORE classifying: the route answers 502 with
        // {"error":"LANGGRAPH_PLATFORM_URL is not configured"}, which is the
        // sentence that actually tells someone what to fix. The old code threw
        // that away and kept only the status.
        const detail = await readErrorDetail(res);
        const retryAfter = Number(res.headers.get("retry-after"));
        setSubmitFailure(
          classifySubmitFailure(
            res.status,
            detail,
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter
              : undefined
          )
        );
        return;
      }
      const data = (await res.json()) as { run_id: string; thread_id?: string };
      const threadParam = data.thread_id
        ? `?threadId=${encodeURIComponent(data.thread_id)}`
        : "";
      router.push(`/runs/${data.run_id}${threadParam}`);
    } catch (err) {
      // fetch() rejected: no response was received at all. That is a different
      // fact from "the server refused", and status null is how it stays one.
      setSubmitFailure(
        classifySubmitFailure(
          null,
          err instanceof Error ? err.message : undefined
        )
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter submits.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      void handleSubmit(e as unknown as React.FormEvent);
    }
  }

  return (
    <div className="min-h-full">
      {/*
       * The page's own top bar is gone. AppShell already renders one, so this
       * was a second header stacked under the first — and a second <main>
       * inside SidebarInset's, which is two landmarks where WCAG allows one.
       * The environment line it carried moves into the page heading below,
       * where it is content rather than chrome.
       *
       * Width follows dashboard-01: fill the inset with responsive padding
       * rather than centring a narrow column, which left most of the surface
       * empty at desktop widths.
       */}
      <div className="flex flex-col gap-6 p-4 lg:p-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-foreground text-lg font-semibold tracking-tight">
            Open SWE
          </h1>
          {/*
           * WAS: the string literal "local · langgraph dev".
           *
           * That is the whole of #124. A status-shaped element rendering a
           * hardcoded environment name reports a verdict it never computed —
           * and it could not go red, because nothing fed it. This is derived
           * from two live probes, and `unknown` is a real state rather than an
           * optimistic green.
           */}
          <span
            data-testid="queue-readiness"
            data-state={readiness.state}
            role="status"
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <span
              data-testid="queue-readiness-dot"
              aria-hidden="true"
              className={`inline-block size-1.5 rounded-full ${
                readiness.state === "error" || readiness.state === "blocked"
                  ? "bg-destructive"
                  : readiness.state === "busy"
                  ? "bg-info animate-pulse"
                  : readiness.state === "unknown"
                  ? "bg-muted-foreground"
                  : "bg-success"
              }`}
            />
            {readiness.label}
          </span>
        </div>
        {/*
         * Blocked banner — mirrors /chat's `chat-blocked` deliberately. #124
         * says reuse the shape rather than invent a second one, so the two
         * surfaces cannot drift into different answers for the same question.
         *
         * Rendered ONLY for `blocked`, i.e. a dependency answered no. An
         * `unknown` state does not get a red banner: not knowing is not the
         * same as knowing it is broken, and claiming otherwise is the same
         * defect pointed the other way.
         */}
        {readiness.state === "blocked" && (
          <div
            data-testid="queue-blocked"
            role="status"
            className="border-destructive/40 bg-destructive/10 rounded-lg border px-4 py-2 text-xs"
          >
            <p className="text-foreground font-medium">Not ready to run</p>
            <ul className="text-muted-foreground mt-1 list-disc space-y-0.5 pl-4">
              {readiness.reasons.map((why) => (
                <li key={why}>{why}</li>
              ))}
            </ul>
          </div>
        )}

        {/*
         * A probe that could not answer is reported as such. Without this the
         * indicator would sit on "checking…" forever with no way to tell a slow
         * probe from a broken one — the shape of this bug, one level down.
         */}
        {probeErrors.length > 0 && (
          <div
            data-testid="queue-probe-error"
            role="status"
            className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-2 text-xs"
          >
            <p className="text-foreground font-medium">
              Readiness could not be determined
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {probeErrors.map((why) => (
                <li key={why}>{why}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Task composer */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-border bg-card/60 shadow-xl shadow-black/30 focus-within:border-border"
        >
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
            <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className="rounded-md bg-muted/80 px-2 py-1 text-foreground">
                local/workdir
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="rounded-md bg-muted/80 px-2 py-1 text-foreground">
                main
              </span>
            </div>
            <button
              type="submit"
              // #124: the queue can no longer accept work it knows cannot run.
              // canSend() requires `ready` — `unknown` does not qualify, which
              // is deliberate: submitting into an unverified environment is how
              // the PO's 429s became invisible in the first place.
              disabled={submitting || !task.trim() || !canSend(readiness)}
              aria-label="Start run"
              data-testid="new-run-button"
              className="grid h-7 w-7 place-items-center rounded-lg bg-success text-white transition-colors hover:bg-success disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            >
              {submitting ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              )}
            </button>
          </div>
          <textarea
            // The only app-side change in #22, and it is deliberate: the specs
            // selected this composer by `input[placeholder="Describe a task..."]`,
            // which matched neither the element nor the copy. Re-pinning the
            // selector to the current placeholder would rebuild the same trap
            // with fresher prose — a copy edit would break the test again.
            // A testid is a contract; a placeholder is user-facing prose.
            // Name matches apps/example's existing `task-input` so both
            // composers expose the same contract.
            data-testid="task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your coding task or ask a question…"
            rows={4}
            disabled={submitting}
            className="w-full resize-none bg-transparent px-4 py-3.5 text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-50"
          />
          <div className="px-4 pb-3 text-xs text-muted-foreground">
            Press{" "}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              ⌘ Enter
            </kbd>{" "}
            to send
          </div>
        </form>

        {/*
         * SUBMISSION FAILURE — deliberately NOT a toast.
         *
         * A toast appears and vanishes, so a user who looked away is back to
         * the silence #131 is about. This is a persistent region: it stays
         * until the user retries or dismisses it, and it sits next to the form
         * that produced it rather than in a corner of the viewport.
         *
         * Distinct from `runs-error` below, which reports the run LIST fetch.
         * Conflating them is what let a failed submission look like a healthy
         * page — different subjects need different surfaces.
         */}
        {submitFailure && (
          <div
            data-testid="submit-error"
            role="alert"
            className="mt-4 rounded-lg border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm"
          >
            <p
              data-testid="submit-error-title"
              className="font-medium text-destructive"
            >
              {submitFailure.title}
            </p>
            <p
              data-testid="submit-error-hint"
              className="mt-1 text-destructive/90"
            >
              {submitFailure.hint}
            </p>
            {submitFailure.detail && (
              <p
                data-testid="submit-error-detail"
                className="mt-2 font-mono text-xs text-destructive/80"
              >
                {submitFailure.detail}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                data-testid="submit-error-retry"
                onClick={(e) =>
                  void handleSubmit(e as unknown as React.FormEvent)
                }
                disabled={submitting || !task.trim()}
                className="rounded-md border border-destructive/50 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                Retry
              </button>
              <button
                type="button"
                data-testid="submit-error-dismiss"
                onClick={() => setSubmitFailure(null)}
                className="rounded-md px-2.5 py-1 text-xs text-destructive/80 hover:bg-destructive/10"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {error && (
          <p
            data-testid="runs-error"
            role="alert"
            className="mt-4 rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-destructive"
          >
            Couldn’t load runs: {error.message}
          </p>
        )}

        {/* Threads */}
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              Queue
              {loading && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  loading…
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={refresh}
              data-testid="refresh-runs-button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Refresh
            </button>
          </div>

          {/*
           * THE BOARD ALWAYS RENDERS, INCLUDING WHEN THE QUEUE IS EMPTY.
           *
           * It used to be replaced wholesale by a "No threads yet" box, so an
           * empty queue showed one bordered rectangle and no columns at all —
           * which reads as a broken board rather than an empty one. A kanban's
           * columns ARE the information: they tell you what states exist before
           * anything is in them.
           */}
          {runs.length === 0 && !loading && (
            <p className="text-muted-foreground mb-3 text-xs">
              No threads yet — describe a task above to start one.
            </p>
          )}
          {
            /*
             * A BOARD, NOT A LIST. Grouping is done in lib/run-board.ts rather
             * than by filtering inline, because the interesting case is a
             * status none of the columns names — and a JSX filter chain drops
             * that silently, showing a queue with work missing from it.
             *
             * `Other` renders only when something lands in it, so a healthy
             * queue shows five columns and an unrecognised status makes a sixth
             * appear rather than making runs disappear.
             */
            <div
              data-testid="run-board"
              /*
               * KEYBOARD-REACHABLE, BECAUSE THIS SCROLLS (#457).
               *
               * `overflow-x-auto` makes this a scrollable region: measured
               * empty at 1280px, 1088px of columns in a 968px box. A mouse
               * user can scroll to the columns past the right edge. Without
               * a tab stop a keyboard user cannot reach them at all, and axe
               * reports it as `scrollable-region-focusable`, impact serious.
               *
               * It only violates while the board is EMPTY — populated, the
               * cards are links and the region is reachable through them.
               * That is why it survived: every existing spec mocks runs in,
               * so the state that fails is the first-run state nothing had
               * looked at.
               *
               * `role="region"` rather than a bare tabIndex: a focusable
               * generic div is an unnamed stop that announces nothing. The
               * role is what makes the label reach a screen reader.
               */
              role="region"
              aria-label="Run board"
              tabIndex={0}
              className="grid auto-cols-[minmax(13rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
            >
              {board
                .filter((col) => !(col.hideWhenEmpty && col.runs.length === 0))
                .map((col) => (
                  <div
                    key={col.id}
                    data-testid={`board-column-${col.id}`}
                    className="border-border bg-card/30 flex min-w-0 flex-col rounded-xl border"
                  >
                    <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
                      <span className="text-foreground text-xs font-semibold">
                        {col.label}
                      </span>
                      <span
                        data-testid={`board-count-${col.id}`}
                        className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]"
                      >
                        {col.runs.length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 p-2">
                      {col.runs.length === 0 ? (
                        <p className="text-muted-foreground px-1 py-3 text-center text-[11px]">
                          none
                        </p>
                      ) : (
                        col.runs.map((r) => (
                          <RunListCard key={r.run_id} run={r} />
                        ))
                      )}
                    </div>
                  </div>
                ))}
            </div>
          }
        </section>
      </div>
    </div>
  );
}
