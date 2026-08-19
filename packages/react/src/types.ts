/**
 * Message type system for @deepagents-nextjs/react.
 * Discriminated union with explicit type literal for each variant.
 * Discriminator: the `type` field.
 */
import type { ZodTypeAny } from "zod";
import { z } from "zod";

export interface UserMessage {
  type: "user";
  id: string;
  content: string;
  timestamp: Date;
}

export interface AIMessage {
  type: "ai";
  id: string;
  content: string;
  timestamp: Date;
  isStreaming: boolean;
}

export interface ToolCallMessage {
  type: "tool-call";
  id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  status: "running" | "complete";
  result?: unknown;
}

export interface ErrorMessage {
  type: "error";
  id: string;
  message: string;
  retryable: boolean;
}

/**
 * Discriminated union of all message variants.
 * Discriminator: the `type` field.
 */
export type Message = UserMessage | AIMessage | ToolCallMessage | ErrorMessage;

/**
 * Maps a TData schema record to a discriminated union of custom data-* message variants.
 * Each key K in TData becomes { type: K, data: z.infer<TData[K]> }.
 *
 * Internal helper — used by hook.ts to extend the Message union at compile time.
 */
export type CustomDataParts<TData extends Record<string, ZodTypeAny>> = {
  [K in keyof TData & string]: {
    type: K;
    data: z.infer<TData[K]>;
  };
}[keyof TData & string];

/**
 * The full message union for a parameterized useDeepAgentsChat<TData> call.
 * When TData = {} (default), resolves to Message (zero-generic compat).
 * When TData = { 'data-plan': typeof PlanSchema }, resolves to Message | { type: 'data-plan', data: DataPlan }.
 */
export type MessageWithCustom<TData extends Record<string, ZodTypeAny>> =
  keyof TData extends never ? Message : Message | CustomDataParts<TData>;

/**
 * Generate a unique ID using crypto.randomUUID()
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Exhaustive check helper for discriminated unions.
 * Place in the default case of a switch on Message.type.
 * TypeScript will error at compile time if any variant is unhandled.
 */
export function assertNever(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`
  );
}
