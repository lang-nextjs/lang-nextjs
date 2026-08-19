"use client";

import type { DataHumanResponse } from "./schemas";

export interface HumanResponseCardProps {
  /** Parsed data-human-response payload from the stream. */
  response: DataHumanResponse;
  /** Pass-through className for the outer wrapper. */
  className?: string;
}

/**
 * HumanResponseCard — UI for the data-human-response frame the approval
 * transform emits when the human picks "respond" instead of approving the
 * tool. Carries the text reply that the consumer (UI / upstream agent loop)
 * typically forwards back to the LLM as a new user message.
 *
 * No opinionated styling — className passthrough and semantic HTML.
 */
export function HumanResponseCard({
  response,
  className,
}: HumanResponseCardProps): React.JSX.Element {
  return (
    <article
      data-testid="human-response-card"
      data-human-response-id={response.id}
      data-human-response-seq={response.seq}
      className={className}
      role="note"
      aria-label="Human response to approval"
    >
      <header>
        <span data-testid="human-response-label">You replied</span>
        <time
          data-testid="human-response-created-at"
          dateTime={response.createdAt}
        >
          {response.createdAt}
        </time>
      </header>
      <blockquote data-testid="human-response-text" cite={response.id}>
        {response.response}
      </blockquote>
    </article>
  );
}
