"use client";

import { useCallback, useState } from "react";
import type { DataApproval } from "./schemas";

/**
 * Props for ApprovalCard.
 *
 * The card renders four LangGraph HumanInterrupt modes — accept/ignore are
 * always available; edit and respond are shown only when the corresponding
 * handler is provided. This keeps the surface tight (the server might be
 * configured to disallow some modes per-tool).
 */
/**
 * A decision that was submitted for THIS approval and did not take effect (#399).
 *
 * The approval's own `status` cannot carry this. That field describes the
 * server's record of the approval, and the whole point of the failure modes
 * below is that there is no longer a record to describe: a decision for a
 * thread the saver no longer holds executes nothing and raises nothing
 * (measured, #399). So the outcome of the CLICK needs a channel of its own.
 */
export interface ApprovalDecisionFailure {
  /** Rendered verbatim. Comes from the route's error body when it sent one. */
  message: string;
  /**
   * The approval can never be resolved — it is gone (404) or was already
   * decided (409). Retrying cannot help, so the buttons go dead, on the same
   * argument the shell already applies to an ungated approval: a control that
   * cannot keep its promise is worse than an absent one.
   *
   * False for a blip — a 5xx, a 401, a dropped connection — where the affordance
   * must survive so the operator can try again.
   */
  unresolvable: boolean;
}

export interface ApprovalCardProps {
  /** Parsed data-approval-required payload from the stream. */
  approval: DataApproval;
  /** Handler for the "accept" / "approve" decision. */
  onApprove: () => void | Promise<void>;
  /** Handler for the "ignore" / "reject" decision. */
  onReject: () => void | Promise<void>;
  /**
   * Optional handler for the "edit" decision. When omitted, the Edit button
   * is not rendered. Receives the edited arguments as a JSON object.
   */
  onEdit?: (editedInput: Record<string, unknown>) => void | Promise<void>;
  /**
   * Optional handler for the "respond" decision. When omitted, the Respond
   * button is not rendered. Receives the human-authored text reply.
   */
  onRespond?: (response: string) => void | Promise<void>;
  /**
   * When true, all buttons are disabled. Useful while a submission is
   * in-flight or when status !== 'waiting'.
   */
  disabled?: boolean;
  /**
   * Outcome of the last decision submitted for this approval, when it failed.
   * `useApprovalCardController` supplies it per-approval; pass it yourself if
   * you wire handlers by hand. Null/absent is the ordinary case and renders
   * nothing — a successful decision must leave the card exactly as it was.
   */
  decisionFailure?: ApprovalDecisionFailure | null;
  /** Pass-through className for the outer wrapper — consumers style it. */
  className?: string;
}

type CardMode = "actions" | "edit" | "respond";

/**
 * ApprovalCard — a minimal headless-ish UI for the four LangGraph HumanInterrupt
 * decision modes. Renders the approval action name + arguments and exposes
 * approve / reject / (optional) edit / (optional) respond affordances.
 *
 * Styling is opt-in via className, and every part carries `data-slot` so a
 * consumer can reach it. That attribute is the repo convention — 17 components
 * in packages/ui use it — and it exists so STYLING and TESTING do not share an
 * identifier. A consumer styling through `data-testid` makes a test identifier
 * load-bearing for production appearance: rename it and the layout silently
 * collapses, with nothing to catch it, because no type checker can see inside a
 * class string.
 *
 * No opinions about layout, colors, or
 * spacing. Test affordances are exposed via data-testid attributes so
 * consumers can drive interactions without scraping text.
 */
