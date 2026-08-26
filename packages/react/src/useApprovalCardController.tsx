"use client";

import { useCallback } from "react";
import { useApprovalResponse } from "./useApprovalResponse";
import type {
  UseApprovalResponseOptions,
  UseApprovalResponseStatus,
} from "./useApprovalResponse";
import type { ApprovalCardProps } from "./ApprovalCard";
import type { DataApproval } from "./schemas";

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
          await fn(...args);
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
      };
      return overrides ? { ...base, ...overrides } : base;
    },
    [respond, status]
  );

  return { cardPropsFor, status, error, reset };
}
