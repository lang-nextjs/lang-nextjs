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

/**
 * WHAT HAPPENED TO A TOOL CALL — four situations, not two.
 *
 * This was `"running" | "complete"`, and the AI SDK reports five states. The
 * mapper had nowhere to put two of them, so it filed both under `complete`:
 *
 *   output-error   -> "complete"   the tool THREW, rendered with a green dot
 *   output-denied  -> "complete"   the human REFUSED it, rendered as done
 *
 * Both then rendered as success in both apps — a green dot and the literal
 * word "complete" beside a tool that had failed. open-swe carries the
 * fingerprint of someone noticing: its summary line reads
 *
 *   hasResult && !/^error/i.test(resultText)
 *
 * — a regex against the RESULT TEXT to stop the error message leaking into a
 * line that claimed success, rather than a fix to the status that was lying.
 *
 * Same shape as #246 two packages away: a type with fewer states than the
 * world it models forces its mapper to invent an answer, and every invention
 * available is a claim the source never made.
 */
export type ToolCallStatus = "running" | "complete" | "error" | "denied";

export interface ToolCallMessage {
  type: "tool-call";
  id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  status: ToolCallStatus;
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
/**
 * A `data-*` part arrived and we could not read it.
 *
 * THIS EXISTS SO THAT REJECTION IS NOT SILENCE. Before it, a part that failed
 * schema validation was console.warn'd and dropped, so a backend emitting
 * subtly wrong frames rendered exactly like a backend emitting none — and the
 * defect was self-concealing, because the more frames were wrong the more were
 * dropped and the more ordinary the empty result looked.
 *
 * "Nothing was produced" and "something arrived that we could not parse" call
 * for opposite responses: the first is normal, the second means a backend
 * contract has drifted. A consumer that renders both the same way cannot tell
 * its user which one happened, so this variant carries the distinction into the
 * message union where a renderer can act on it.
 *
 * `reason` separates two causes that look identical downstream but are not:
 * `schema-rejected` is a contract that drifted; `unknown-type` is a part we
 * have no schema for at all, which is usually version skew.
 */
export interface UnreadableMessage {
  type: "unreadable";
  id: string;
  /** The part type we could not read, e.g. "data-todo". */
  partType: string;
  reason: "schema-rejected" | "unknown-type";
  /** The validator's complaint, when there was one. */
  detail?: string;
  timestamp: Date;
}

export type Message =
  | UserMessage
  | AIMessage
  | ToolCallMessage
  | ErrorMessage
  | UnreadableMessage;

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
