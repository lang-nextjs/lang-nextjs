import { useState, useEffect, useRef } from "react";
import { SseFrameAccumulator } from "./accumulator";
import type { DeepAgentsState, DeepAgentsChatResult } from "./types";

/**
 * Walk a request body looking for Symbol values. V8's JSON.stringify silently
 * drops Symbol-valued properties (returning "{}" with the property absent)
 * rather than throwing — that would cause silent data loss for the caller.
 *
 * Returns the dot/bracket path to the first Symbol found (e.g. `"token"` or
 * `"user.permissions"`) so the hook can throw an actionable error message,
 * or `null` if no Symbols are present. Walks at most ~1000 nodes to bound
 * the traversal against pathological inputs.
 *
 * Limited to plain objects + arrays (no Maps/Sets/etc.) because the
 * requestBody type is `Record<string, unknown>`.
 */
function findSymbolPath(
  value: unknown,
  path: string = "",
  depth = 0
): string | null {
  if (depth > 1000) return null;
  if (typeof value === "symbol") return path || "(root)";
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSymbolPath(value[i], `${path}[${i}]`, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  // Plain object
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const found = findSymbolPath(
      (value as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
      depth + 1
    );
    if (found !== null) return found;
  }
  return null;
}

/**
 * useDeepAgentsChat — React hook for SSE streaming in Remix applications.
 *
 * Exposes the same surface as the Next.js hook: messages, status, error, start().
 * Uses native fetch() + ReadableStream reader loop — NOT useFetcher.data,
 * because useFetcher cannot read SSE streams (it waits for the full response).
 *
 * @param endpoint - The SSE endpoint URL (must accept POST).
 * @param options  - Optional session ID and arbitrary POST body fields.
 * @returns DeepAgentsChatResult — state spread plus an imperative start() function.
 */
export function useDeepAgentsChat(
  endpoint: string,
  options?: { sessionId?: string; body?: Record<string, unknown> }
): DeepAgentsChatResult {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [status, setStatus] = useState<DeepAgentsState["status"]>("idle");
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount: abort any in-flight fetch
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function start(): void {
    // Abort any previous in-flight fetch before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setMessages([]);
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const requestBody: Record<string, unknown> = { ...options?.body };
        if (options?.sessionId !== undefined) {
          requestBody.sessionId = options.sessionId;
        }

        // Pre-validate for Symbol values BEFORE JSON.stringify. V8 silently
        // drops Symbol-valued properties during stringify (returns "{}"
        // instead of throwing), which would cause silent data loss — the
        // server would receive a request missing the field entirely with no
        // error surfaced to the caller. Walking the body up-front and
        // throwing here is far better than discovering the data loss
        // server-side.
        const symbolPath = findSymbolPath(requestBody);
        if (symbolPath !== null) {
          throw new Error(
            `request body contains a Symbol value at "${symbolPath}" — Symbols are not JSON-serializable and V8 silently drops them; replace with a string, number, or null`,
            { cause: new TypeError("Symbol in requestBody") }
          );
        }

        // Wrap JSON.stringify in try/catch so a circular reference or other
        // non-serializable value surfaces as a clear, actionable error rather
        // than leaking the raw V8 TypeError ("Converting circular structure
        // to JSON"). The catch re-throws with a friendly message but keeps
        // the original cause attached for debugging.
        let serialized: string;
        try {
          serialized = JSON.stringify(requestBody);
        } catch (cause) {
          throw new Error(
            "request body is not JSON-serializable (circular reference?)",
            { cause }
          );
        }

        const response = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: serialized,
        });

        if (!response.body) {
          setStatus("done");
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const accumulator = new SseFrameAccumulator();
        let firstFrame = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any remaining buffered content
            for (const raw of accumulator.flush()) {
              if (raw.startsWith("data: ")) {
                const payload = JSON.parse(raw.slice(6)) as unknown;
                setMessages((prev) => [...prev, payload]);
                if (firstFrame) {
                  setStatus("streaming");
                  firstFrame = false;
                }
              }
            }
            setStatus("done");
            break;
          }
          for (const raw of accumulator.push(
            decoder.decode(value, { stream: true })
          )) {
            if (raw.startsWith("data: ")) {
              const payload = JSON.parse(raw.slice(6)) as unknown;
              setMessages((prev) => [...prev, payload]);
              if (firstFrame) {
                setStatus("streaming");
                firstFrame = false;
              }
            }
          }
        }
      } catch (err) {
        // AbortError is expected cleanup — silently ignore
        if (err instanceof Error && err.name === "AbortError") return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus("error");
      }
    })();
  }

  return { messages, status, error, start };
}
