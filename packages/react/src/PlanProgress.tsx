"use client";

export interface PlanProgressProps {
  doneCount: number;
  totalCount: number;
  className?: string;
}

export function PlanProgress({
  doneCount,
  totalCount,
  className,
}: PlanProgressProps): React.JSX.Element {
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div
      data-testid="plan-progress"
      className={className}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span data-testid="plan-progress-text">
        Step {doneCount} of {totalCount}
      </span>
      <div data-testid="plan-progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}
