/**
 * SSE transform pipeline for DeepAgents server.
 *
 * Ports and generalizes the inline transformSseFrame() function from
 * stsfront/next-app/app/api/chat/stream/route.ts into a named export
 * compatible with the SseTransform pipeline pattern.
 */
import type { SseFrame, SseTransform } from "./accumulator";

/**
 * Strips `messageId` from SSE `finish` frames.
 *
 * Django emits: {"type":"finish","messageId":"...","finishReason":"stop"}
 * AI SDK v6 uses z.strictObject() for the finish variant and only accepts
 * finishReason + messageMetadata — the extra messageId field triggers
 * a TypeValidationError on the client.
 *
 * This transform removes messageId before the client sees the frame.
 * All other frames pass through unmodified.
 *
 * Source: stsfront/next-app/app/api/chat/stream/route.ts transformSseFrame()
 */
export function stripMessageIdTransform(frame: SseFrame): SseFrame | null {
  // Detect line ending so we round-trip the same form back. SSE wire
  // format allows LF, CRLF, or bare CR (rare) as line terminators. We
  // split on LF and trim trailing CR per line, then rejoin with the
  // detected terminator. This preserves CRLF when the upstream uses it
  // (previously the transform silently normalized to LF).
  const useCrlf = frame.raw.includes("\r\n");
  const lineEnd = useCrlf ? "\r\n" : "\n";

  const transformed = frame.raw
    .split(lineEnd)
    .map((line) => {
      // Per SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)
      // the colon-separator may be followed by zero or one space. Both
      // `data:{...}` and `data: {...}` are valid wire forms. Match both.
      let raw: string;
      if (line.startsWith("data: ")) {
        raw = line.slice(6);
      } else if (line.startsWith("data:")) {
        raw = line.slice(5);
      } else {
        return line;
      }
      if (raw === "[DONE]") return line;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).type === "finish" &&
          "messageId" in parsed
        ) {
          const { messageId: _drop, ...rest } = parsed as Record<
            string,
            unknown
          >;
          // Re-emit using the canonical space-after-colon form. Clients
          // (browser EventSource, fetch-based parsers) accept both, and
          // the canonical form is more readable in network panels.
          return `data: ${JSON.stringify(rest)}`;
        }
      } catch {
        // Non-JSON data line — pass through as-is
      }
      return line;
    })
    .join(lineEnd);
  return { raw: transformed };
}

/**
 * Default transform pipeline applied to every SSE frame.
 *
 * @deprecated Use `deepagentsAdapter` instead:
 *   import { deepagentsAdapter } from '@deepagents-nextjs/server'
 *   createDeepAgentsHandler({ backendUrl, adapter: deepagentsAdapter })
 *
 * `defaultTransforms` is equivalent to `deepagentsAdapter.transforms` and will
 * be removed in a future major version. No runtime warning is emitted.
 *
 * Per CONTEXT.md locked decision: user-provided transforms are appended AFTER
 * defaultTransforms. The messageId strip always runs unless the user bypasses
 * defaultTransforms entirely.
 */
export const defaultTransforms: SseTransform[] = [stripMessageIdTransform];

export type { SseFrame, SseTransform };
