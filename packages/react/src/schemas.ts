/**
 * Zod schemas for DeepAgents custom data-* SSE parts.
 *
 * Exports four primary schemas matching the ROADMAP contract:
 * PlanSchema, TaskSchema, FileSchema, ApprovalSchema.
 *
 * Also exports DataErrorSchema and parseDataPart() for use in the converter.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  PlanSubtaskSchema — shared sub-schema used by PlanSchema                  */
/* -------------------------------------------------------------------------- */

export const PlanSubtaskSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pending", "in-progress", "done"]),
});
export type PlanSubtask = z.infer<typeof PlanSubtaskSchema>;

/* -------------------------------------------------------------------------- */
/*  PlanSchema (data-plan) — EVENTS-01                                        */
/* -------------------------------------------------------------------------- */

export const PlanSchema = z.object({
  /** Stable plan ID — upsert key */
  id: z.string(),
  /** Monotonic sequence number per stream */
  seq: z.number().int().nonnegative(),
  title: z.string(),
  /** Full plan body as markdown */
  markdown: z.string(),
  subtasks: z.array(PlanSubtaskSchema),
  /** ISO-8601 timestamp */
  updatedAt: z.string(),
});
export type DataPlan = z.infer<typeof PlanSchema>;

/* -------------------------------------------------------------------------- */
/*  TaskSchema (data-task) — EVENTS-03                                        */
/* -------------------------------------------------------------------------- */

export const TaskSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  taskName: z.string(),
  status: z.enum(["pending", "in-progress", "done"]),
  /** nullish: optional + nullable (Python Pydantic emits null for Optional[str]=None) */
  description: z.string().nullish(),
  groupLabel: z.string().nullish(),
});
export type DataTask = z.infer<typeof TaskSchema>;

/* -------------------------------------------------------------------------- */
/*  FileSchema (data-file) — EVENTS-04                                        */
/* -------------------------------------------------------------------------- */

export const FileSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** Virtual filesystem path, e.g. "/work/notes.md" */
  path: z.string(),
  /** Basename of the file */
  name: z.string(),
  /** Optional language hint for syntax highlighting */
  language: z.string().nullish(),
  /** Size in bytes */
  size: z.number().int().nonnegative(),
  /** True if content was truncated at the 1MB limit */
  truncated: z.boolean(),
  /** Optional file content — omitted for large files */
  content: z.string().nullish(),
  updatedAt: z.string(),
});
export type DataFile = z.infer<typeof FileSchema>;

/* -------------------------------------------------------------------------- */
/*  ApprovalSchema (data-approval) — HITL-01                                  */
/* -------------------------------------------------------------------------- */

export const ApprovalSchema = z.object({
  /** Approval ID; matches backend interrupt ID for resume */
  id: z.string(),
  seq: z.number().int().nonnegative(),
  actionName: z.string(),
  description: z.string(),
  /**
   * Normally the tool's input object. May instead be the literal string
   * "<unserializable>": approval-gating.ts falls back to that sentinel when
   * JSON.stringify throws on a self-referential input, deliberately, so the
   * approval UI can still render with a placeholder rather than the stream
   * dying. Before #59 this union was missing and `data-approval-required` had
   * no registered schema, so nothing validated the fallback; registering the
   * schema without widening here would have silently DROPPED that frame
   * (converter.ts is fail-open: invalid parts are warned and discarded),
   * defeating the fallback's whole purpose.
   */
  arguments: z.union([
    z.record(z.string(), z.unknown()),
    z.literal("<unserializable>"),
  ]),
  status: z.enum(["waiting", "approved", "rejected", "timeout"]),
  createdAt: z.string(),
  /** Optional expiry timestamp */
  expiresAt: z.string().nullish(),
});
export type DataApproval = z.infer<typeof ApprovalSchema>;

/* -------------------------------------------------------------------------- */
/*  DataSubAgentSchema (data-sub-agent) — DEEPAGENTS-01                       */
/* -------------------------------------------------------------------------- */

/**
 * Frame describing a DeepAgents sub-agent invocation (the `task` tool delegates
 * work to a fresh sub-agent with its own LLM context). Upserted by `id` —
 * downstream consumers replace prior entries with the same id rather than
 * appending. Maps to the spawn / progress / completion lifecycle of a sub-agent.
 */
