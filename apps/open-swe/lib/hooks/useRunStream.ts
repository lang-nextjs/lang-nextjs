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
  cancel: () => Promise<void>;
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
  const connectedRef = useRef(false);

  const connect = useCallback(() => {
    if (!enabled) return;
    eventSourceRef.current?.close();

    setStatus("connecting");
    setError(null);
    connectedRef.current = false;

    const url = `/api/open-swe/runs/${runId}/stream?threadId=${encodeURIComponent(
      threadId
    )}`;
    const es = new EventSource(url);

    es.addEventListener("open", () => {
      connectedRef.current = true;
      setStatus("streaming");
    });

    es.addEventListener("message", (evt: MessageEvent) => {
      connectedRef.current = true;
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
      // EventSource fires "error" BOTH on a failed connection AND when the
      // server closes a stream normally — which is how a finished run ends
      // (SSE has no graceful-EOF event). If we already connected/streamed,
      // treat the close as completion, not an error.
      es.close();
      if (connectedRef.current) {
        setStatus("done");
      } else {
        setError(new Error("Could not connect to the run stream"));
        setStatus("error");
      }
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

  const cancel = useCallback(async () => {
    setStatus("cancelling");
    eventSourceRef.current?.close();
    try {
      const res = await fetch(`/api/open-swe/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Cancel failed"));
      setStatus("error");
    }
  }, [runId]);

  return { events, status, error, retry, cancel };
}
