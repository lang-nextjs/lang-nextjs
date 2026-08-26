/**
 * EVERY TOOL CALL THE CLIENT IS TOLD ABOUT MUST BE RESOLVED BEFORE THE STREAM
 * ENDS.
 *
 * This is the invariant that was missing when #250 shipped: the langchain
 * backend announced tool calls and never announced their results, so every tool
 * card in the UI sat on "pending" forever — for tools that had finished, whose
 * results the model had already used to answer.
 *
 * WHY AN INVARIANT AND NOT A FIXTURE TEST. The obvious instinct is to drive a
 * test from captured upstream frames. That cannot work here, and the reason is
 * worth stating: you cannot capture a frame the backend does not emit. A capture
 * of the broken langchain stream contains exactly what the broken stream
 * contains, and every assertion written from it passes forever while the UI
 * stays pending.
 *
 * Captured fixtures catch MISINTERPRETATION — the adapter mishandling a shape
 * that really arrives. This is MISSING EMISSION, and the two need opposite
 * instruments. This one names a property of the output as a whole, so it can
 * fail on an absence rather than only on a wrong presence.
 *
 * IT IS DELIBERATELY NOT AN ADAPTER'S BUSINESS. Each rung's wire format differs;
 * what does not differ is that a person watching a tool card is owed an ending.
 */

/** A tool call that was announced and never resolved. */
export interface UnpairedToolCall {
  toolCallId: string;
  toolName?: string;
}

interface ParsedFrame {
  type?: string;
  toolCallId?: string;
  toolName?: string;
}

/** Every `data:` payload in an SSE stream, parsed, in order. */
function parseFrames(sse: string): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  for (const line of sse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]" || !payload.startsWith("{")) continue;
    try {
      out.push(JSON.parse(payload) as ParsedFrame);
    } catch {
      // A non-JSON data line is not a tool frame; the pairing question does not
      // apply to it. Malformed-frame handling has its own tests elsewhere.
    }
  }
  return out;
}

/**
 * Tool calls announced to the client that never received a result.
 *
 * An EMPTY ARRAY IS ONLY MEANINGFUL ALONGSIDE `countToolCalls`. A stream with no
 * tool calls at all trivially has none unpaired, so a test asserting emptiness
 * without also asserting that calls existed is the vacuous shape this repo keeps
 * finding. Both are exported so a caller cannot accidentally assert only the
 * first.
 */
export function unpairedToolCalls(sse: string): UnpairedToolCall[] {
  const opened = new Map<string, string | undefined>();
  const closed = new Set<string>();
  for (const f of parseFrames(sse)) {
    if (!f.toolCallId) continue;
    if (f.type === "tool-input-start" || f.type === "tool-input-available") {
      if (!opened.has(f.toolCallId)) opened.set(f.toolCallId, f.toolName);
    }
    if (f.type === "tool-output-available" || f.type === "tool-output-error") {
      closed.add(f.toolCallId);
    }
  }
  return [...opened.entries()]
    .filter(([id]) => !closed.has(id))
    .map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}

/** How many distinct tool calls the stream announced. */
export function countToolCalls(sse: string): number {
  const ids = new Set<string>();
  for (const f of parseFrames(sse)) {
    if (
      f.toolCallId &&
      (f.type === "tool-input-start" || f.type === "tool-input-available")
    ) {
      ids.add(f.toolCallId);
    }
  }
  return ids.size;
}

/**
 * Did a result arrive AFTER the terminal frame?
 *
 * Separate from being unpaired, because it is a different defect with a
 * different fix: the pairing exists but the client has already stopped
 * listening, so the card is pending on screen while the data sits in a frame
 * nobody read.
 */
export function resultsAfterFinish(sse: string): string[] {
  const frames = parseFrames(sse);
  const finishAt = frames.findIndex((f) => f.type === "finish");
  if (finishAt === -1) return [];
  return frames
    .slice(finishAt + 1)
    .filter((f) => f.type === "tool-output-available" && f.toolCallId)
    .map((f) => f.toolCallId!);
}
