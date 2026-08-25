"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRuns } from "../lib/hooks/useRuns";
import { RunListCard } from "../components/RunListCard";

export default function HomePage() {
  const router = useRouter();
  const { runs, loading, error, refresh } = useRuns();
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
    <div className="min-h-screen">
      {/* Top nav */}
      <header className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-neutral-100">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-neutral-100 text-[13px] font-bold text-neutral-900">
            ◇
          </span>
          Open SWE
        </div>
        <span className="text-xs text-neutral-500">local · langgraph dev</span>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        {/* Task composer */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-neutral-800 bg-neutral-900/60 shadow-xl shadow-black/30 focus-within:border-neutral-700"
        >
          <div className="flex items-center justify-between border-b border-neutral-800/70 px-4 py-2.5">
            <div className="flex items-center gap-2 font-mono text-xs text-neutral-400">
              <span className="rounded-md bg-neutral-800/80 px-2 py-1 text-neutral-300">
                local/workdir
              </span>
              <span className="text-neutral-600">·</span>
              <span className="rounded-md bg-neutral-800/80 px-2 py-1 text-neutral-300">
                main
              </span>
            </div>
            <button
              type="submit"
              disabled={submitting || !task.trim()}
              aria-label="Start run"
              data-testid="new-run-button"
              className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-600 text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
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
            className="w-full resize-none bg-transparent px-4 py-3.5 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none disabled:opacity-50"
          />
          <div className="px-4 pb-3 text-xs text-neutral-500">
            Press{" "}
            <kbd className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
              ⌘ Enter
            </kbd>{" "}
            to send
          </div>
        </form>

        {error && (
          <p
            data-testid="runs-error"
            role="alert"
            className="mt-4 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300"
          >
            Couldn’t load runs: {error.message}
          </p>
        )}

        {/* Threads */}
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-200">
              Recent &amp; Running Threads
              {loading && (
                <span className="ml-2 text-xs font-normal text-neutral-500">
                  loading…
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={refresh}
              data-testid="refresh-runs-button"
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-200"
            >
              Refresh
            </button>
          </div>

          {runs.length === 0 && !loading ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-10 text-center text-sm text-neutral-500">
              No threads yet. Describe a task above to start one.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {runs.map((run) => (
                <RunListCard key={run.run_id} run={run} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