export const DataSubAgentSchema = z.object({
  /** Sub-agent invocation id (stable across updates). */
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** ToolCallId of the parent `task` tool call that spawned this sub-agent. */
  parentToolCallId: z.string(),
  /** Name/role of the sub-agent (e.g. 'researcher', 'code-reviewer'). */
  name: z.string(),
  /** Lifecycle status. */
  status: z.enum(["starting", "running", "done", "errored"]),
  /** The prompt the parent passed to the sub-agent. */
  prompt: z.string(),
  /** Final answer text when status === 'done'. Nullish otherwise. */
  result: z.string().nullish(),
  /** Error message when status === 'errored'. Nullish otherwise. */
  error: z.string().nullish(),
  /** ISO 8601 timestamp when the sub-agent was spawned. */
  startedAt: z.string(),
  /** ISO 8601 timestamp when the sub-agent finished. Nullish while running. */
  finishedAt: z.string().nullish(),
});
export type DataSubAgent = z.infer<typeof DataSubAgentSchema>;

/* -------------------------------------------------------------------------- */
/*  DataHumanResponseSchema (data-human-response) — HITL-02                   */
/* -------------------------------------------------------------------------- */

/**
 * Frame emitted by the approval gating transform when an approval is resolved
 * with decision: 'respond'. Carries the human-authored text back to the client;
 * the original tool action is NOT executed. Consumers typically surface the
 * text to the agent loop as a new user message.
 */
export const DataHumanResponseSchema = z.object({
  /** approvalId of the approval that produced this response. */
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** Human-authored reply text — what the human said back to the agent. */
  response: z.string(),
  /** ISO 8601 timestamp of when the transform emitted this frame. */
  createdAt: z.string(),
});
export type DataHumanResponse = z.infer<typeof DataHumanResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  DataErrorSchema (data-error) — STREAM-07                                  */
/* -------------------------------------------------------------------------- */

export const DataErrorSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** Stable error code, e.g. 'llm_timeout', 'tool_failed', 'interrupted' */
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  /** Optional structured context for debugging */
  cause: z.record(z.string(), z.unknown()).nullish(),
});
export type DataError = z.infer<typeof DataErrorSchema>;

/* -------------------------------------------------------------------------- */
/*  TodoSchema (data-todo) — write_todos tool output                          */
/* -------------------------------------------------------------------------- */

export const TodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in-progress", "done"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  items: z.array(TodoItemSchema),
});
export type DataTodo = z.infer<typeof TodoSchema>;

/* -------------------------------------------------------------------------- */
/*  AgentsMdSchema (data-agents-md) — AGENTS.md context injection             */
/* -------------------------------------------------------------------------- */

export const AgentsMdSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  content: z.string(),
  path: z.string(),
});
export type DataAgentsMd = z.infer<typeof AgentsMdSchema>;

/* -------------------------------------------------------------------------- */
/*  parseDataPart() — safe parser for data-* envelopes                        */
/* -------------------------------------------------------------------------- */

/**
 * Known data-* type strings and their schemas.
 * Unknown types return ok:false.
 */
const SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  "data-plan": PlanSchema,
  "data-task": TaskSchema,
  "data-file": FileSchema,
  "data-approval": ApprovalSchema,
  // open-swe's plan-mode gate and core's generic tool gate carry the SAME
  // payload shape but DIFFERENT tags. `data-approval-required` was emitted by
  // approval-gating.ts and declared in docs/sse-frame-schema.json, yet was
  // absent from this map (#59) — so consumers reached it through hand-written
  // type guards instead of the schema. Both are registered now.
  "data-approval-required": ApprovalSchema,
  "data-sub-agent": DataSubAgentSchema,
  "data-human-response": DataHumanResponseSchema,
  "data-error": DataErrorSchema,
  "data-todo": TodoSchema,
  "data-agents-md": AgentsMdSchema,
};

export interface ParseDataPartOk {
  ok: true;
  type: string;
  data: unknown;
}

export interface ParseDataPartErr {
  ok: false;
  error: z.ZodError | undefined;
  raw: unknown;
}

export type ParseDataPartResult = ParseDataPartOk | ParseDataPartErr;

/**
 * Safely parse an unknown value as a DeepAgents data-* part envelope.
 *
 * Expects: `{ type: 'data-*', data: {...} }`
 *
 * Returns `{ ok: true, type, data }` on success.
 * Returns `{ ok: false, error, raw }` on failure — including unknown types.
 * Does NOT throw.
 */
export function parseDataPart(raw: unknown): ParseDataPartResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: undefined, raw };
  }
  const envelope = raw as { type?: unknown; data?: unknown };
  if (typeof envelope.type !== "string") {
    return { ok: false, error: undefined, raw };
  }
  const schema = SCHEMA_MAP[envelope.type];
  if (!schema) {
    return { ok: false, error: undefined, raw };
  }
  const result = schema.safeParse(envelope.data);
  if (result.success) {
    return { ok: true, type: envelope.type, data: result.data };
  }
  return { ok: false, error: result.error, raw };
}
