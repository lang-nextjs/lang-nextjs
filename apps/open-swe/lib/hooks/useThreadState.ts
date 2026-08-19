import { useCallback, useEffect, useState } from "react";
import {
  normalizeMessages,
  mapThreadStatus,
  type ConversationItem,
  type RawMessage,
  type ThreadRunStatus,
} from "../thread-state";

export interface UseThreadStateResult {
  items: ConversationItem[];
  status: ThreadRunStatus | null;
  files: Record<string, unknown>;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Load a run's thread state (history) from /api/open-swe/runs/[runId]/state.
 * Powers the run page's view of COMPLETED runs.
 */
export function useThreadState(
  runId: string,
  threadId: string,
  enabled = true
): UseThreadStateResult {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [status, setStatus] = useState<ThreadRunStatus | null>(null);
  const [files, setFiles] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  const fetchState = useCallback(async () => {
    if (!enabled || !runId || !threadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/open-swe/runs/${runId}/state?threadId=${encodeURIComponent(threadId)}`
      );
      if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
      const data = (await res.json()) as {
        status?: string;
        interrupts?: unknown;
        messages?: RawMessage[];
        files?: Record<string, unknown>;
      };
      const hasInterrupts =
        Array.isArray(data.interrupts) && data.interrupts.length > 0;
      setItems(normalizeMessages(data.messages ?? []));
      setStatus(mapThreadStatus(data.status, hasInterrupts));
      setFiles(data.files ?? {});
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [runId, threadId, enabled]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  return { items, status, files, loading, error, refetch: fetchState };
}
