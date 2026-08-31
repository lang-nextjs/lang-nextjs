"use client";

import { useCallback, useState } from "react";
import {
  useApprovalResponse,
  ApprovalResponseError,
} from "./useApprovalResponse";
import type {
  UseApprovalResponseOptions,
  UseApprovalResponseStatus,
} from "./useApprovalResponse";
import type {
  ApprovalCardProps,
  ApprovalDecisionFailure,
} from "./ApprovalCard";
import type { DataApproval } from "./schemas";

/**
 * Statuses that mean the decision can never land, however many times it is sent.
 *
 *   404 — no such approval, or it expired. The proxy-side registry answers this
 *         when an id is not in its Map — see approval-routes.ts.
 *   409 — already resolved (another tab answered first), OR the backend-side
 *         thread that held the pause is gone. The latter is #399's own case, and
 *         it is a 409 rather than a 404 because the chat endpoint ALREADY spends
 *         404 on "unknown backend" and "unknown topology" — a 404 there would be
 *         indistinguishable from a routing failure.
 *
 * BOTH ARE UNRESOLVABLE FOR THE SAME REASON: no retry of THIS decision can land,
 * whichever mechanism lost it.
 *
 * Everything else is treated as a blip and stays retryable. That asymmetry is
 * the point: disabling the buttons on a 503 would turn a recoverable hiccup
 * into a dead card.
 */
const UNRESOLVABLE_STATUSES = new Set([404, 409]);

function describeFailure(err: unknown): ApprovalDecisionFailure {
  if (err instanceof ApprovalResponseError) {
    return {
      // ApprovalResponseError takes its message from the route's `error` field,
      // so this is the server's own words — "approval not found or expired" —
      // rather than a status code the operator has to interpret.
      message: err.message,
      unresolvable: UNRESOLVABLE_STATUSES.has(err.statusCode),
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    unresolvable: false,
  };
}

export interface UseApprovalCardControllerOptions
  extends UseApprovalResponseOptions {}

export interface UseApprovalCardControllerReturn {
  /**
   * Returns ApprovalCard props pre-wired with onApprove/onReject/onEdit/onRespond
   * handlers that POST to the configured endpoint. The returned object is
   * spread directly onto an <ApprovalCard /> element:
   *
   *   const { cardPropsFor } = useApprovalCardController({ endpoint: '/api/approval' });
   *   <ApprovalCard {...cardPropsFor(approval)} />
   *
   * Each handler resolves when the POST returns 2xx and rejects otherwise.
   * Callers can override individual handlers via the optional second arg —
   * useful for showing optimistic UI before the network round-trip completes.
   */
  cardPropsFor: (
    approval: DataApproval,
    overrides?: Partial<ApprovalCardProps>
  ) => ApprovalCardProps;
  /** State of the most recent respond() call. */
  status: UseApprovalResponseStatus;
  /** Last error from a failed respond() call. */
  error: Error | null;
  /** Reset status/error back to idle/null. */
  reset: () => void;
}

/**
 * useApprovalCardController — composes useApprovalResponse and ApprovalCard
 * into a one-call integration. Eliminates the boilerplate of wiring four
 * handlers (approve/reject/edit/respond) for every approval card.
 *
 * Auto-disables card buttons while a submission is in flight (status ===
 * "submitting"), matching ApprovalCard's existing `disabled` prop contract.
 */
export function useApprovalCardController({
  endpoint,
  // Inherited from UseApprovalResponseOptions — this interface is `extends … {}`, so the
  // field needed no declaration here, only forwarding. (#170)
  ownerKey,
  getToken,
  fetchImpl,
}: UseApprovalCardControllerOptions): UseApprovalCardControllerReturn {
  const { respond, status, error, reset } = useApprovalResponse({
    endpoint,
    ownerKey,
    getToken,
    fetchImpl,
  });

  /*
   * FAILURES ARE KEYED BY APPROVAL ID, and that is the substance of #399 rather
   * than a detail of it.
   *
   * `useApprovalResponse` already exposed an `error`, and the shell already
   * destructured it — and never rendered it, which is how a decision for a lost
   * thread came to change nothing on screen. But wiring that field up would not
   * have been enough either: it describes the most recent call for the WHOLE
   * hook, while `cardPropsFor` is per-approval. With two cards open it names no
   * card, so the operator is told that something failed and left to guess which
   * click it was. Keyed by id, the failure reaches the card it belongs to.
   */
  const [failures, setFailures] = useState<
    Record<string, ApprovalDecisionFailure>
  >({});

  const attempt = useCallback(
    async (approvalId: string, run: () => Promise<unknown>): Promise<void> => {
      // Clear this card's previous failure before retrying, so a retry that
      // succeeds does not leave a stale alert next to a card that worked.
      setFailures((prev) => {
        if (!(approvalId in prev)) return prev; // keep identity — no re-render
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
      try {
        await run();
      } catch (err) {
        setFailures((prev) => ({
          ...prev,
          [approvalId]: describeFailure(err),
        }));
        // RETHROWN, DELIBERATELY. The documented contract is that these handlers
        // reject on non-2xx, and consumers depend on it: both shells dismiss the
        // card only after `await`ing the handler, so swallowing here would make
        // a failed decision dismiss the card — the exact "looks answered" state
        // this issue exists to remove.
        throw err;
      }
    },
    []
  );

  const cardPropsFor = useCallback(
    (
      approval: DataApproval,
      overrides?: Partial<ApprovalCardProps>
    ): ApprovalCardProps => {
      // Wrap respond() so the callbacks return Promise<void> instead of
      // Promise<ApprovalResponseSuccess> — ApprovalCard's prop types reject
      // the wider return because the UI has nothing to do with the body.
      const wrap =
        <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
        async (...args: A): Promise<void> => {
          await attempt(approval.id, () => fn(...args));
        };
      const base: ApprovalCardProps = {
        approval,
        onApprove: wrap(() => respond(approval.id, "approve")),
        onReject: wrap(() => respond(approval.id, "reject")),
        onEdit: wrap((editedInput: Record<string, unknown>) =>
          respond(approval.id, "edit", { editedInput })
        ),
        onRespond: wrap((response: string) =>
          respond(approval.id, "respond", { response })
        ),
        disabled: status === "submitting",
        decisionFailure: failures[approval.id] ?? null,
      };
      return overrides ? { ...base, ...overrides } : base;
    },
    [respond, status, failures, attempt]
  );

  return { cardPropsFor, status, error, reset };
}
