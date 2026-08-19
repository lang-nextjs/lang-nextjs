"use client";

import { useState } from "react";
import type { DataAgentsMd } from "./schemas";

export interface AgentsMdCardProps {
  agentsMd: DataAgentsMd;
  className?: string;
  allowExpand?: boolean;
}

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
