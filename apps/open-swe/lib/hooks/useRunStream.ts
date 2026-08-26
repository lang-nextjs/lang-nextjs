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
  /**
   * A CANCEL THE PLATFORM REFUSED — kept apart from `error` on purpose (#236).
   *
   * Both used to be `error`, and the page renders that as a muted "Live stream
   * ended. Load result". For a stream that finished, that is correct. For a
   * cancel that was REJECTED it is a lie twice over: the run did not end, and
   * the person who asked for it to stop is told that it did.
   */
  cancelError: Error | null;
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
  const [cancelError, setCancelError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const connectedRef = useRef(false);
  /**
   * `cancel` needs the status it is REPLACING so it can put it back when the
   * platform refuses. Reading `status` from the closure would give whatever it
   * was when the callback was last built, so it is mirrored here.
   */
  const statusRef = useRef<RunStreamStatus>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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

  /**
   * ASK FIRST, TEAR DOWN AFTER (#236).
   *
   * This used to close the EventSource on its second line, BEFORE the fetch —
   * so a cancel the platform rejected still killed the local stream. The run
   * carried on executing server-side while the page showed nothing and never
   * reconnected. The failure mode was the one the button exists to prevent,
   * inverted: the person was told the run stopped, and it had not.
   *
   * The stream is now closed only once the platform has accepted. On a refusal
   * the status goes back to whatever it was, so the stream keeps rendering, the
   * button comes back, and the person can try again.
   */
  const cancel = useCallback(async () => {
    const before = statusRef.current;
    setStatus("cancelling");
    setCancelError(null);
    try {
      const res = await fetch(`/api/open-swe/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await describeRefusal(res));
      // Accepted. Only now is it true that this run is stopping.
      eventSourceRef.current?.close();
      setStatus("done");
    } catch (err) {
      setCancelError(err instanceof Error ? err : new Error("Cancel failed"));
      // NOT "error" — nothing is wrong with the stream, and marking it so would
      // hide the run behind a failure banner. The run is exactly as it was.
      setStatus(before);
    }
  }, [runId]);

  return { events, status, error, cancelError, retry, cancel };
}

/**
 * The status code AND what the platform said, because either alone is useless.
 *
 * A bare "Cancel failed: 502" tells a person nothing they can act on, and the
 * previous implementation discarded even that. The body is capped and trimmed:
 * it is upstream text going straight into the UI, and a stack trace or an HTML
 * error page would push the actionable part off screen.
 */
async function describeRefusal(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => "")).trim();
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const found = parsed?.error ?? parsed?.message;
    if (typeof found === "string" && found.trim()) detail = found.trim();
  } catch {
    // Not JSON — use the raw text, which is still better than nothing.
  }
  if (!detail) return `the platform refused with ${res.status}`;
  const clipped = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return `${res.status} — ${clipped}`;
}
