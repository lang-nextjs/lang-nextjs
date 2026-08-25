"use client";

import type { DataTesting, DataTestingRun, DataTestingStatus } from "./schemas";

/**
 * TestingCard — renders `data-testing`, rung 5 (software-developer-agent).
 *
 * WHY THIS PART EXISTS, AND THEREFORE WHAT THIS CARD MUST NOT DO:
 *
 * `data-testing` was added instead of reusing `data-todo` for exactly one reason —
 * `data-todo`'s vocabulary is pending | in-progress | done, and "the tests ran and
 * FAILED" is not any of those, nor is "testing was SKIPPED because only docs
 * changed". That distinction is the Testing graph's entire output.
 *
 * So the binding constraint here is that **no two statuses may render identically**.
 * If `failed` and `skipped` look the same on screen, we have paid for a bespoke part
 * and kept the loss it was meant to avoid. Enforced by a test that renders all seven
 * and asserts the visible labels are pairwise distinct — not by discipline.
 *
 * The second constraint is that **no status may render an empty card**, including
 * `"unknown"`. `sdaEnrich.ts` emits `"unknown"` whenever a model sends a status
 * outside the tool's enum, so it is a real value, not a defensive branch. A card that
 * silently renders nothing for a value the producer emits is the same defect as a
 * producer emitting a shape the schema rejects — which happened twice in #12
 * (`title` vs `label`, and a flat object where `TodoSchema` wanted a list). Both
 * produced valid JSON, both failed `safeParse`, and both rendered nothing with
 * nothing red anywhere, because `converter.ts` is fail-open. This is that same seam
 * from the other side.
 */

export interface TestingCardProps {
  testing: DataTesting;
  className?: string;
}

/** Visible, human-readable label per status. MUST be unique across all statuses. */
const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  required: "Testing required",
  in_progress: "Running",
  completed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  unknown: "Unrecognised status",
};

/** Distinct glyph per status, so the state is legible without reading the label. */
const STATUS_ICON: Record<string, string> = {
  not_started: "○",
  required: "!",
  in_progress: "◐",
  completed: "✓",
  failed: "✕",
  skipped: "⊘",
  unknown: "?",
};

/**
 * Coarse severity, used for styling hooks. Deliberately NOT the identity of the
 * status: `failed` and `unknown` share a severity but must never share a label, so
 * anything keying off severity alone would reintroduce the collapse this part exists
 * to prevent.
 */
const STATUS_TONE: Record<string, string> = {
  not_started: "neutral",
  required: "attention",
  in_progress: "active",
  completed: "success",
  failed: "danger",
  skipped: "neutral",
  unknown: "danger",
};

/**
 * TWO DIFFERENT KINDS OF "we don't know this one", kept visibly apart.
 *
 *   "unknown"        — a status this card KNOWS about. sdaEnrich.ts emits it when a
 *                      model sends a value outside the tool's enum. Expected, part
 *                      of the contract, rendered plainly.
 *   anything else    — SCHEMA/UI DRIFT. The schema accepted a status this card was
 *                      never taught. That is a defect somewhere, and it must be
 *                      loud.
 *
 * Collapsing these would recreate the fail-open seam one level up: `converter.ts`
 * drops parts it cannot parse to the console, and a renderer that absorbs
 * unrecognised statuses into a generic chip does the same thing with better manners.
 * Someone should be able to look at a screenshot and see the UI met a status it was
 * never taught, without opening the console.
 *
 * (Raised by ARCHITECT [34d4ad] in review — the card previously gave drift its own
 * label but the same `danger` tone as `failed` and `unknown`, so it read as an
 * ordinary bad outcome rather than as a bug in us.)
 */
function isDrift(status: string): boolean {
  return !(status in STATUS_LABEL);
}

function labelFor(status: string): string {
  // Falls back to the raw value, never to a generic word: a drifted status must be
  // READABLE and must differ from every known one. An "Unknown" fallback here would
  // silently merge it with the real `unknown` state.
  return STATUS_LABEL[status] ?? `Unrecognised by this UI: ${status}`;
}

function iconFor(status: string): string {
  // Distinct from `unknown`'s "?" — drift is our bug, not the agent's.
  return STATUS_ICON[status] ?? "⚠";
}

function toneFor(status: string): string {
  // `drift` is its own tone, NOT `danger`. Sharing danger with `failed` would make a
  // UI defect look like a normal test failure.
  return STATUS_TONE[status] ?? "drift";
}

function StatusBody({
  testing,
}: {
  testing: DataTestingStatus;
}): React.JSX.Element {
  return (
    <>
      <p data-testid="testing-status-label">{labelFor(testing.status)}</p>
      {/* `reason` is always present per the schema but may be an empty string —
          render a stand-in rather than an empty element, so the card never looks
          truncated. */}
      <p data-testid="testing-reason">
        {testing.reason.trim() ? testing.reason : "No reason given"}
      </p>
    </>
  );
}

function RunBody({ testing }: { testing: DataTestingRun }): React.JSX.Element {
  return (
    <>
      <p data-testid="testing-status-label">{labelFor(testing.status)}</p>
      <dl data-testid="testing-run-detail">
        <dt>Command</dt>
        <dd data-testid="testing-run-command">{testing.command}</dd>
        <dt>Test file</dt>
        <dd data-testid="testing-run-file">
          {testing.testFile ?? "All test files"}
        </dd>
        <dt>Browser</dt>
        <dd data-testid="testing-run-browser">
          {testing.browser ?? "Default browser"}
        </dd>
        <dt>Mode</dt>
        <dd data-testid="testing-run-mode">
          {testing.headless ? "Headless" : "Headed"}
        </dd>
      </dl>
    </>
  );
}

export function TestingCard({
  testing,
  className,
}: TestingCardProps): React.JSX.Element {
  const heading = testing.kind === "run" ? "Test run" : "Testing status";

  return (
    <article
      data-testid="testing-card"
      data-testing-id={testing.id}
      data-testing-seq={testing.seq}
      data-testing-kind={testing.kind}
      data-testing-status={testing.status}
      data-testing-tone={toneFor(testing.status)}
      // A machine-readable flag for "this UI met a status it was never taught".
      // Separate from tone so a consumer can alert on drift without parsing labels.
      data-testing-drift={isDrift(testing.status) ? "true" : undefined}
      className={className}
      // The accessible name carries the status too. A screen-reader user must be
      // able to tell failed from skipped without reaching the body.
      aria-label={`${heading}: ${labelFor(testing.status)}`}
    >
      <header>
        <h4 data-testid="testing-heading">{heading}</h4>
        <span data-testid="testing-icon" aria-hidden>
          {iconFor(testing.status)}
        </span>
      </header>
      {testing.kind === "run" ? (
        <RunBody testing={testing} />
      ) : (
        <StatusBody testing={testing} />
      )}
      <time data-testid="testing-updated" dateTime={testing.updatedAt}>
        {testing.updatedAt}
      </time>
    </article>
  );
}
