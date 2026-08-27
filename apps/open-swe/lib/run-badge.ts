import type { Run } from "./types";

export interface RunBadge {
  /** What a person reads on the card. */
  label: string;
  /** Whether this state is asking for a human decision right now. */
  actionable: boolean;
  cls: string;
  dot: string;
}

/**
 * THE WORDS ON A BOARD CARD (#246 follow-up).
 *
 * This lived inside RunListCard.tsx as a private function ending in
 *
 *   return { label: status, cls: <muted>, dot: <muted> };
 *
 * — a fall-through that returned the RAW ENUM VALUE as the label. It was
 * harmless while `Run["status"]` held only four values, three of which were
 * handled explicitly. #246 widened that type to seven, and the fall-through
 * silently became the common case:
 *
 *   pending      -> "pending"       lowercase, where its siblings are "Running"
 *   idle         -> "idle"
 *   unknown      -> "unknown"
 *   interrupted  -> "interrupted"   in muted grey — the "nothing to see" style
 *
 * THE LAST ONE IS THE DEFECT, not the capitalisation. `interrupted` means the
 * run is waiting on a human. The board gives it a column called "Needs
 * approval" precisely because it is the one state a person must act on, and
 * the card inside that column rendered it in the same grey used for states
 * that need nothing from anybody.
 *
 * Widening a type does not update the code that consumes it. This is the
 * consuming half.
 *
 * Extracted so it can be tested: a colour class and a label are exactly the
 * kind of thing a rendering test asserts loosely and a unit test can pin.
 */
export function statusBadge(status: Run["status"]): RunBadge {
  switch (status) {
    case "completed":
      return {
        label: "Completed",
        actionable: false,
        cls: "text-success border-success/20 bg-success/10",
        dot: "bg-success",
      };
    case "failed":
      return {
        label: "Failed",
        actionable: false,
        cls: "text-destructive border-destructive/20 bg-destructive/10",
        dot: "bg-destructive",
      };
    case "running":
      return {
        label: "Running",
        actionable: false,
        cls: "text-info border-info/20 bg-info/10",
        dot: "bg-info animate-pulse",
      };
    case "interrupted":
      // The one a person is meant to ACT on. Named for the decision it is
      // waiting for, not for the platform's word — nobody scanning a board is
      // looking for "interrupted", they are looking for what needs them.
      return {
        label: "Needs approval",
        actionable: true,
        cls: "text-warning border-warning/30 bg-warning/10",
        dot: "bg-warning animate-pulse",
      };
    case "pending":
      return {
        label: "Queued",
        actionable: false,
        cls: "text-muted-foreground border-border/30 bg-muted/30",
        dot: "bg-muted-foreground",
      };
    case "idle":
      // NOT "Completed". #176 and #246 both turned on this: idle means the
      // thread is not executing, which is equally true before a run and after
      // a failure, so it cannot carry a claim of success.
      return {
        label: "Not running",
        actionable: false,
        cls: "text-muted-foreground border-border/30 bg-muted/30",
        dot: "bg-muted-foreground",
      };
    case "unknown":
      return {
        label: "Unknown",
        actionable: false,
        cls: "text-muted-foreground border-border/30 bg-muted/30",
        dot: "bg-muted-foreground",
      };
    default:
      // Exhaustiveness: a new status added to RUN_STATUSES is a COMPILE error
      // here rather than a silent lowercase enum value on a card. That is the
      // whole reason this is a switch and not the if-chain it replaced.
      return assertNever(status);
  }
}

function assertNever(status: never): RunBadge {
  return {
    label: String(status),
    actionable: false,
    cls: "text-muted-foreground border-border/30 bg-muted/30",
    dot: "bg-muted-foreground",
  };
}

/**
 * How long ago a run was created, in words.
 *
 * Extracted from RunListCard for the same reason: it was private, untested,
 * and it renders on every card of the most-visited surface in the app.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  // Clamped at zero: a clock skew between server and browser must not render
  // a run as created in the future ("-3 min ago").
  const diff = Math.max(0, now - then);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}
