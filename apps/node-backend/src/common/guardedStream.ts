/**
 * Yield an agent stream, turning a mid-stream failure into a real message.
 *
 * PORTED FROM apps/fastapi-backend/ai_backends/_common.py's `guarded_stream`,
 * BEHAVIOUR AND ALL, because Node has the identical hazard. The Python note is
 * worth restating because it is the reason this file exists (#247):
 *
 *   Chat failed on every attempt with "upstream backend disconnected
 *   mid-stream", while the backend process was holding an APIStatusError 410
 *   saying the model had reached end of life. One environment variable would
 *   have fixed it, and the person who could set it was told the connection had
 *   dropped.
 *
 * The proxy was not wrong. Once the response head is flushed — and it is, the
 * moment streaming starts — an exception closes the socket with no terminal
 * frame, and from the proxy's position a 200 that ends without one IS a
 * mid-stream disconnect. THE TWO FAILURES ARE INDISTINGUISHABLE ON THE WIRE.
 * They have to be separated here, at the only layer that still holds the
 * reason.
 *
 * EMITTING THE ERROR IS NOT SUFFICIENT ON ITS OWN. The stream must also end the
 * way a finished stream ends; without the trailing `finish` the proxy still
 * reports a disconnect and the client shows BOTH the real cause and the lie
 * that displaced it.
 *
 * WHY A BARE `data:` FRAME SURVIVES THE LANGCHAIN ADAPTER. The error frames
 * below carry no `event:` header, so `langchainAdapter` reads their `type`
 * field, finds neither `token` nor `tool_call` nor `message`, and falls through
 * to `default: return frame` — passing them to the client unchanged. An
 * `event: error` frame would NOT survive: that adapter drops error events by
 * design. This shape is the one that reaches a person.
 */

/** A stable code and a retryable flag, named for what the CLIENT can do. */
export function errorCode(err: unknown): { code: string; retryable: boolean } {
  const e = err as { status?: unknown; status_code?: unknown; name?: string };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.status_code === "number"
      ? e.status_code
      : undefined;
  if (typeof status === "number") {
    // 408/429 are 4xx but genuinely transient, so status class alone is not the
    // rule — these two are the documented exceptions to it.
    return {
      code: `upstream_${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    };
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return { code: "upstream_unreachable", retryable: true };
  }
  return { code: "backend_error", retryable: false };
}

/**
 * Text-part ids opened by an AI-SDK-v6-native frame and not yet closed.
 *
 * Only the AI SDK v6 wire uses these, so for the LangChain SSE this file
 * currently guards the list stays empty. It is ported anyway because the
 * deepagents rung emits v6 directly and will land in this runtime (#10), and
 * because an unterminated `text-start` leaves the client rendering a part that
 * never completes — which reads as a hang rather than an error, the same
 * misattribution one layer up.
 */
function trackOpenText(chunk: string, open: string[]): void {
  if (!chunk.includes('"type":"text-')) return;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let part: { type?: unknown; id?: unknown };
    try {
      part = JSON.parse(trimmed.slice(5).trim());
    } catch {
      continue;
    }
    if (typeof part.id !== "string") continue;
    if (part.type === "text-start") open.push(part.id);
    else if (part.type === "text-end") {
      const at = open.indexOf(part.id);
      if (at !== -1) open.splice(at, 1);
    }
  }
}

export async function* guardedStream(
  source: AsyncIterable<string>
): AsyncGenerator<string> {
  const openTextIds: string[] = [];
  try {
    for await (const chunk of source) {
      trackOpenText(chunk, openTextIds);
      yield chunk;
    }
  } catch (err) {
    // An aborted request is how a client going away arrives here, and that is
    // not a backend failure — nobody is left to read the frame, and reporting
    // it would invent an error the run never had. Mirrors Python's refusal to
    // catch BaseException / CancelledError.
    if ((err as { name?: string })?.name === "AbortError") return;

    const { code, retryable } = errorCode(err);
    for (const id of openTextIds) {
      yield `data: {"type":"text-end","id":"${id}"}\n\n`;
    }
    const message =
      (err instanceof Error && err.message) ||
      (err as { constructor?: { name?: string } })?.constructor?.name ||
      "Error";
    const payload = {
      type: "data-error",
      data: {
        id: "stream-error",
        seq: 0,
        code,
        /*
         * `backend`, NOT `proxy` — a THIRD origin-less emitter, which #433 did
         * not name (it counted the two in the proxy).
         *
         * This one is not the proxy: node-backend IS an agent backend, the peer
         * of the django and fastapi ones, so a failure escaping its stream is
         * attributed the way theirs are.
         *
         * WHAT IS NOT DISTINGUISHED HERE, stated rather than left implied: the
         * Python backends split provider failures from their own with
         * `_error_origin`, because `_error_code` cannot tell them apart — an
         * upstream overload and a local defect both arrive as
         * backend_error/False. node-backend has no equivalent, so a
         * provider-caused failure is reported here as `backend`. That is a
         * REFINEMENT this field now makes expressible and does not yet make;
         * it is strictly better than absent, which forced every consumer to
         * guess.
         */
        origin: "backend" as const,
        // The provider's own detail — the EOL date and the model name in the
        // report above. Summarising it here would discard the only actionable
        // part.
        message,
        retryable,
        cause: {
          exception:
            (err as { constructor?: { name?: string } })?.constructor?.name ??
            "Error",
        },
      },
    };
    yield `data: ${JSON.stringify(payload)}\n\n`;
    yield 'data: {"type":"finish","finishReason":"error"}\n\n';
  }
}
