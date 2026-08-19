/**
 * Pure converter from AI SDK UIMessage[] to typed Message[].
 *
 * Handles ONLY:
 *  - user messages → UserMessage
 *  - assistant text parts → AIMessage (concatenated per message)
 *  - tool-call parts (dynamic-tool, tool-*) → ToolCallMessage
 *  - data-error parts → ErrorMessage (via DataErrorSchema)
 *  - custom data-* parts → { type: string; data: unknown } when customSchemaMap provided
 *
 * All other data-* parts (data-plan, data-task, data-file, data-approval, etc.)
 * without a matching customSchemaMap entry are console.warn + dropped.
 *
 * No SeqBuffer, no upsert maps, no approval/plan/task/file state buckets.
 * This is the generic transport layer — not the app-specific state manager.
 */
import type { UIMessage } from "ai";
import type { ZodTypeAny } from "zod";
import { DataErrorSchema } from "./schemas";
import type {
  AIMessage,
  ErrorMessage,
  Message,
  ToolCallMessage,
  UserMessage,
} from "./types";

/* -------------------------------------------------------------------------- */
/*  Debug logger                                                               */
/* -------------------------------------------------------------------------- */

// Enable in browser: `localStorage.debug = 'deepagents:sse'` (then refresh).
// Multiple namespaces: comma-separate, e.g. 'deepagents:sse,foo:bar'.
// Wildcard '*' enables everything.
const SSE_NS = "deepagents:sse";
const SSE_DEBUG_ENABLED: boolean = (() => {
  try {
    const flag: string =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("debug") ?? ""
        : "";
    return flag.split(",").some((ns: string) => {
      const trimmed = ns.trim();
      return trimmed === SSE_NS || trimmed === "*";
    });
  } catch {
    return false;
  }
})();

function dbg(...args: unknown[]): void {
  if (SSE_DEBUG_ENABLED) console.log(`[${SSE_NS}]`, ...args);
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function isToolCallPart(part: unknown): part is {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolName?: string;
} {
  // Pre-condition: caller (L139-141) guarantees part is a non-null object with string type.
  // The type assertion is safe here; cast directly.
  const p = part as { type: string };
  return p.type === "dynamic-tool" || p.type.startsWith("tool-");
}

function toolStateToStatus(state: string): "running" | "complete" {
  if (state === "input-streaming" || state === "input-available")
    return "running";
  return "complete";
}

function extractToolName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "unknown";
  // Static: 'tool-${NAME}' — strip the 'tool-' prefix
  return part.type.slice("tool-".length);
}

/* -------------------------------------------------------------------------- */
/*  Public: partsToMessages                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Convert AI SDK UIMessage[] to typed Message[].
 *
 * @param aiMessages - The `messages` array from useChat.
 * @param isStreaming - True when useChat status is 'streaming' or 'submitted'.
 *   Used to flag the latest assistant message with `isStreaming: true`.
 * @param customSchemaMap - Optional map of data-* type strings to Zod schemas.
 *   When provided, matching data-* parts are parsed and included in the output
 *   as `{ type: string; data: unknown }`. The hook's TData generic narrows the type.
 *   Parts whose schema fails safeParse are console.warn'd and dropped (fail-open).
 */
