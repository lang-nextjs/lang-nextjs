"use client";

import { useState } from "react";
import { ToolCallState } from "../lib/types";

interface ToolCardProps {
  tool: ToolCallState;
}

export function ToolCard({ tool }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div data-testid="tool-card" data-tool-call-id={tool.toolCallId}>
      <div>
        <span data-testid="tool-name">{tool.toolName}</span>
        <span data-testid="tool-status">{tool.status}</span>
        {tool.status === "completed" && (
          <button
            data-testid="expand-toggle"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>

      {expanded && tool.status === "completed" && (
        <div data-testid="tool-payload">
          <div>
            <strong>Input</strong>
            <pre data-testid="tool-input">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          </div>
          <div>
            <strong>Output</strong>
            <pre data-testid="tool-output">
              {JSON.stringify(tool.output, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
