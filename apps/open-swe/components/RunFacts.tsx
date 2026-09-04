"use client";

import { useState } from "react";
import { runFacts } from "../lib/run-identity";

export interface RunFactsProps {
  runId: string;
  threadId: string;
  status?: string;
  agentMode?: string;
  agentReason?: string;
}

/**
 * The identifiers for this run, stated in full and copyable.
 *
 * RENDERED OUTSIDE `{task && …}`, unlike the line it replaces. A run whose
 * task failed to load showed no identifiers at all — and that is precisely the
 * run whose id you need in order to go and ask what happened to it.
 */
export function RunFacts({
  runId,
  threadId,
  status,
  agentMode,
  agentReason,
}: RunFactsProps): React.JSX.Element | null {
  const [copied, setCopied] = useState<string | null>(null);
  const facts = runFacts({ runId, threadId, status, agentMode, agentReason });
  if (facts.length === 0) return null;

  return (
    /*
     * AN INLINE STRIP, NOT A CARD (#711). This used to be a bordered,
     * background-filled grid at `sm:grid-cols-[auto_1fr]` — roughly 900px of
     * empty row per fact inside a max-w-5xl container, to carry `run-1` and
     * `th-1`. It made the metadata the heaviest-looking element on a page whose
     * point is the answer below it. Same values, same copy affordance, same
     * full-id-in-DOM guarantee; about a quarter of the height.
     */
    <dl
      data-testid="run-facts"
      className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[11px]"
    >
      {facts.map((f) => (
        <div key={f.label} className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-muted-foreground shrink-0 font-medium tracking-wide uppercase">
            {f.label}
          </dt>
          <dd
            data-testid={`run-fact-${f.label.toLowerCase()}`}
            /*
             * THE FULL VALUE IS ALWAYS IN THE DOM, even when the visible text
             * is abbreviated. A person selecting the row, a screen reader, and
             * a test all get the real id; only the pixels are shortened.
             */
            data-value={f.value}
            title={f.truncated ? f.value : undefined}
            className="text-foreground min-w-0 font-mono break-all"
          >
            <button
              type="button"
              data-testid={`copy-${f.label.toLowerCase()}`}
              onClick={() => {
                // Best-effort: clipboard access is denied in some contexts and
                // a rejected promise must not take the page down. The value is
                // selectable either way, which is why this is an enhancement
                // and not the only route to it.
                void navigator.clipboard
                  ?.writeText(f.value)
                  .then(() => {
                    setCopied(f.label);
                    setTimeout(() => setCopied(null), 1200);
                  })
                  .catch(() => {});
              }}
              className="hover:text-foreground/70 cursor-pointer text-left"
              aria-label={`Copy ${f.label}: ${f.value}`}
            >
              {f.display}
              {copied === f.label && (
                <span className="text-success ml-2 font-sans not-italic">
                  copied
                </span>
              )}
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}
