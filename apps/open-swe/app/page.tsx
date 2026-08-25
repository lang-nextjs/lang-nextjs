"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRuns } from "../lib/hooks/useRuns";
import { RunListCard } from "../components/RunListCard";
import { groupRuns } from "../lib/run-board";
import { ReadinessStrip } from "../components/ReadinessStrip";

export default function HomePage() {
  const router = useRouter();
  const { runs, loading, error, refresh } = useRuns();
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Grouped for the board. Derived on every render — the run list is small
  // and a memo here would be caching a map over a handful of items.
  const board = groupRuns(runs);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/open-swe/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: text }),
      });
      if (!res.ok) throw new Error(`Create run failed: ${res.status}`);
      const data = (await res.json()) as { run_id: string; thread_id?: string };
      const threadParam = data.thread_id
        ? `?threadId=${encodeURIComponent(data.thread_id)}`
        : "";
      router.push(`/runs/${data.run_id}${threadParam}`);
    } catch (err) {
      console.error("Failed to create run:", err);
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
        {/* The queue RUNS CODE, so sandboxRequired is true here and false on a read-only
            surface. Until #124 this page showed no readiness at all — it would accept work
            it had no sandbox to execute. */}
        <ReadinessStrip sandboxRequired />
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-foreground text-lg font-semibold tracking-tight">
            Open SWE
          </h1>
          <span className="text-muted-foreground text-xs">
            local · langgraph dev
          </span>
        </div>
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
              disabled={submitting || !task.trim()}
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
          {(
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
          )}
        </section>
      </div>
    </div>
  );
}
