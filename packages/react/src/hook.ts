"use client";

import { useMemo, useCallback, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { ZodTypeAny } from "zod";
import type { MessageWithCustom } from "./types";
import { partsToMessages } from "./converter";

export interface UseDeepAgentsChatOptions<
  TData extends Record<string, ZodTypeAny> = Record<never, never>
> {
  /** Backend session ID — caller owns session lifecycle */
  sessionId: string;
  /** Endpoint URL for the SSE proxy route, e.g. '/api/chat/stream' */
  endpoint: string;
  /**
   * Optional token provider. Semantics mirror the server package getToken:
   * - absent or returns null/undefined → no Authorization header
   * - returns a string → Authorization: Bearer {token}
   */
  getToken?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  /**
   * Optional runtime schema map for custom data-* parts.
   * Keys must match the TData generic parameter keys.
   * Example: schemas={{ 'data-plan': PlanSchema }}
   * Used internally to pass to partsToMessages — consumers rarely need to set this directly;
   * prefer the TData generic parameter which carries the type at compile time.
   */
  schemas?: TData;
  /**
   * Optional extra fields to merge into the request body sent to the endpoint.
   * Merged with the default { sessionId } body field.
   * Example: body={{ adapterName: 'langgraph' }}
   */
  body?: Record<string, unknown>;
  /**
   * Whether stream reconnection is enabled. Mirrors ENABLE_STREAM_RECONNECT on the server.
   * Default: false. When false, retry() is a no-op and resume: true is NOT passed to useChat.
   *
   * NOTE: Requires AI SDK bugs #6502 and #11865 to be resolved for full stability.
   * See packages/react/README.md for limitations.
   */
  enableReconnect?: boolean;
  /**
   * Stable per-conversation ID sent as X-Resume-Id header to the server.
   * Required when enableReconnect is true.
   */
  resumeId?: string;
  /**
   * URL of the GET resume handler. Required when resumeId is set.
   * Example: '/api/chat/stream/resume' — handler accepts ?resumeId=<id>
   */
  resumeEndpoint?: string;
  /**
   * Optional callback that fires once per data-* chunk as it arrives from the SSE stream.
   * Fires synchronously during stream processing — before any React state update.
   * The argument is the raw data object from the data-* envelope, already type-checked
   * against the registered schemas.
   *
   * Use this to observe streaming behavior in tests without patching internals.
   * Not intended for production use — use the messages array for that.
   */
  onChunk?: (chunk: unknown) => void;
}

export interface UseDeepAgentsChatReturn<
  TData extends Record<string, ZodTypeAny> = Record<never, never>
> {
  messages: MessageWithCustom<TData>[];
  sendMessage: (text: string) => void;
  status: "idle" | "streaming" | "submitted" | "error";
  error: Error | null;
  /**
   * Manually trigger stream reconnection. No-op when enableReconnect is false.
   * Sets status to 'submitted' while reconnecting.
   * Useful for Page Visibility API integration (workaround for AI SDK bug #11865).
   */
  retry: () => void;
}

/**
 * useDeepAgentsChat — wraps @ai-sdk/react useChat with DefaultChatTransport
 * pre-wired for the DeepAgents SSE proxy route.
 *
 * Usage (two-line consumer setup):
 *   import { useDeepAgentsChat } from '@deepagents-nextjs/react'
 *   const { messages, sendMessage } = useDeepAgentsChat({
 *     sessionId: 'abc-123',
 *     endpoint: '/api/chat/stream',
 *   })
 *
 * Usage (with custom data-* schema narrowing):
 *   import { useDeepAgentsChat, PlanSchema } from '@deepagents-nextjs/react'
 *   const { messages } = useDeepAgentsChat<{ 'data-plan': typeof PlanSchema }>({
 *     sessionId: 'abc-123',
 *     endpoint: '/api/chat/stream',
 *     schemas: { 'data-plan': PlanSchema },
 *   })
 *   // messages: (Message | { type: 'data-plan', data: DataPlan })[]
 */
export function useDeepAgentsChat<
  TData extends Record<string, ZodTypeAny> = Record<never, never>
>({
  sessionId,
  endpoint,
  getToken,
  schemas,
  body: extraBody,
  enableReconnect = false,
  resumeId,
  resumeEndpoint,
  onChunk,
}: UseDeepAgentsChatOptions<TData>): UseDeepAgentsChatReturn<TData> {
  // extraBodyRef tracks the latest extraBody without recreating the transport.
  // Without this, the body closure would capture the stale extraBody from the
  // first render (useMemo only runs when its deps change, and extraBody is not
  // in the dep array to avoid chat history resets on every body object change).
  const extraBodyRef = useRef(extraBody);
  extraBodyRef.current = extraBody;

  // Transport is stable as long as endpoint, sessionId, and reconnect options don't change.
  // getToken is excluded from the dep array — callers should pass a stable ref
  // (e.g. a useCallback or a module-level function).
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: endpoint,
        headers: async (): Promise<Record<string, string>> => {
          const base: Record<string, string> = {};
          if (enableReconnect && resumeId) base["x-resume-id"] = resumeId;
          if (!getToken) return base;
          const token = await Promise.resolve(getToken());
          return token ? { ...base, Authorization: `Bearer ${token}` } : base;
        },
        body: () => ({ sessionId, ...extraBodyRef.current }),
        ...(enableReconnect && resumeId && resumeEndpoint
          ? {
              prepareReconnectToStreamRequest: () => ({
                api: `${resumeEndpoint}${
                  resumeEndpoint.includes("?") ? "&" : "?"
                }resumeId=${resumeId}`,
              }),
            }
          : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getToken excluded: stable ref assumed
    [endpoint, sessionId, enableReconnect, resumeId, resumeEndpoint]
  );

  const {
    messages: aiMessages,
    sendMessage: aiSendMessage,
    status,
    error,
    regenerate,
  } = useChat({
    transport,
    resume: enableReconnect && !!resumeId,
    // onData fires synchronously inside the AI SDK's stream processor —
    // before any React state update lands. Use this to observe streaming
    // timing without patching internals.
    onData: onChunk
      ? (chunk: unknown) => {
          // Only fire for DeepAgents data-* parts (DataUIPart shape)
          if (chunk && typeof chunk === "object" && "type" in chunk && String((chunk as {type:unknown}).type).startsWith("data-")) {
            onChunk(chunk);
          }
        }
      : undefined,
  });

  const isStreaming = status === "streaming" || status === "submitted";

  const messages = useMemo(
    () =>
      partsToMessages(
        aiMessages,
        isStreaming,
        schemas as Record<string, ZodTypeAny> | undefined
      ) as MessageWithCustom<TData>[],
    [aiMessages, isStreaming, schemas]
  );

  let derivedStatus: UseDeepAgentsChatReturn["status"];
  if (isStreaming) {
    derivedStatus = status as "streaming" | "submitted";
  } else if (error) {
    derivedStatus = "error";
  } else {
    derivedStatus = "idle";
  }

  const retry = useCallback(() => {
    if (enableReconnect) regenerate();
  }, [enableReconnect, regenerate]);

  return {
    messages,
    sendMessage: (text: string) => aiSendMessage({ text }),
    status: derivedStatus,
    error: error ?? null,
    retry,
  };
}
