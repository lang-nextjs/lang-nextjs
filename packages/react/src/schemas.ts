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
/*  ApprovalPauseSchema (data-approval-pause) — #420                          */
/* -------------------------------------------------------------------------- */

/**
 * THE PAUSE FROM A GATE THAT ACTUALLY WITHHOLDS (#420).
 *
 * NOT to be confused with `ApprovalSchema` / `data-approval-required` above,
 * which this file keeps unchanged. That one is raised by the proxy-side
 * transform AFTER the backend has already run the tool — it withholds the
 * report, not the effect (#261). This one comes from an upstream interrupt: the
 * call has not run and will not run until a decision arrives.
 *
 * The names are deliberately not adjacent. Two similar identifiers for the
 * withholding and the non-withholding path is how someone wires the wrong one.
 *
 * CARRIED VERBATIM, KEYS AND ALL. The payload is upstream's interrupt value,
 * passed through by the Python backend under `interrupt` and re-labelled by the
 * adapter without being rewritten. Renaming `action_requests` to `actionRequests`
 * here would create a mapping with nothing asserting the two sides agree — the
 * second-declaration shape #420's ruling names — for a cosmetic gain. snake_case
 * in this one schema is the cost of not owning a translation.
 */
export const ApprovalActionRequestSchema = z.object({
  /** Tool name, as upstream will call it. */
  name: z.string(),
  /** The arguments the model proposed. An `edit` decision replaces these. */
  args: z.record(z.string(), z.unknown()),
  description: z.string().nullish(),
});
export type ApprovalActionRequest = z.infer<typeof ApprovalActionRequestSchema>;

/**
 * `allowed_decisions` is the card's ONLY source for which controls to render.
 *
 * That is the binding constraint from #420's ruling: the card decides from the
 * frame and never asks "is this topology gated". Because upstream states the
 * permitted decisions per action name here, rendering from this list means the
 * client holds no second copy of the gating fact and cannot drift from
 * GATED_TOPOLOGIES.
 *
 * The four are upstream's own vocabulary and are NOT collapsible: `reject` and
 * `respond` both mean "do not run it" and produce OPPOSITE ToolMessage statuses
 * (error vs success), so folding `respond` into a deny control would tell the
 * model the user REFUSED when the user ANSWERED on the tool's behalf.
 */
export const ApprovalDecisionTypeSchema = z.enum([
  "approve",
  "edit",
  "reject",
  "respond",
]);
export type ApprovalDecisionType = z.infer<typeof ApprovalDecisionTypeSchema>;

export const ApprovalReviewConfigSchema = z.object({
  action_name: z.string(),
  allowed_decisions: z.array(ApprovalDecisionTypeSchema),
});
export type ApprovalReviewConfig = z.infer<typeof ApprovalReviewConfigSchema>;

export const ApprovalPauseSchema = z.object({
  /**
   * The whole envelope, so the adapter's job is re-labelling rather than
   * reshaping. If DEV1's adapter settles on a different wrapper key, this object
   * is the one line that changes.
   */
  interrupt: z.object({
    action_requests: z.array(ApprovalActionRequestSchema),
    /**
     * Optional at the type level because upstream's shape is not ours to
     * guarantee. An action with no matching entry renders SURFACED BUT
     * UNANSWERABLE rather than defaulting: offering all four when upstream
     * permits two is a control that cannot keep its promise, and offering none
     * silently is the silence #420 exists to remove.
     */
    review_configs: z.array(ApprovalReviewConfigSchema).nullish(),
  }),
});
export type DataApprovalPause = z.infer<typeof ApprovalPauseSchema>;

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
/*  TestingSchema (data-testing) — rung 5, software-developer-agent           */
/* -------------------------------------------------------------------------- */

/**
 * Every status `data-testing` can carry.
 *
 * The first six are verbatim from `set_testing_status`'s Zod enum in the vendored
 * rung-5 source (`rungs/5-software-developer-agent/apps/open-swe/src/tools/
 * set-testing-status.ts`). `"unknown"` is NOT upstream's — it is the value
 * sdaEnrich.ts coerces to when a model sends a status outside the enum, so that a
 * garbage value is never reported as a real state the graph entered.
 *
 * `"unknown"` MUST stay in this list. It is a value the producer genuinely emits,
 * and converter.ts is fail-open: a status this enum forgot is a part the user never
 * sees, warned to console and discarded. That is the #59 failure mode exactly — a
 * schema narrower than its producer silently deletes real frames.
 */
export const TESTING_STATUSES = [
  "not_started",
  "required",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "unknown",
] as const;

/** A testing STATE TRANSITION — `set_testing_status`. */
export const TestingStatusSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.literal("status"),
  status: z.enum(TESTING_STATUSES),
  /** Why the agent set this status. Always present, may be empty. */
  reason: z.string(),
  updatedAt: z.string(),
});
export type DataTestingStatus = z.infer<typeof TestingStatusSchema>;

/** A test RUN — the `playwright` tool. */
export const TestingRunSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.literal("run"),
  /** run_tests | run_test_file | install | init | codegen | show_report | check_config */
  command: z.string(),
  testFile: z.string().nullish(),
  browser: z.string().nullish(),
  headless: z.boolean(),
  status: z.enum(TESTING_STATUSES),
  updatedAt: z.string(),
});
export type DataTestingRun = z.infer<typeof TestingRunSchema>;

/**
 * data-testing — rung-5-owned. Discriminated on `kind` so a status transition and
 * a test run land in one panel while staying structurally distinct.
 *
 * This part exists because no existing part can carry it: `data-todo`'s vocabulary
 * is pending/in-progress/done, and "the tests ran and FAILED" versus "testing was
 * SKIPPED because only docs changed" is not any of those. That distinction is the
 * Testing graph's entire output, so flattening it into a checklist would discard
 * the signal the rung exists to produce.
 */
export const TestingSchema = z.discriminatedUnion("kind", [
  TestingStatusSchema,
  TestingRunSchema,
]);
export type DataTesting = z.infer<typeof TestingSchema>;

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
  // Rung-5-owned (software-developer-agent). Defined AND registered together —
  // #59's defect was a tag that was emitted and published but absent from this
  // map, so consumers reached it through hand-written type guards instead of the
  // schema. A schema that exists but is not registered here is not a schema.
  "data-testing": TestingSchema,
};

/**
 * Every `data-*` part THIS BUILD declares, derived from the registry above.
 *
 * Exported because a fork declares FEWER: `pnpm eject` prunes SCHEMA_MAP entries whose
 * `x-emitted-by` names a dropped rung (#89), so a rung-1 fork speaks five parts where the
 * full ladder speaks eleven. Anything enumerating parts — a test, a consumer's dispatch
 * table, a docs generator — has to ask rather than hardcode, or it carries a full-ladder
 * assumption into a tree that is entitled not to have the full ladder.
 *
 * That is not hypothetical: `schemas.test.ts` hardcoded the list, survived the eject on the
 * shared `packages/react/**` glob, and then asserted on parts the same change had correctly
 * deleted. Seven failures, in the file next to this one.
 */
export const KNOWN_DATA_PART_TYPES: readonly string[] = Object.freeze(
  Object.keys(SCHEMA_MAP)
);

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
