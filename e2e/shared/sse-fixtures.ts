/**
 * SSE body builder shared by the card-rendering specs.
 *
 * This exists because of severability, not tidiness. `deepagents-cards.spec.ts`
 * is OWNED by the deepagents rung in rungs.json and dies with it; the
 * shared-card coverage in `shared-cards.spec.ts` must survive that eject. If
 * the shared spec imported its helpers from the deepagents spec, ejecting
 * deepagents would break the surviving file — so the dependency runs
 * rung → shared and never the reverse.
 *
 * Not a .spec.ts, so Playwright's testMatch patterns ignore it.
 */

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
} as const;

/**
 * Build an AI SDK v6 UI-message stream carrying `dataParts`, wrapped in the
 * start/text/finish frames a real response would include.
 */
export function makeDataPartsSseBody(
  dataParts: { type: string; data: Record<string, unknown> }[],
  text = "Here are the artifacts."
): string {
  const events: string[] = [
    `data: {"type":"start","messageId":"msg-cards"}`,
    `data: {"type":"text-start","id":"t1"}`,
    `data: {"type":"text-delta","id":"t1","delta":"${text}"}`,
    `data: {"type":"text-end","id":"t1"}`,
  ];

  for (const part of dataParts) {
    events.push(`data: ${JSON.stringify(part)}`);
  }

  events.push(`data: {"type":"finish","finishReason":"stop"}`);

  return events.join("\n\n") + "\n\n";
}
