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
  // A queue card is most useful while work is active. Five seconds made a
  // completed run look stuck when the user was watching the board, especially
  // when the model finished just after a poll. Two seconds keeps the board
  // responsive without approaching the API's standard 60-request/minute
  // limit, while callers can still override the cadence for tests or embeds.
  pollIntervalMs = 2000,
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
  /*
   * ONE TOKEN CANNOT ORDER TWO QUANTITIES (#1033).
   *
   * The first repair kept a single high-water mark for "has written", and a FAILURE
   * advanced it. A failure carries no runs, so it superseded a success that did --
   * and at mount the two fetches get DIFFERENT bodies: the first request receives the
   * runs and the second a 500. Whichever RESOLVES first is a race, and when the 500
   * won it claimed the mark, the 200 carrying the only card the board would ever see
   * was dropped, and open-swe-queue-polling :153 and :174 reported
   * `locator resolved to 0 elements`. The board was not erased -- IT WAS NEVER
   * POPULATED, which reads identically from the outside and is why the specs that
   * forbid erasure are the ones that caught it.
   *
   * `runs` and `error` have different writers, so they get different marks. A failure
   * may not supersede a success's RUNS because it has none to offer; a success may not
   * clear an outage a NEWER poll reported, which is #1009's original defect and the
   * reason a single mark existed at all.
   */
  /** Highest issue number that has written RUNS. Only a success advances it. */
  const appliedRunsRef = useRef(0);
  /** Highest issue number that has written ERROR. Success and failure both advance it. */
  const appliedErrorRef = useRef(0);

  const fetchRuns = useCallback(async () => {
    const issued = ++issuedRef.current;
    /** Write only if no NEWER answer has already written this quantity. */
    const claimRuns = () => {
      if (issued <= appliedRunsRef.current) return false;
      appliedRunsRef.current = issued;
      return true;
    };
    const claimError = () => {
      if (issued <= appliedErrorRef.current) return false;
      appliedErrorRef.current = issued;
      return true;
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
      if (claimRuns()) setRuns(parsed);
      // A partly-usable response keeps its usable part on screen AND says so,
      // which is the same contract the non-ok branch above already honours.
      // Guarded separately: this answer may be the newest RUNS and still be older
      // than a failure that has already reported an outage.
      if (claimError())
        setError(dropped > 0 ? new Error(droppedMessage(dropped)) : null);
    } catch (err) {
      // No runs to offer, so `appliedRunsRef` is deliberately untouched.
      if (claimError())
        setError(
          err instanceof Error ? err : new Error("Failed to fetch runs")
        );
    } finally {
      // `loading` is about whether ANY answer has arrived, so a superseded one may
      // still clear it: by the time this runs, an answer HAS arrived. Unguarded on
      // purpose -- there is no ordering to get wrong, because every path through this
      // function reaches it and they all write the same value.
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
