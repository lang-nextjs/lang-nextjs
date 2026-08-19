"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "../types";

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

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/open-swe/runs");
      if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
      const data = (await res.json()) as Run[];
      setRuns(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch runs"));
    } finally {
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
