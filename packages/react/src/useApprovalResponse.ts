"use client";

import { useCallback, useRef, useState } from "react";

export type ApprovalDecision = "approve" | "reject" | "edit" | "respond";

/**
 * Payload for the "edit" decision — replaces the buffered tool-input-start
 * input on the server before the transform drains. Maps to LangGraph
 * HumanInterrupt's "edit" response.
 */
export interface ApprovalEditPayload {
  editedInput: Record<string, unknown>;
}

/**
 * Payload for the "respond" decision — a human-authored text reply that the
 * server emits as a data-human-response frame. The buffered tool action does
 * NOT execute. Maps to LangGraph HumanInterrupt's "response" reply. Consumers
 * typically forward the text back to the LLM as a new user message.
 */
export interface ApprovalRespondPayload {
  response: string;
}

export interface UseApprovalResponseOptions {
  /**
   * Base path of the approval routes — `${endpoint}/${approvalId}` is the URL
   * POSTed to. Typically `/api/approval` when the consumer mounts
   * `createApprovalRoutes()` at `app/api/approval/[approvalId]/route.ts`.
   */
  endpoint: string;
  /**
   * Optional token provider. Semantics mirror useDeepAgentsChat.getToken:
   * - absent or returns null/undefined → no Authorization header
   * - returns a string → Authorization: Bearer {token}
   */
  getToken?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  /**
   * Optional fetch override. Defaults to the global `fetch`. Used by tests
   * to inject a mock without monkey-patching globals.
   */
  fetchImpl?: typeof fetch;
}

export type UseApprovalResponseStatus =
  | "idle"
  | "submitting"
  | "success"
  | "error";

export interface ApprovalResponseSuccess {
  id: string;
  decision: ApprovalDecision;
  accepted: true;
}

/**
 * Overloaded respond function — keeps the 2-arg form for approve/reject and
 * requires the third payload arg for "edit" and "respond" (typechecker
 * enforces the payload shape per decision).
 */
export interface ApprovalRespondFn {
  (
    approvalId: string,
    decision: "approve" | "reject"
  ): Promise<ApprovalResponseSuccess>;
  (
    approvalId: string,
    decision: "edit",
    payload: ApprovalEditPayload
  ): Promise<ApprovalResponseSuccess>;
  (
    approvalId: string,
    decision: "respond",
    payload: ApprovalRespondPayload
  ): Promise<ApprovalResponseSuccess>;
}

export interface UseApprovalResponseReturn {
  /**
   * Submit a decision for an approval. Resolves to the parsed JSON body on
   * 2xx and rejects with an ApprovalResponseError on non-2xx. The third arg
   * (payload) is required only for decision === "edit".
   */
  respond: ApprovalRespondFn;
  /** State of the most recent respond() call. */
  status: UseApprovalResponseStatus;
  /** Last error from a failed respond() call. */
  error: Error | null;
  /** Reset status/error back to idle/null. */
  reset: () => void;
}

export class ApprovalResponseError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "ApprovalResponseError";
  }
}

/**
 * useApprovalResponse — submits an approve/reject decision to the approval
 * route mounted by createApprovalRoutes() on the server.
 *
 * Usage:
 *   const { respond, status, error } = useApprovalResponse({
 *     endpoint: '/api/approval',
 *   });
 *   await respond(approval.id, 'approve');
 */
export function useApprovalResponse({
  endpoint,
  getToken,
  fetchImpl,
}: UseApprovalResponseOptions): UseApprovalResponseReturn {
  const [status, setStatus] = useState<UseApprovalResponseStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  // Refs let respond's identity stay stable across renders without stale closures.
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const fetchImplRef = useRef(fetchImpl);
  fetchImplRef.current = fetchImpl;

  const respond = useCallback(
    async (
      approvalId: string,
      decision: ApprovalDecision,
      payload?: ApprovalEditPayload | ApprovalRespondPayload
    ): Promise<ApprovalResponseSuccess> => {
      setStatus("submitting");
      setError(null);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (getTokenRef.current) {
        const token = await Promise.resolve(getTokenRef.current());
        if (token) headers.Authorization = `Bearer ${token}`;
      }

      const base = endpointRef.current.replace(/\/$/, "");
      const url = `${base}/${encodeURIComponent(approvalId)}`;
      const doFetch = fetchImplRef.current ?? fetch;

      const requestBody: Record<string, unknown> = { decision };
      if (decision === "edit") {
        const editPayload = payload as ApprovalEditPayload | undefined;
        if (
          !editPayload ||
          editPayload.editedInput === null ||
          typeof editPayload.editedInput !== "object" ||
          Array.isArray(editPayload.editedInput)
        ) {
          const err = new Error(
            "respond('edit', ...) requires payload.editedInput to be a plain object"
          );
          setError(err);
          setStatus("error");
          throw err;
        }
        requestBody.editedInput = editPayload.editedInput;
      }
      if (decision === "respond") {
        const respondPayload = payload as ApprovalRespondPayload | undefined;
        if (
          !respondPayload ||
          typeof respondPayload.response !== "string" ||
          respondPayload.response.length === 0
        ) {
          const err = new Error(
            "respond('respond', ...) requires payload.response to be a non-empty string"
          );
          setError(err);
          setStatus("error");
          throw err;
        }
        requestBody.response = respondPayload.response;
      }

      try {
        const response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        });

        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // Response had no JSON body — leave body as null.
        }

        if (!response.ok) {
          const message =
            (body as { error?: string } | null)?.error ??
            `approval response failed with status ${response.status}`;
          const err = new ApprovalResponseError(response.status, body, message);
          setError(err);
          setStatus("error");
          throw err;
        }

        setStatus("success");
        return body as ApprovalResponseSuccess;
      } catch (err) {
        if (err instanceof ApprovalResponseError) throw err;
        // Network-level failure (fetch rejected, AbortError, etc.)
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        setStatus("error");
        throw wrapped;
      }
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { respond, status, error, reset };
}
