"use client";

import { useState } from "react";
import type { DataAgentsMd } from "./schemas";

export interface AgentsMdCardProps {
  agentsMd: DataAgentsMd;
  className?: string;
  allowExpand?: boolean;
}

/**
 * AgentsMdCard — minimal UI for the data-agents-md part.
 *
 * DECLARED, NO PRODUCER (issue #50). Nothing in this repository emits a
 * `data-agents-md` frame — not the Python backends, not the adapters, not the
 * transforms. The only code that constructs one is test fixtures, so this
 * component's tests prove it renders a well-formed part correctly and prove
 * nothing about the part being reachable in a live stream.
 *
 * The part stays declared in `docs/sse-frame-schema.json` on purpose: it is a
 * published contract a consumer may already build against, and deleting it
 * would silently narrow a schema this repo publishes. If you are forking and
 * this card never renders, that is EXPECTED — it is not a bug in your fork.
 * A producer is tracked as follow-up work.
 */
export function AgentsMdCard({
  agentsMd,
  className,
  allowExpand = true,
}: AgentsMdCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <article
      data-testid="agents-md-card"
      data-agents-md-id={agentsMd.id}
      data-agents-md-seq={agentsMd.seq}
      className={className}
      aria-label={`AGENTS.md: ${agentsMd.path}`}
    >
      <header>
        <span data-testid="agents-md-path">{agentsMd.path}</span>
      </header>
      {allowExpand ? (
        <button
          type="button"
          data-testid="agents-md-expand-button"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide content" : "Show content"}
        </button>
      ) : null}
      {allowExpand && expanded ? (
        <pre data-testid="agents-md-content">{agentsMd.content}</pre>
      ) : null}
    </article>
  );
}
