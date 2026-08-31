"use client";

import { useCallback, useState } from "react";
import type { ApprovalActionRequest, ApprovalDecisionType } from "./schemas";

/**
 * A decision for ONE action request, in upstream's own vocabulary (#420).
 *
 * This is the wire shape the backend parses (`_common.py parse_approval_decisions`),
 * not a client-side model of it. `edit` carries structured `edited_action`
 * because the tool runs with DIFFERENT args — there is no truthful way to say
 * that with a boolean and a string, which is exactly why this repo diverged from
 * the AI SDK's `{id, approved, reason}`.
 */
export type ApprovalPauseDecision =
  | { type: "approve" }
  | {
      type: "edit";
      edited_action: { name: string; args: Record<string, unknown> };
    }
  | { type: "reject" }
  | { type: "respond"; message: string };

export interface ApprovalPauseCardProps {
  /** One entry from the pause's `action_requests`. */
  action: ApprovalActionRequest;
  /**
   * Which controls to offer, taken from this action's `allowed_decisions`.
   *
   * THE CARD DECIDES FROM THE FRAME. It never asks whether this topology gates —
   * that fact lives in GATED_TOPOLOGIES on the server, and a second copy here
   * would drift the first time someone edited one and not the other. An empty
   * list is not "all four": it renders the pause with no controls and says why.
   */
  allowedDecisions: readonly ApprovalDecisionType[];
  /** Submit the decision for this action. Rejects if the POST fails. */
  onDecide: (decision: ApprovalPauseDecision) => void | Promise<void>;
  /** True once this action has been answered, or while a submit is in flight. */
  disabled?: boolean;
  /** Outcome of a submitted decision that did not take effect. */
  decisionError?: string | null;
  className?: string;
}

type Mode = "actions" | "edit" | "respond";

const ORDER: readonly ApprovalDecisionType[] = [
  "approve",
  "edit",
  "reject",
  "respond",
];

/**
 * ApprovalPauseCard — the surface for a gate that genuinely withholds (#420).
 *
 * The tool has NOT run. It runs, runs with different arguments, or does not run,
 * according to what is chosen here. That is the difference from ApprovalCard,
 * which this file deliberately does not touch or extend: that card is driven by
 * `data-approval-required` from the proxy transform, which fires after the
 * backend already ran the call. Per #420's ruling the two never share an
 * affordance — a cell is either genuinely gated and shows THIS card, or ungated
 * and shows no approval affordance at all.
 *
 * `reject` and `respond` are both offered as first-class controls because they
 * mean opposite things to the model: reject produces a ToolMessage with
 * status="error" framed as a user refusal, respond produces status="success"
 * where the human's text IS the tool's result. Collapsing respond into a deny
 * button would report a refusal the user never made.
 *
 * Styling is opt-in via className; every part carries `data-slot` for styling and
 * `data-testid` for tests, per the repo convention that those must not be the
 * same identifier.
 */
