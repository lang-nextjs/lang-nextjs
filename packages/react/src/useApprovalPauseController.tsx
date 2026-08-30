"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  ApprovalPauseDecision,
  ApprovalPauseCardProps,
} from "./ApprovalPauseCard";
import type { ApprovalDecisionType, DataApprovalPause } from "./schemas";

/**
 * The field the backends parse. `_common.py`:
 *
 *   DECISIONS_FIELD = "approvalDecisions"
 *
 * Named once here so the client cannot drift from the parser by a typo that
 * would read, on the wire, as "an ordinary turn with no decisions" — which is
 * silence, the defect #420 exists to remove.
 */
export const DECISIONS_FIELD = "approvalDecisions";

export interface UseApprovalPauseControllerOptions {
  /**
   * Where a resumed turn is sent. The decisions ride on an ORDINARY CHAT
   * REQUEST — `parse_approval_decisions(body)` reads them off the dispatch body
   * — not on a separate approval route. That is the structural difference from
   * the old `/api/approval/[id]` path, which answered a gate that had already
   * let the tool run.
   */
  endpoint?: string;
  /**
   * The conversation context the resumed turn needs (runtime, aiBackend, and
   * anything else the ordinary turn carries). Supplied by the consumer because
   * only it knows the conversation; the controller adds the decisions.
   */
  baseBody?: () => Record<string, unknown>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface UseApprovalPauseControllerReturn {
  /**
   * Props for each pending action, in the pause's own order. Spread onto an
   * <ApprovalPauseCard>. Empty when there is no pause — which is the presence
   * companion at the API level: an ungated turn produces no cards and no request.
   */
  cardPropsFor: (pause: DataApprovalPause) => ApprovalPauseCardProps[];
  /** True once every action in the pause has a decision and the POST is away. */
  submitting: boolean;
  /** Reset between pauses. */
  reset: () => void;
}

/**
 * The decisions permitted for `action_requests[index]`.
 *
 * BY INDEX, NOT BY NAME, and the difference is a real defect rather than a
 * preference. Measured upstream by DEV1: the middleware appends one
 * `action_request` and one `review_config` per interrupted call IN LOCKSTEP, so
 * the two lists are the same length and aligned by position. Nothing says a
 * pause cannot contain the SAME TOOL TWICE — one AI message with two
 * `increment` calls is an ordinary shape — and a name lookup answers the first
 * one for both, which is a silently wrong allowed-set rather than a crash.
 *
 * The name is still checked, as a contract assertion rather than a lookup key.
 * If the entry at this index describes a different action, the two lists have
 * lost their alignment and NOTHING here can say which decisions are permitted —
 * so the card renders surfaced-but-unanswerable instead of guessing.
 */
function allowedFor(
  pause: DataApprovalPause,
  index: number,
  actionName: string
): readonly ApprovalDecisionType[] {
  const configs = pause.interrupt.review_configs ?? [];
  const entry = configs[index];
  if (!entry || entry.action_name !== actionName) return [];
  return entry.allowed_decisions;
}

/**
 * useApprovalPauseController — collects a decision per pending action and
 * resumes the run with all of them (#420 piece 3).
 *
 * WHY DECISIONS ARE COLLECTED RATHER THAN SENT ONE AT A TIME. `action_requests`
 * is a list and `approvalDecisions` is a list, matched POSITIONALLY — decision
 * `i` answers request `i`. Sending the first decision alone would resume the run
 * with a shorter list than it has requests, which is a different statement from
 * the one the operator made. So the resume fires when every action has an
 * answer, and a partially-answered pause stays open.
 *
 * MEASURED BY DEV1 UPSTREAM, so this is a contract and not a guess:
 * `human_in_the_loop.py:475` walks `decisions[decision_idx]` in the same order
 * as `interrupt_indices`, and :459 RAISES on
 * `len(decisions) != len(interrupt_indices)`. A short list is not a partial
 * answer, it is a ValueError — and because the dispatch parses the body without
 * access to graph state, that failure comes back as a `data-error` frame inside
 * a 200 rather than as a 400. Sending only complete lists is what keeps this
 * client out of that path entirely: the array built below always has exactly
 * one entry per action request, or it is not sent.
 *
 * With a single-action pause this degenerates
 * to "decide, and it sends". Building the list case up front rather than
 * retrofitting it is deliberate: whether a pause can carry several actions is a
 * structural question, and the answer changes the component tree, not a
 * constant.
 */
export function useApprovalPauseController({
  endpoint = "/api/chat/stream",
  baseBody,
  fetchImpl,
}: UseApprovalPauseControllerOptions = {}): UseApprovalPauseControllerReturn {
  const [decisions, setDecisions] = useState<
    Record<number, ApprovalPauseDecision>
  >({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setDecisions({});
    setErrors({});
    setSubmitting(false);
  }, []);

  const resume = useCallback(
    async (ordered: ApprovalPauseDecision[]): Promise<void> => {
      setSubmitting(true);
      const doFetch = fetchImpl ?? fetch;
      try {
        const body = {
          ...(baseBody ? baseBody() : {}),
          [DECISIONS_FIELD]: ordered,
        };
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          let detail = `resume failed with status ${response.status}`;
          try {
            const parsed = (await response.json()) as { error?: string };
            if (parsed?.error) detail = parsed.error;
          } catch {
            // No JSON body — keep the status-based message.
          }
          throw new Error(detail);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [endpoint, baseBody, fetchImpl]
  );

  const cardPropsFor = useCallback(
    (pause: DataApprovalPause): ApprovalPauseCardProps[] => {
      const requests = pause.interrupt.action_requests;
      return requests.map((action, index) => ({
        action,
        allowedDecisions: allowedFor(pause, index, action.name),
        disabled: submitting || index in decisions,
        decisionError: errors[index] ?? null,
        onDecide: async (decision: ApprovalPauseDecision) => {
          const next = { ...decisions, [index]: decision };
          setDecisions(next);
          setErrors((prev) => {
            if (!(index in prev)) return prev;
            const copy = { ...prev };
            delete copy[index];
            return copy;
          });

          // Every action answered? Then and only then does the run resume.
          const ordered: ApprovalPauseDecision[] = [];
          for (let i = 0; i < requests.length; i++) {
            const d = next[i];
            if (!d) return; // still waiting on another action
            ordered.push(d);
          }

          try {
            await resume(ordered);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Attributed to THIS card, not to a banner. The failure belongs to
            // the action whose decision was being sent — the per-approval
            // lesson from #399, applied before it can be got wrong again.
            setErrors((prev) => ({ ...prev, [index]: message }));
            // The answer did not land, so the action is answerable again.
            setDecisions((prev) => {
              const copy = { ...prev };
              delete copy[index];
              return copy;
            });
            throw err;
          }
        },
      }));
    },
    [decisions, errors, submitting, resume]
  );

  return useMemo(
    () => ({ cardPropsFor, submitting, reset }),
    [cardPropsFor, submitting, reset]
  );
}
