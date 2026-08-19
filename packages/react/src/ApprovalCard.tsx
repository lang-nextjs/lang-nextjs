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
  /** Pass-through className for the outer wrapper — consumers style it. */
  className?: string;
}

type CardMode = "actions" | "edit" | "respond";

/**
 * ApprovalCard — a minimal headless-ish UI for the four LangGraph HumanInterrupt
 * decision modes. Renders the approval action name + arguments and exposes
 * approve / reject / (optional) edit / (optional) respond affordances.
 *
 * Styling is opt-in via className — no opinions about layout, colors, or
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
  className,
}: ApprovalCardProps): React.JSX.Element {
  const [mode, setMode] = useState<CardMode>("actions");
  const [editText, setEditText] = useState<string>(() =>
    JSON.stringify(approval.arguments, null, 2)
  );
  const [responseText, setResponseText] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);

  const isWaiting = approval.status === "waiting";
  const interactive = isWaiting && !disabled;

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
    void onEdit(parsed as Record<string, unknown>);
  }, [editText, onEdit]);

  const submitRespond = useCallback(() => {
    if (!onRespond) return;
    if (responseText.length === 0) return;
    void onRespond(responseText);
  }, [responseText, onRespond]);

  return (
    <div
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-status={approval.status}
      className={className}
      role="region"
      aria-label={`Approval required: ${approval.actionName}`}
    >
      <header>
        <span data-testid="approval-action-name">{approval.actionName}</span>
        <span data-testid="approval-status">{approval.status}</span>
      </header>

      <p data-testid="approval-description">{approval.description}</p>

      <pre data-testid="approval-arguments">
        {JSON.stringify(approval.arguments, null, 2)}
      </pre>

      {mode === "actions" && (
        <div data-testid="approval-actions">
          <button
            type="button"
            data-testid="approve-button"
            onClick={() => void onApprove()}
            disabled={!interactive}
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="reject-button"
            onClick={() => void onReject()}
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
        <div data-testid="approval-edit-panel">
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
        <div data-testid="approval-respond-panel">
          <label htmlFor={`respond-input-${approval.id}`}>
            Reply to agent
          </label>
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
