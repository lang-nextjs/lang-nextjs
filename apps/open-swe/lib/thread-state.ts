/**
 * Normalize a LangGraph thread's message history into a renderable conversation
 * timeline. Used by the run page to show COMPLETED runs (which can't be
 * live-streamed — the stream is already closed) as their full history.
 */

export type ThreadRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  /** The thread is not executing. NOT the same as finished — see below. */
  | "idle"
  /** We do not know. Never rendered as a terminal state. */
  | "unknown";

export interface RawMessage {
  type?: string; // "human" | "ai" | "tool" | "system"
  role?: string;
  name?: string | null;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
  tool_call_id?: string;
}

export interface ConversationItem {
  id: string;
  kind: "user" | "assistant" | "tool";
  /** user/assistant text */
  text?: string;
  /** tool fields */
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
}

/** Coerce LangChain message content (string | content-blocks[]) to text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p)
          return String((p as { text: unknown }).text);
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * Map a raw LangGraph thread status onto the run page's vocabulary.
 *
 * WHICH STORE IS AUTHORITATIVE, since this is the function that used to decide
 * it implicitly (#176):
 *
 *   the RUN RECORD  answers "did this dispatch finish?"   — running -> success
 *   the THREAD      answers "is this thread executing?"   — idle/busy/error
 *
 * They are different properties, and this function only ever sees the second.
 * So it must not answer the first. `idle` means "no run is executing on this
 * thread right now", which is equally true before a run, after a success, and
 * after a failure — it cannot distinguish finished from never-started. Mapping
 * it to `completed` asserted a fact the value does not carry, and produced the
 * green "Completed" badge on a run the kanban was still showing as running.
 *
 * `idle` therefore maps to itself and the page labels it as thread state. An
 * unrecognised or absent status maps to `unknown`, never to a terminal state:
 * not knowing is not the same as finishing, and it is the one direction where
 * guessing wrong is actively misleading.
 */
export function mapThreadStatus(
  status: string | undefined,
  hasInterrupts: boolean
): ThreadRunStatus {
  if (hasInterrupts) return "interrupted";
  switch (status) {
    case "busy":
      return "running";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

/**
 * Build a conversation timeline from thread messages. AI tool_calls are paired
 * with their `tool` result messages by tool_call_id and collapsed into a single
 * tool item (call + result together).
 */
export function normalizeMessages(messages: RawMessage[]): ConversationItem[] {
  // Index tool results by tool_call_id for pairing.
  const toolResults = new Map<string, RawMessage>();
  for (const m of messages) {
    if (m.type === "tool" && m.tool_call_id) toolResults.set(m.tool_call_id, m);
  }

  const items: ConversationItem[] = [];
  let i = 0;
  for (const m of messages) {
    if (m.type === "human" || m.role === "user") {
      const text = contentToText(m.content);
      if (text.trim()) items.push({ id: `u-${i++}`, kind: "user", text });
    } else if (m.type === "ai" || m.role === "assistant") {
      const text = contentToText(m.content);
      if (text.trim()) items.push({ id: `a-${i++}`, kind: "assistant", text });
      for (const tc of m.tool_calls ?? []) {
        const res = tc.id ? toolResults.get(tc.id) : undefined;
        const resultText = res ? contentToText(res.content) : undefined;
        items.push({
          id: tc.id ?? `t-${i++}`,
          kind: "tool",
          toolName: tc.name ?? "tool",
          args: tc.args ?? {},
          result: resultText,
          // Heuristic: tool errors usually surface "Error"/"failed" prefixes.
          ok: resultText ? !/^error|failed/i.test(resultText.trim()) : true,
        });
      }
    }
    // `tool` messages are consumed via pairing above; skip standalone render.
  }
  return items;
}
