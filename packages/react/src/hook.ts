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
  /**
   * Per-browser approval owner key, sent as `x-approval-owner`. Pass
   * `getBrowserOwnerKey()`. Absent leaves approvals resolvable by id alone — the
   * documented pre-#170 contract — so wiring this is opt-in. It is a bearer token, not
   * authentication; see the security-model block in the server's approval-routes.ts.
   */
  ownerKey?: string;
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
  /**
   * Abort the in-flight reply.
   *
   * DROPPED AT THE WRAPPER UNTIL #262. `useChat` has always returned `stop`, and
   * not re-exporting it did not narrow the UI — it narrowed the API, for every
   * consumer of this hook. A long or looping reply had to be waited out or the
   * tab closed, and nothing failed to say so: the surface was simply thinner
   * than the platform underneath it.
   *
   * Safe to call when idle; the SDK no-ops.
   */
  stop: () => void;
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
  ownerKey,
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
          // Stamps every approval this stream raises with the caller's owner key, so only the
          // same browser can resolve it. Absent -> approvals carry no owner and stay
          // resolvable by id alone, the documented pre-#170 contract. (#170)
          if (ownerKey) base["x-approval-owner"] = ownerKey;
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
              /*
               * A SERVER SAYING "I DO NOT OFFER THIS" IS NOT A FAILED CONVERSATION.
               *
               * `resume: true` makes the SDK fire a GET at the resume endpoint on mount.
               * When ENABLE_STREAM_RECONNECT is unset the handler answers 503, that landed
               * in useChat's `error`, and the status derivation below turned it into
               * `"error"` — so a surface that merely ASKED to reconnect painted a red dot
               * and an "Error:" banner on first paint, before the user touched anything.
               *
               * That is the default configuration. `apps/example/.env.example` ships the
               * flag COMMENTED OUT, so every fork that copied it and ran `pnpm dev` got a
               * chat that looked broken on load. Three CI jobs caught it; setting the flag
               * in those three jobs would have turned them green and shipped the defect.
               *
               * 503 ONLY, AND THE OTHERS STAY LOUD. This is a swallow, and the scope is
               * the whole argument:
               *
               *   503  the server is telling us reconnection is DISABLED HERE. That is a
               *        capability statement, not a failure of this conversation, and it
               *        means exactly what 204 means to this client: nothing to resume.
               *   404  MUST stay loud. It means "this route does not answer the shape I
               *        asked for" — the #372 defect, where the hook requested ?resumeId=
               *        and the only handler was a path segment. It survived the entire
               *        life of the feature because nothing surfaced it. Making 404 inert
               *        would re-hide the next URL-contract drift.
               *   5xx  stays loud. A resume endpoint that is genuinely broken should be
               *        visible.
               *
               * AND 503 STAYS 503 ON THE WIRE. The handler must not answer 204 when
               * disabled: its own comment explains that overloading 204 makes "disabled"
               * indistinguishable from "that stream is finished", which is how the
               * original bug hid. The transport distinction is worth keeping. What
               * changes is only what the CLIENT does with it.
               */
              fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await globalThis.fetch(input, init);
                if (response.status !== 503) return response;
                const url =
                  typeof input === "string"
                    ? input
                    : input instanceof URL
                    ? input.href
                    : input.url;
                // Scoped to the resume endpoint. A 503 from the CHAT endpoint is a real
                // outage and must not be silently turned into an empty stream.
                const resumePath = resumeEndpoint.split("?")[0];
                if (!url.split("?")[0].endsWith(resumePath)) return response;
                return new Response(null, { status: 204 });
              },
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
    stop,
  } = useChat({
    transport,
    resume: enableReconnect && !!resumeId,
    // onData fires synchronously inside the AI SDK's stream processor —
    // before any React state update lands. Use this to observe streaming
    // timing without patching internals.
    onData: onChunk
      ? (chunk: unknown) => {
          // Only fire for DeepAgents data-* parts (DataUIPart shape)
          if (
            chunk &&
            typeof chunk === "object" &&
            "type" in chunk &&
            String((chunk as { type: unknown }).type).startsWith("data-")
          ) {
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
    // Passed straight through, NOT wrapped in a guard on `status`. The SDK owns
    // whether an abort is meaningful right now, and a wrapper that second-
    // guessed it would reintroduce the same narrowing one layer down.
    stop,
  };
}
