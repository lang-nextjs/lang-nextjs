import { useCallback, useEffect, useRef, useState } from "react";
import { StreamEvent, RunStreamStatus } from "../types";

export interface UseRunStreamOptions {
  runId: string;
  threadId: string;
  enabled?: boolean;
}

export interface UseRunStreamResult {
  events: StreamEvent[];
  status: RunStreamStatus;
  error: Error | null;
  retry: () => void;
}

export function useRunStream({
  runId,
  threadId,
  enabled = true,
}: UseRunStreamOptions): UseRunStreamResult {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<RunStreamStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;
    eventSourceRef.current?.close();

    setStatus("connecting");
    setError(null);

    const url = `/api/open-swe/runs/${runId}/stream?threadId=${encodeURIComponent(threadId)}`;
    const es = new EventSource(url);

    es.addEventListener("open", () => {
      setStatus("streaming");
    });

    es.addEventListener("message", (evt: MessageEvent) => {
      // Detect stream-end sentinel: LangGraph Platform sends data: [DONE]
      if (evt.data === "[DONE]") {
        setStatus("done");
        es.close();
        return;
      }
      try {
        const parsed = JSON.parse(evt.data) as StreamEvent;
        setEvents((prev) => [...prev, parsed]);
      } catch (err) {
        console.error("[useRunStream] failed to parse event:", evt.data, err);
      }
    });

    es.addEventListener("done", () => {
      setStatus("done");
      es.close();
    });

    es.addEventListener("error", () => {
      setError(new Error("EventSource connection failed"));
      setStatus("error");
      es.close();
    });

    eventSourceRef.current = es;
  }, [runId, threadId, enabled]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  const retry = useCallback(() => {
    setEvents([]);
    setError(null);
    connect();
  }, [connect]);

  return { events, status, error, retry };
}
