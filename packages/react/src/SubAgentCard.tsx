"use client";

import { useState } from "react";
import type { DataSubAgent } from "./schemas";

export interface SubAgentCardProps {
  /** Parsed data-sub-agent payload from the stream. */
  subAgent: DataSubAgent;
  /** Pass-through className for the outer wrapper. */
  className?: string;
  /**
   * When false, never render the prompt/result body. Default true — clicking
   * the toggle expands the body.
   */
  allowExpand?: boolean;
}

function statusLabel(status: DataSubAgent["status"]): string {
  return status;
}

function tryParseJson(
  text: string
): { parsed: unknown; isJson: true } | { isJson: false } {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return { parsed: JSON.parse(trimmed), isJson: true };
    } catch {
      return { isJson: false };
    }
  }
  return { isJson: false };
}

export function SubAgentCard({
  subAgent,
  className,
  allowExpand = true,
}: SubAgentCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [showError, setShowError] = useState(false);

  const hasResult =
    typeof subAgent.result === "string" && subAgent.result.length > 0;
  const hasError =
    typeof subAgent.error === "string" && subAgent.error.length > 0;

  const resultType = hasResult ? tryParseJson(subAgent.result!) : null;

  return (
    <article
      data-testid="sub-agent-card"
      data-sub-agent-id={subAgent.id}
      data-sub-agent-seq={subAgent.seq}
      data-sub-agent-status={subAgent.status}
      data-parent-tool-call-id={subAgent.parentToolCallId}
      className={className}
      aria-label={`Sub-agent: ${subAgent.name}`}
    >
      <header>
        <span data-testid="sub-agent-name">{subAgent.name}</span>
        <span data-testid="sub-agent-status">
          {statusLabel(subAgent.status)}
        </span>
        <time data-testid="sub-agent-started-at" dateTime={subAgent.startedAt}>
          {subAgent.startedAt}
        </time>
        {subAgent.finishedAt ? (
          <time
            data-testid="sub-agent-finished-at"
            dateTime={subAgent.finishedAt}
          >
            {subAgent.finishedAt}
          </time>
        ) : null}
      </header>

      {allowExpand ? (
        <button
          type="button"
          data-testid="sub-agent-expand-button"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      ) : null}

      {allowExpand && expanded ? (
        <div data-testid="sub-agent-details">
          <button
            type="button"
            data-testid="sub-agent-prompt-toggle"
            onClick={() => setShowPrompt((p) => !p)}
          >
            {showPrompt ? "Hide prompt" : "Show prompt"}
          </button>
          {showPrompt ? (
            <section data-testid="sub-agent-prompt-section">
              <h5>Prompt</h5>
              <pre data-testid="sub-agent-prompt">{subAgent.prompt}</pre>
            </section>
          ) : null}

          {hasResult ? (
            <>
              <button
                type="button"
                data-testid="sub-agent-output-toggle"
                onClick={() => setShowOutput((p) => !p)}
              >
                {showOutput ? "Hide output" : "Show output"}
              </button>
              {showOutput ? (
                <section data-testid="sub-agent-result-section">
                  <h5>Output</h5>
                  <span
                    data-testid="sub-agent-result-type"
                    data-value={resultType?.isJson ? "json" : "text"}
                  >
                    {resultType?.isJson ? "json" : "text"}
                  </span>
                  {resultType?.isJson ? (
                    <pre data-testid="sub-agent-result-json">
                      {JSON.stringify(resultType.parsed, null, 2)}
                    </pre>
                  ) : (
                    <pre data-testid="sub-agent-result">{subAgent.result}</pre>
                  )}
                </section>
              ) : null}
            </>
          ) : null}

          {hasError ? (
            <>
              <button
                type="button"
                data-testid="sub-agent-error-toggle"
                onClick={() => setShowError((p) => !p)}
              >
                {showError ? "Hide error" : "Show error"}
              </button>
              {showError ? (
                <section data-testid="sub-agent-error-section" role="alert">
                  <h5>Error</h5>
                  <pre data-testid="sub-agent-error">{subAgent.error}</pre>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
