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
  | "interrupted";

export interface RawMessage {
  type?: string; // "human" | "ai" | "tool" | "system"
  role?: string;
  name?: string | null;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
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

/** Map a raw LangGraph thread status onto the run page's status vocabulary. */
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
      return "completed";
    default:
      return "completed";
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
      if (text.trim())
        items.push({ id: `a-${i++}`, kind: "assistant", text });
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
