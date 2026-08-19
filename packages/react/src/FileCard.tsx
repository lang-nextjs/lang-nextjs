"use client";

import { useState } from "react";
import type { DataFile } from "./schemas";

export interface FileCardProps {
  /** Parsed data-file payload from the stream. */
  file: DataFile;
  /** Pass-through className for the outer wrapper. */
  className?: string;
  /**
   * When false, never render the file body. Default true — clicking the
   * "Show contents" button toggles the body visibility.
   */
  allowExpand?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * FileCard — minimal UI for DeepAgents' virtual filesystem artifact.
 *
 * Renders the file's path, size, language hint (if any), and a truncation
 * flag. Content is hidden behind an expand button and rendered as preformatted
 * text — the consumer can wrap with a syntax highlighter if desired.
 */
export function FileCard({
  file,
  className,
  allowExpand = true,
}: FileCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasContent = typeof file.content === "string" && file.content.length > 0;

  return (
    <article
      data-testid="file-card"
      data-file-id={file.id}
      data-file-seq={file.seq}
      data-file-truncated={file.truncated ? "true" : "false"}
      className={className}
      aria-label={`File: ${file.path}`}
    >
      <header>
        <span data-testid="file-name">{file.name}</span>
        <span data-testid="file-path">{file.path}</span>
        <span data-testid="file-size">{formatBytes(file.size)}</span>
        {file.language ? (
          <span data-testid="file-language">{file.language}</span>
        ) : null}
        {file.truncated ? (
          <span data-testid="file-truncated-flag" role="note">
            truncated
          </span>
        ) : null}
        <time data-testid="file-updated-at" dateTime={file.updatedAt}>
          {file.updatedAt}
        </time>
      </header>

      {allowExpand && hasContent ? (
        <button
          type="button"
          data-testid="file-expand-button"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide contents" : "Show contents"}
        </button>
      ) : null}

      {allowExpand && expanded && hasContent ? (
        <pre data-testid="file-content">{file.content}</pre>
      ) : null}
    </article>
  );
}
