/**
 * @deepagents-nextjs/react
 *
 * React hook and types for DeepAgents AI SDK v6 integration.
 *
 * Usage (two-line consumer setup):
 *   import { useDeepAgentsChat } from '@deepagents-nextjs/react'
 *   const { messages, sendMessage } = useDeepAgentsChat({
 *     sessionId: 'abc-123',
 *     endpoint: '/api/chat/stream',
 *   })
 */

// Components
export { ProcessingRow } from "./ProcessingRow";
export type { ProcessingRowProps } from "./ProcessingRow";
export {
  formatElapsed,
  processingDetail,
  processingVerb,
  shouldShowProcessing,
  tokenSegment,
} from "./processing-status";
export type { ChatStatus, ProcessingState, Usage } from "./processing-status";
export { ApprovalCard } from "./ApprovalCard";
export { ApprovalPauseCard } from "./ApprovalPauseCard";
export type {
  ApprovalPauseCardProps,
  ApprovalPauseDecision,
} from "./ApprovalPauseCard";
export {
  useApprovalPauseController,
  DECISIONS_FIELD,
} from "./useApprovalPauseController";
export type {
  UseApprovalPauseControllerOptions,
  UseApprovalPauseControllerReturn,
} from "./useApprovalPauseController";
export type {
  ApprovalCardProps,
  ApprovalDecisionFailure,
} from "./ApprovalCard";
export { PlanCard } from "./PlanCard";
export type { PlanCardProps } from "./PlanCard";
export { TaskCard } from "./TaskCard";
export type { TaskCardProps } from "./TaskCard";
export { FileCard } from "./FileCard";
export type { FileCardProps } from "./FileCard";
export { SubAgentCard } from "./SubAgentCard";
export type { SubAgentCardProps } from "./SubAgentCard";
// Rung-5-owned (software-developer-agent): pruned when a fork ejects below rung 5.
export { TestingCard } from "./TestingCard";
export type { TestingCardProps } from "./TestingCard";
export { HumanResponseCard } from "./HumanResponseCard";
export type { HumanResponseCardProps } from "./HumanResponseCard";
export { TodoCard } from "./TodoCard";
export type { TodoCardProps } from "./TodoCard";
export { AgentsMdCard } from "./AgentsMdCard";
export type { AgentsMdCardProps } from "./AgentsMdCard";
export { PlanProgress } from "./PlanProgress";
export type { PlanProgressProps } from "./PlanProgress";

// Hooks
export { useDeepAgentsChat } from "./hook";
export type { UseDeepAgentsChatOptions, UseDeepAgentsChatReturn } from "./hook";
export {
  useApprovalResponse,
  ApprovalResponseError,
} from "./useApprovalResponse";
export { useApprovalCardController } from "./useApprovalCardController";
export type {
  UseApprovalCardControllerOptions,
  UseApprovalCardControllerReturn,
} from "./useApprovalCardController";
export type {
  UseApprovalResponseOptions,
  UseApprovalResponseReturn,
  UseApprovalResponseStatus,
  ApprovalDecision,
  ApprovalEditPayload,
  ApprovalRespondFn,
  ApprovalRespondPayload,
  ApprovalResponseSuccess,
} from "./useApprovalResponse";

// Message types
export type {
  Message,
  UserMessage,
  AIMessage,
  ToolCallMessage,
  // A MEMBER OF THE EXPORTED `Message` UNION, so a consumer narrowing on
  // `msg.type === "unreadable"` could reach the shape and not name it (#446).
  UnreadableMessage,
  ErrorMessage,
  // `ToolCallMessage.status` is typed with this, and ToolCallMessage is public —
  // the field was readable and its type unnameable.
  ToolCallStatus,
} from "./types";
export type { CustomDataParts, MessageWithCustom } from "./types";
export { generateId, assertNever } from "./types";

// Zod schemas
export {
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  ApprovalPauseSchema,
  ApprovalActionRequestSchema,
  ApprovalReviewConfigSchema,
  ApprovalDecisionTypeSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  // `origin` is a field ON DataErrorSchema, so a consumer holding a parsed
  // data-error can READ it — and needs the schema to validate one itself. The
  // TYPE alone would leave the value unreachable, which #445's runtime
  // completeness guard catches once it lands (verified: it reports
  // ErrorOriginSchema missing). Exported together so the two guards agree.
  ErrorOriginSchema,
  PlanSubtaskSchema,
  TodoItemSchema,
  TodoSchema,
  AgentsMdSchema,
  // Rung-5-owned (software-developer-agent). A fork ejected below rung 5 prunes
  // these along with the rest of that rung's leaves — nothing else in the barrel
  // depends on them.
  TESTING_STATUSES,
  TestingStatusSchema,
  TestingRunSchema,
  TestingSchema,
  parseDataPart,
} from "./schemas";
export type {
  DataPlan,
  DataTask,
  DataFile,
  DataApproval,
  DataApprovalPause,
  ApprovalActionRequest,
  ApprovalReviewConfig,
  ApprovalDecisionType,
  DataSubAgent,
  DataHumanResponse,
  DataError,
  ErrorOrigin,
  // Rung 5's payload types. TestingCard, TestingCardProps and TestingSchema were
  // already public while these were not — the same asymmetry rung 5 keeps
  // showing (#12, #422), here in the barrel (#446).
  DataTesting,
  DataTestingRun,
  DataTestingStatus,
  PlanSubtask,
  ParseDataPartResult,
  ParseDataPartOk,
  ParseDataPartErr,
  TodoItem,
  DataTodo,
  DataAgentsMd,
} from "./schemas";

// Converter (exported for advanced consumers)
export { partsToMessages } from "./converter";
export {
  getBrowserOwnerKey,
  APPROVAL_OWNER_STORAGE_KEY,
} from "./browser-owner-key";
