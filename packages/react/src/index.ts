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
export { ApprovalCard } from "./ApprovalCard";
export type { ApprovalCardProps } from "./ApprovalCard";
export { PlanCard } from "./PlanCard";
export type { PlanCardProps } from "./PlanCard";
export { TaskCard } from "./TaskCard";
export type { TaskCardProps } from "./TaskCard";
export { FileCard } from "./FileCard";
export type { FileCardProps } from "./FileCard";
export { SubAgentCard } from "./SubAgentCard";
export type { SubAgentCardProps } from "./SubAgentCard";
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
  ErrorMessage,
} from "./types";
export type { CustomDataParts, MessageWithCustom } from "./types";
export { generateId, assertNever } from "./types";

// Zod schemas
export {
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  PlanSubtaskSchema,
  TodoItemSchema,
  TodoSchema,
  AgentsMdSchema,
  parseDataPart,
} from "./schemas";
export type {
  DataPlan,
  DataTask,
  DataFile,
  DataApproval,
  DataSubAgent,
  DataHumanResponse,
  DataError,
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
