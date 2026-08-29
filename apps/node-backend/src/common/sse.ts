/**
 * LangChain native SSE frame writers.
 *
 * BYTE-FOR-BYTE THE SAME WIRE as apps/fastapi-backend/ai_backends/langchain.py's
 * `_token_event` / `_tool_call_event` / `_tool_result_event` /
 * `_message_terminator`. That is not a stylistic preference: the acceptance
 * criterion for this backend is that `langchainAdapter`
 * (packages/server/src/adapters/langchain.ts) consumes this stream UNMODIFIED,
 * and that adapter parses the `event:` header and the `data:` JSON keys
 * literally. A renamed key is a dropped frame, silently.
 *
 * The adapter's contract, restated here so it can be checked against without
 * opening it:
 *   event: token      data.text          -> text-start (first) + text-delta
 *   event: tool_call  data.tool_name,
 *                     data.tool_input,
 *                     data.tool_call_id  -> tool-input-available
 *   event: tool_end   data.tool_call_id,
 *                     data.output        -> tool-output-available
 *   event: message    (content dropped)  -> text-end + finish
 *
 * `event: message` is ALSO the adapter's `isTerminal` predicate. A stream that
 * ends without one is reported by the proxy as `upstream_disconnect` — see
 * guardedStream.ts, which exists because of exactly that.
 */

export function tokenEvent(text: string): string {
  return `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
}

export function toolCallEvent(
  toolName: string,
  toolInput: unknown,
  toolCallId: string
): string {
  return (
    "event: tool_call\n" +
    `data: ${JSON.stringify({
      tool_name: toolName,
      tool_input: toolInput,
      tool_call_id: toolCallId,
    })}\n\n`
  );
}

/**
 * The result of a tool call, keyed to the id its invocation carried.
 *
 * THE ID IS THE WHOLE THING, and this is a straight port of the Python note:
 * the client pairs input to output by `tool_call_id` alone, and a mismatch does
 * not error — it silently leaves the card pending forever. `on_tool_start` and
 * `on_tool_end` carry the same `run_id`, so the pairing is free; it just has to
 * be passed through.
 *
 * Output is coerced to text because the client renders it. In LangChain JS the
 * `on_tool_end` payload is a ToolMessage whose `.content` may be a string or an
 * array of content blocks, which is the same shape Python's version unwraps.
 */
export function toolEndEvent(toolCallId: string, output: unknown): string {
  return (
    "event: tool_end\n" +
    `data: ${JSON.stringify({
      tool_call_id: toolCallId,
      output: coerceToolOutput(output),
    })}\n\n`
  );
}

export function coerceToolOutput(output: unknown): string {
  let value: unknown = output;
  if (value && typeof value === "object" && "content" in value) {
    value = (value as { content: unknown }).content;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : String(part)
      )
      .join("");
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

export function messageTerminator(): string {
  return `event: message\ndata: ${JSON.stringify({ content: "" })}\n\n`;
}
