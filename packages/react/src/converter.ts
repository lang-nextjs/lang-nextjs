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
  ToolCallStatus,
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

/**
 * The SDK's tool-part state, as what a person needs to know about it.
 *
 * `return "complete"` used to be the fall-through, so a tool that THREW and a
 * tool a human REFUSED both arrived as success — green dot, the word
 * "complete", in both apps. See the note on ToolCallStatus.
 */
function toolStateToStatus(state: string): ToolCallStatus {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "running";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
    case "output-available":
      return "complete";
    default:
      // An UNKNOWN state is not evidence of success. A future SDK state
      // arriving here should render as still-running — which is recoverable
      // and honest — rather than as a finished, successful call.
      return "running";
  }
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
    let unreadableSeq = 0;

    /**
     * Surface a data-* part we could not read, instead of dropping it.
     *
     * The console.warn is kept — it carries the detail a developer wants — but
     * it is no longer the ONLY signal. A warning in a console nobody has open
     * is indistinguishable from silence, and silence here is indistinguishable
     * from a run that produced nothing. The pushed message is what makes the
     * two tellable apart by anyone looking at the UI.
     */
    function pushUnreadable(
      partType: string,
      reason: "schema-rejected" | "unknown-type",
      detail?: string
    ): void {
      out.push({
        type: "unreadable",
        // Deterministic: same input, same ids. Tests should not have to
        // tolerate a random id to assert on this.
        id: `${msg.id}:unreadable:${unreadableSeq++}`,
        partType,
        reason,
        detail,
        timestamp: new Date(),
      });
    }
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
                "[partsToMessages] unreadable custom data-* part:",
                partType,
                parsed.error?.message
              );
              pushUnreadable(partType, "schema-rejected", parsed.error?.message);
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
              // EVENTS-05: log once, do not throw. No longer dropped: an
              // unreadable error frame is the worst one to lose silently.
              console.warn(
                "[partsToMessages] unreadable data-error part",
                parsed.error?.message
              );
              pushUnreadable(partType, "schema-rejected", parsed.error?.message);
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
                "[partsToMessages] unreadable custom data-* part:",
                partType,
                parsed.error?.message
              );
              pushUnreadable(partType, "schema-rejected", parsed.error?.message);
            }
          } else {
            // No schema for this type at all — usually version skew rather
            // than drift, which is why `reason` distinguishes them.
            console.warn(
              "[partsToMessages] unreadable data-* part, no schema:",
              partType
            );
            pushUnreadable(partType, "unknown-type");
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