export function ApprovalCard({
  approval,
  onApprove,
  onReject,
  onEdit,
  onRespond,
  disabled = false,
  decisionFailure = null,
  className,
}: ApprovalCardProps): React.JSX.Element {
  const [mode, setMode] = useState<CardMode>("actions");
  const [editText, setEditText] = useState<string>(() =>
    JSON.stringify(approval.arguments, null, 2)
  );
  const [responseText, setResponseText] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);

  const isWaiting = approval.status === "waiting";
  // An unresolvable approval is not interactive however `waiting` the stream
  // still believes it to be — the record behind it is gone.
  const interactive = isWaiting && !disabled && !decisionFailure?.unresolvable;

  /*
   * WHERE A REJECTED DECISION STOPS (#399).
   *
   * The wired handlers reject on a non-2xx — a documented contract, and both
   * shells depend on it, dismissing the card only after the handler resolves.
   * But this card is what invoked them, and it discarded the promise with
   * `void`, so a failed decision became an unhandled rejection: a console
   * warning, which is not a surface. The operator-facing outcome is rendered
   * from `decisionFailure` instead; here the rejection is simply absorbed.
   *
   * A SYNCHRONOUS throw is deliberately NOT caught. That is a consumer bug in
   * the handler itself rather than a decision outcome, and swallowing it would
   * hide it.
   */
  const fire = useCallback((run: () => void | Promise<void>): void => {
    const result = run();
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => {});
    }
  }, []);

  const submitEdit = useCallback(() => {
    if (!onEdit) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editText);
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "edited input is not valid JSON"
      );
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      setEditError("edited input must be a JSON object");
      return;
    }
    setEditError(null);
    fire(() => onEdit(parsed as Record<string, unknown>));
  }, [editText, onEdit, fire]);

  const submitRespond = useCallback(() => {
    if (!onRespond) return;
    if (responseText.length === 0) return;
    fire(() => onRespond(responseText));
  }, [responseText, onRespond, fire]);

  return (
    <div
      data-testid="approval-card"
      data-slot="approval-card"
      data-approval-id={approval.id}
      data-status={approval.status}
      /*
       * THE CARD'S OWN STATE, SEPARATE FROM THE APPROVAL'S (#399). A test that
       * only checks for the presence of an alert node cannot tell a card that
       * went dead from one that merely printed something; this attribute is
       * what makes "the card stopped looking answerable" assertable.
       */
      data-decision={
        decisionFailure
          ? decisionFailure.unresolvable
            ? "unresolvable"
            : "failed"
          : undefined
      }
      className={className}
      role="region"
      aria-label={`Approval required: ${approval.actionName}`}
    >
      <header>
        <span
          data-testid="approval-action-name"
          data-slot="approval-action-name"
        >
          {approval.actionName}
        </span>
        <span data-testid="approval-status" data-slot="approval-status">
          {approval.status}
        </span>
      </header>

      {decisionFailure && (
        <p
          data-testid="approval-decision-error"
          data-slot="approval-decision-error"
          role="alert"
        >
          {decisionFailure.message}
        </p>
      )}

      <p data-testid="approval-description" data-slot="approval-description">
        {approval.description}
      </p>

      <pre data-testid="approval-arguments" data-slot="approval-arguments">
        {JSON.stringify(approval.arguments, null, 2)}
      </pre>

      {mode === "actions" && (
        <div data-testid="approval-actions" data-slot="approval-actions">
          <button
            type="button"
            data-testid="approve-button"
            data-slot="approve-button"
            onClick={() => fire(onApprove)}
            disabled={!interactive}
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="reject-button"
            data-slot="reject-button"
            onClick={() => fire(onReject)}
            disabled={!interactive}
          >
            Reject
          </button>
          {onEdit && (
            <button
              type="button"
              data-testid="show-edit-button"
              onClick={() => setMode("edit")}
              disabled={!interactive}
            >
              Edit
            </button>
          )}
          {onRespond && (
            <button
              type="button"
              data-testid="show-respond-button"
              onClick={() => setMode("respond")}
              disabled={!interactive}
            >
              Respond
            </button>
          )}
        </div>
      )}

      {mode === "edit" && onEdit && (
        <div data-testid="approval-edit-panel" data-slot="approval-edit-panel">
          <label htmlFor={`edit-input-${approval.id}`}>
            Edit arguments (JSON)
          </label>
          <textarea
            id={`edit-input-${approval.id}`}
            data-testid="edit-input"
            value={editText}
            onChange={(e) => {
              setEditText(e.target.value);
              if (editError) setEditError(null);
            }}
            disabled={!interactive}
            rows={6}
          />
          {editError && (
            <p data-testid="edit-error" role="alert">
              {editError}
            </p>
          )}
          <button
            type="button"
            data-testid="submit-edit-button"
            onClick={submitEdit}
            disabled={!interactive}
          >
            Submit edit
          </button>
          <button
            type="button"
            data-testid="cancel-edit-button"
            onClick={() => {
              setEditError(null);
              setEditText(JSON.stringify(approval.arguments, null, 2));
              setMode("actions");
            }}
            disabled={!interactive}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "respond" && onRespond && (
        <div
          data-testid="approval-respond-panel"
          data-slot="approval-respond-panel"
        >
          <label htmlFor={`respond-input-${approval.id}`}>Reply to agent</label>
          <textarea
            id={`respond-input-${approval.id}`}
            data-testid="respond-input"
            value={responseText}
            onChange={(e) => setResponseText(e.target.value)}
            disabled={!interactive}
            rows={3}
          />
          <button
            type="button"
            data-testid="submit-respond-button"
            onClick={submitRespond}
            disabled={!interactive || responseText.length === 0}
          >
            Send reply
          </button>
          <button
            type="button"
            data-testid="cancel-respond-button"
            onClick={() => {
              setResponseText("");
              setMode("actions");
            }}
            disabled={!interactive}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
