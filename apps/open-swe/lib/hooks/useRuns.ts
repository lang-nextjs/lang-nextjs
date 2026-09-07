"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "../types";
import { droppedMessage, parseRuns } from "../parse-runs";

export interface UseRunsOptions {
  pollIntervalMs?: number;
  enabled?: boolean;
}

export interface UseRunsResult {
  runs: Run[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useRuns({
  pollIntervalMs = 5000,
  enabled = true,
}: UseRunsOptions = {}): UseRunsResult {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /*
   * THE LAST POLL ISSUED WINS, NOT THE LAST ONE TO RESOLVE (#1009).
   *
   * Two fetches are routinely in flight at once: the effect below calls `fetchRuns`
   * immediately AND installs the interval, `refresh()` can add one, `visibilitychange`
   * another, and React StrictMode double-invokes the effect in dev so the very first mount
   * issues two. Nothing ordered their writes, so whichever RESOLVED last won.
   *
   * That is not theoretical and it is not only a test problem. Measured from a CI trace:
   * two requests ten milliseconds apart, the first answering 200 and the second 500. The
   * 500 rendered the outage banner and the 200 resolved afterwards, calling
   * `setError(null)` and erasing it — an outage the user is never told about. A slow
   * network reproduces exactly this in production, where it is invisible rather than red.
   *
   * A monotonic token is enough because these fetches are interchangeable: they all ask the
   * same question, so a stale answer has no value and can simply be dropped. An
   * AbortController would also stop the request, which is a bigger behaviour change than
   * this defect needs.
   */
  const issuedRef = useRef(0);
  /** The highest issue number that has WRITTEN. A response older than this is superseded. */
  const appliedRef = useRef(0);

  const fetchRuns = useCallback(async () => {
    const issued = ++issuedRef.current;
    /** True once a later fetch has been issued: this answer is superseded. */
    const superseded = () => issued < appliedRef.current;
    const claim = () => {
      appliedRef.current = issued;
    };
    try {
      const res = await fetch("/api/open-swe/runs");
      if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
      // PARSE, DO NOT CAST (#243). This was `(await res.json()) as Run[]`,
      // which asserted to the compiler that the network had kept a promise
      // while nothing checked that it had. A 200 carrying `{"runs": []}` was
      // stored, iterated during render, and threw `runs is not iterable` —
      // and the error boundary that caught it unmounted this hook, so the
      // poll that would have recovered never ran again.
      const { runs: parsed, dropped } = parseRuns(await res.json());
      if (superseded()) return;
      claim();
      setRuns(parsed);
      // A partly-usable response keeps its usable part on screen AND says so,
      // which is the same contract the non-ok branch above already honours.
      setError(dropped > 0 ? new Error(droppedMessage(dropped)) : null);
    } catch (err) {
      if (superseded()) return;
      claim();
      setError(err instanceof Error ? err : new Error("Failed to fetch runs"));
    } finally {
      // `loading` is about whether ANY answer has arrived, so the superseded one may
      // still clear it. This block runs on the early returns above too -- `finally`
      // always does -- and it is unguarded because it cannot clear loading too early:
      // superseded() is true only once a newer fetch has claimed AND written, and that
      // fetch's own finally has already set this false, since nothing awaits between
      // the claim and this block. The repeat is a no-op.
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    fetchRuns();

    intervalRef.current = setInterval(fetchRuns, pollIntervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchRuns();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchRuns, pollIntervalMs, enabled]);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchRuns();
  }, [fetchRuns]);

  return { runs, loading, error, refresh };
}