export function partsToMessages(
  aiMessages: UIMessage[],
  isStreaming: boolean,
  customSchemaMap?: Record<string, ZodTypeAny>
): Message[] {
  // Defensive: useChat() may return messages: undefined before the first
  // message lands, OR may return an array containing null/undefined slots
  // (hostile or buggy AI SDK shapes). Treat null/undefined as an empty array
  // AND filter out null/undefined entries so the subsequent .reduce/.forEach
  // don't throw "Cannot read properties of null (reading 'role')" on a bad slot.
  const safeAiMessages: UIMessage[] = (aiMessages ?? []).filter(
    (m) => m != null
  );
  dbg("partsToMessages: input", {
    messages: safeAiMessages.length,
    streaming: isStreaming,
    customSchemas: customSchemaMap ? Object.keys(customSchemaMap) : [],
  });

  const lastAssistantIdx = safeAiMessages.reduce(
    (acc, m, i) => (m.role === "assistant" ? i : acc),
    -1
  );
  const out: Message[] = [];

  safeAiMessages.forEach((msg, msgIdx) => {
    const isLastAssistantStreaming = isStreaming && msgIdx === lastAssistantIdx;

    // ---- User messages ----
    if (msg.role === "user") {
      let content = "";
      for (const part of (msg.parts ?? []) as unknown[]) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text"
        ) {
          const { text } = part as { text?: unknown };
          if (typeof text === "string") content += text;
        }
      }
      const user: UserMessage = {
        type: "user",
        id: msg.id,
        content,
        timestamp: new Date(),
      };
      out.push(user);
      return;
    }

    if (msg.role !== "assistant") return;

    // ---- Assistant messages: single pass over parts[] in stream order ----
    const parts = (msg.parts ?? []) as unknown[];
    let textBuffer = "";
    let aiBubbleSeq = 0;
    let lastAiBubbleIdx = -1;
    const toolSeenIds = new Map<string, number>();
    const outStartIdx = out.length; // track if this message added anything

    function flushText(): void {
      if (!textBuffer) return;
      const bubbleId =
        aiBubbleSeq === 0 ? msg.id : `${msg.id}#ai-${aiBubbleSeq}`;
      const ai: AIMessage = {
        type: "ai",
        id: bubbleId,
        content: textBuffer,
        timestamp: new Date(),
        isStreaming: false,
      };
      lastAiBubbleIdx = out.length;
      out.push(ai);
      aiBubbleSeq += 1;
      textBuffer = "";
    }

    for (const rawPart of parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const partType = (rawPart as { type?: unknown }).type;
      if (typeof partType !== "string") continue;

      if (partType === "text") {
        // ---- text parts ----
        const { text } = rawPart as { text?: unknown };
        if (typeof text === "string") textBuffer += text;
      } else if (isToolCallPart(rawPart)) {
        // ---- tool-call parts ----
        flushText();
        const part = rawPart;
        const { toolCallId } = part;
        if (typeof toolCallId !== "string" || toolCallId === "") continue;

        const state =
          typeof part.state === "string" ? part.state : "input-streaming";
        const status = toolStateToStatus(state);
        const toolName = extractToolName(part);
        const args =
          part.input && typeof part.input === "object"
            ? (part.input as Record<string, unknown>)
            : undefined;
        let result: unknown;
        if (state === "output-error") {
          result = part.errorText ?? "Tool error";
        } else if (part.output !== undefined) {
          result = part.output;
        }
        const toolMsg: ToolCallMessage = {
          type: "tool-call",
          id: toolCallId,
          toolName,
          status,
          ...(args !== undefined ? { arguments: args } : {}),
          ...(result !== undefined ? { result } : {}),
        };

        const existingIdx = toolSeenIds.get(toolCallId);
        if (existingIdx !== undefined) {
          out[existingIdx] = toolMsg;
          dbg("tool update", {
            toolName,
            status,
            id: toolCallId,
            hasResult: result !== undefined,
          });
        } else {
          toolSeenIds.set(toolCallId, out.length);
          out.push(toolMsg);
          dbg("tool new", { toolName, status, id: toolCallId });
        }
      } else if (partType.startsWith("data-")) {
        // ---- data-* parts ----
        flushText();
        dbg("data part", { type: partType });
        const envelope = rawPart as { data?: unknown };

        if (partType === "data-error") {
          // Check customSchemaMap first: if caller overrides data-error, custom wins
          const customSchema = customSchemaMap?.["data-error"];
          if (customSchema) {
            // Custom data-* part: runtime push, type narrowed by hook's TData generic
            const parsed = customSchema.safeParse(envelope.data);
            if (parsed.success) {
              out.push({
                type: partType,
                data: parsed.data,
              } as unknown as Message);
            } else {
              console.warn(
                "[partsToMessages] dropped invalid custom data-* part:",
                partType,
                parsed.error?.message
              );
            }
          } else {
            const parsed = DataErrorSchema.safeParse(envelope.data);
            if (parsed.success) {
              const e = parsed.data;
              const err: ErrorMessage = {
                type: "error",
                id: e.id,
                message: e.message,
                retryable: e.retryable,
              };
              out.push(err);
            } else {
              // EVENTS-05: log once, drop, do not throw
              console.warn(
                "[partsToMessages] dropped invalid data-error part",
                parsed.error?.message
              );
            }
          }
        } else {
          // Check customSchemaMap first; then warn+drop
          const customSchema = customSchemaMap?.[partType];
          if (customSchema) {
            const parsed = customSchema.safeParse(envelope.data);
            if (parsed.success) {
              // Custom data-* part: runtime push, type narrowed by hook's TData generic
              out.push({
                type: partType,
                data: parsed.data,
              } as unknown as Message);
            } else {
              console.warn(
                "[partsToMessages] dropped invalid custom data-* part:",
                partType,
                parsed.error?.message
              );
            }
          } else {
            // Unknown data-* type — log and drop
            console.warn(
              "[partsToMessages] dropped unsupported data-* part type:",
              partType
            );
          }
        }
      }
    }

    // Flush trailing text
    flushText();

    // Apply streaming caret to the last AI bubble
    if (isLastAssistantStreaming) {
      if (lastAiBubbleIdx >= 0) {
        (out[lastAiBubbleIdx] as AIMessage).isStreaming = true;
      } else if (
        !out
          .slice(outStartIdx)
          .some((m) => m.type === "ai" || m.type === "error")
      ) {
        // No text bubble yet and no error — emit a caret bubble.
        // Error messages suppress the caret: an error is a terminal state,
        // not a "model is still working" state.
        const caret: AIMessage = {
          type: "ai",
          id: msg.id,
          content: "",
          timestamp: new Date(),
          isStreaming: true,
        };
        out.push(caret);
      }
    }

    // Edge case: assistant message with no parts at all (or only unknown parts)
    // Only emit the empty bubble if this message added nothing to out[]
    if (
      aiBubbleSeq === 0 &&
      !isLastAssistantStreaming &&
      out.length === outStartIdx
    ) {
      out.push({
        type: "ai",
        id: msg.id,
        content: "",
        timestamp: new Date(),
        isStreaming: false,
      });
    }
  });

  dbg("partsToMessages: output", {
    out: out.length,
    byType: out.reduce<Record<string, number>>((acc, m) => {
      acc[m.type] = (acc[m.type] ?? 0) + 1;
      return acc;
    }, {}),
  });

  return out;
}