export function ApprovalPauseCard({
  action,
  allowedDecisions,
  onDecide,
  disabled = false,
  decisionError = null,
  className,
}: ApprovalPauseCardProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("actions");
  const [argsText, setArgsText] = useState<string>(() =>
    JSON.stringify(action.args, null, 2)
  );
  const [argsError, setArgsError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<string>("");

  const offered = ORDER.filter((d) => allowedDecisions.includes(d));
  const answerable = offered.length > 0 && !disabled;

  /*
   * The handlers reject on a failed decision, and this card is what invoked
   * them, so this is where the rejection stops — the same argument as #399's
   * ApprovalCard. An unhandled rejection is a console warning, and a console
   * warning is not a surface. What the operator sees comes from `decisionError`.
   */
  const fire = useCallback((run: () => void | Promise<void>): void => {
    const result = run();
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => {});
    }
  }, []);

  const submitEdit = useCallback(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText);
    } catch (err) {
      setArgsError(
        err instanceof Error ? err.message : "arguments are not valid JSON"
      );
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      setArgsError("arguments must be a JSON object");
      return;
    }
    setArgsError(null);
    /*
     * `name` is carried from the request rather than made editable. `edited_action`
     * chooses the ARGUMENTS for the call the model proposed; letting the operator
     * retarget it at a different tool would be a different action entirely, and
     * upstream's `review_configs` permitted a decision about THIS one.
     */
    fire(() =>
      onDecide({
        type: "edit",
        edited_action: {
          name: action.name,
          args: parsed as Record<string, unknown>,
        },
      })
    );
  }, [argsText, action.name, onDecide, fire]);

  const submitRespond = useCallback(() => {
    if (replyText.length === 0) return;
    fire(() => onDecide({ type: "respond", message: replyText }));
  }, [replyText, onDecide, fire]);

  return (
    <div
      data-testid="approval-pause-card"
      data-slot="approval-pause-card"
      data-action-name={action.name}
      /*
       * Observable state, so a test can tell a card that went unanswerable from
       * one that merely printed something — the distinction #399 turned on.
       */
      data-answerable={answerable ? "yes" : "no"}
      data-decision={decisionError ? "failed" : undefined}
      className={className}
      role="region"
      aria-label={`Approval required before running ${action.name}`}
    >
      <header>
        <span data-testid="pause-action-name" data-slot="pause-action-name">
          {action.name}
        </span>
        {action.description ? (
          <span data-testid="pause-description" data-slot="pause-description">
            {action.description}
          </span>
        ) : null}
      </header>

      {/* The proposed call, so the decision is made against what will run. */}
      <pre data-testid="pause-arguments" data-slot="pause-arguments">
        {JSON.stringify(action.args, null, 2)}
      </pre>

      {decisionError ? (
        <p
          data-testid="pause-decision-error"
          data-slot="pause-decision-error"
          role="alert"
        >
          {decisionError}
        </p>
      ) : null}

      {offered.length === 0 ? (
        /*
         * SURFACED BUT UNANSWERABLE — A MALFORMED-FRAME GUARD, NOT AN EXPECTED
         * UPSTREAM STATE. The distinction is DEV1's measurement, not my reading.
         *
         * I first wrote this branch for "upstream may not say which decisions
         * are permitted". It cannot: the middleware RAISES on a tool config with
         * an empty or missing `allowed_decisions`, on the stated grounds that it
         * "would otherwise be silently dropped, disabling the approval gate for
         * that tool". So there is no absent case to define a meaning for.
         *
         * What reaches here instead is a frame that lost its shape in transit —
         * `review_configs` shorter than `action_requests`, or its entry at this
         * index naming a different action, which means the two lists are no
         * longer aligned and nothing can say what is permitted for THIS call.
         *
         * Both alternatives are worse. Offering all four would be a control that
         * cannot keep its promise, which this repo refuses to ship elsewhere.
         * Rendering nothing at all is the silence #420 exists to remove. So the
         * pause is shown, the tool is named, and the gap is said out loud where
         * someone will see it.
         */
        <p
          data-testid="pause-no-decisions"
          data-slot="pause-no-decisions"
          role="status"
        >
          This call is waiting for a decision, but the backend did not say which
          decisions are permitted, so none can be offered here.
        </p>
      ) : null}

      {mode === "actions" && offered.length > 0 && (
        <div data-testid="pause-actions" data-slot="pause-actions">
          {offered.includes("approve") && (
            <button
              type="button"
              data-testid="pause-approve-button"
              data-slot="pause-approve-button"
              onClick={() => fire(() => onDecide({ type: "approve" }))}
              disabled={!answerable}
            >
              Approve
            </button>
          )}
          {offered.includes("edit") && (
            <button
              type="button"
              data-testid="pause-show-edit-button"
              onClick={() => setMode("edit")}
              disabled={!answerable}
            >
              Edit arguments
            </button>
          )}
          {offered.includes("reject") && (
            <button
              type="button"
              data-testid="pause-reject-button"
              data-slot="pause-reject-button"
              onClick={() => fire(() => onDecide({ type: "reject" }))}
              disabled={!answerable}
            >
              Reject
            </button>
          )}
          {offered.includes("respond") && (
            <button
              type="button"
              data-testid="pause-show-respond-button"
              onClick={() => setMode("respond")}
              disabled={!answerable}
            >
              Answer instead
            </button>
          )}
        </div>
      )}

      {mode === "edit" && (
        /*
         * AN ARGS EDITOR, NOT A BUTTON. `edited_action` is structured
         * {name, args}; a boolean plus a free-text reason cannot express it, and
         * that is the measured reason this repo's wire diverges from the AI
         * SDK's approval shape rather than a preference.
         */
        <div data-testid="pause-edit-panel" data-slot="pause-edit-panel">
          <label htmlFor={`pause-args-${action.name}`}>
            Arguments for {action.name} (JSON)
          </label>
          <textarea
            id={`pause-args-${action.name}`}
            data-testid="pause-args-input"
            value={argsText}
            onChange={(e) => {
              setArgsText(e.target.value);
              if (argsError) setArgsError(null);
            }}
            disabled={!answerable}
            rows={6}
          />
          {argsError && (
            <p data-testid="pause-args-error" role="alert">
              {argsError}
            </p>
          )}
          <button
            type="button"
            data-testid="pause-submit-edit-button"
            onClick={submitEdit}
            disabled={!answerable}
          >
            Run with these arguments
          </button>
          <button
            type="button"
            data-testid="pause-cancel-edit-button"
            onClick={() => {
              setArgsError(null);
              setArgsText(JSON.stringify(action.args, null, 2));
              setMode("actions");
            }}
            disabled={!answerable}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "respond" && (
        <div data-testid="pause-respond-panel" data-slot="pause-respond-panel">
          {/*
           * The label says what this text BECOMES. For an "ask user" tool the
           * real implementation is the human, so this is not a comment on the
           * refusal — it is the tool's return value, delivered with
           * status="success".
           */}
          <label htmlFor={`pause-reply-${action.name}`}>
            Answer on the tool&apos;s behalf — this becomes its result
          </label>
          <textarea
            id={`pause-reply-${action.name}`}
            data-testid="pause-reply-input"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            disabled={!answerable}
            rows={3}
          />
          <button
            type="button"
            data-testid="pause-submit-respond-button"
            onClick={submitRespond}
            disabled={!answerable || replyText.length === 0}
          >
            Send as the result
          </button>
          <button
            type="button"
            data-testid="pause-cancel-respond-button"
            onClick={() => {
              setReplyText("");
              setMode("actions");
            }}
            disabled={!answerable}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
