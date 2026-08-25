"use client";

import { toneClass, toneFor } from "../lib/integration-status";
import { toneForReadiness } from "../lib/readiness";
import { useIntegrationReadiness } from "../lib/use-integration-readiness";

/**
 * The compact readiness + integration strip, for surfaces that were showing nothing.
 *
 * WHY THE QUEUE NEEDS IT MOST. Readiness lived on `/chat` only, and `/` is the surface that
 * RUNS CODE — so `sandboxRequired` finally means something there. A queue that accepts work
 * it cannot execute is the failure this is for.
 *
 * NOTHING DEFAULTS TO GREEN. Every dot's colour comes from `toneClass(toneFor(...))`, both
 * exhaustive with `assertNever`, so a new state fails to compile rather than inheriting a
 * healthy tone. The mapping this replaces ended `: "bg-success"` and was safe only because
 * its union happened to be closed.
 *
 * `configured` AND `tracing` ARE RENDERED SEPARATELY AND NEVER COLLAPSED. Keys being present
 * is inference; a span being accepted is observation. Showing the first as a tick is what
 * PRODUCT calls laundering inference as observation, and it is live today: the backend
 * computes LangSmith's `tracing` from the same expression as its `configured`.
 */
export function ReadinessStrip({
  sandboxRequired,
  streamStatus = "idle",
}: {
  sandboxRequired: boolean;
  streamStatus?: string;
}) {
  const { readiness, integrations, observabilitySource, unreachable } =
    useIntegrationReadiness({ sandboxRequired, streamStatus });

  return (
    <div
      data-testid="readiness-strip"
      data-readiness={readiness.state}
      className="border-border bg-card/40 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border px-3 py-2 text-xs"
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${toneClass(toneForReadiness(readiness.state))}`}
        />
        <span className="text-foreground font-medium">{readiness.label}</span>
      </span>

      {/* Every unmet prerequisite, not just the first — fixing one at a time is slow, and
          `computeReadiness` already collects them all. */}
      {readiness.reasons.length > 0 && (
        <span data-testid="readiness-reasons" className="text-muted-foreground">
          {readiness.reasons.join(" · ")}
        </span>
      )}

      {integrations.map(({ name, status }) => (
        <span
          key={name}
          data-testid={`integration-${name}`}
          data-state={status.state}
          title={status.detail}
          className="flex items-center gap-1.5"
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${toneClass(toneFor(status.state))}`}
          />
          <span className="text-muted-foreground">
            {name}: {status.label}
          </span>
        </span>
      ))}

      {/* Which process answered. A local-env answer can only ever report `configured`, so
          saying so is what stops "unverified" being read as "the backend said no". */}
      {observabilitySource === "local-env" && (
        <span data-testid="observability-source" className="text-warning">
          backend unreachable — showing local env inference
        </span>
      )}

      {unreachable && (
        <span data-testid="readiness-unreachable" className="text-warning">
          {unreachable}
        </span>
      )}
    </div>
  );
}
