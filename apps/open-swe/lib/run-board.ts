import type { Run } from "./types";

/**
 * Grouping for the queue board.
 *
 * WHY A MODULE AND NOT A `.filter()` IN THE PAGE. The interesting behaviour is
 * not the columns, it is what happens to a run whose status is none of them —
 * and that is exactly the case a JSX filter chain gets wrong silently. A board
 * that renders four columns and quietly omits a fifth status shows you a queue
 * with work missing from it, which is worse than showing no board.
 *
 * THE STATUS SETS DO NOT MATCH, AND THAT IS THE POINT.
 *   Run.status         pending | running | completed | failed
 *   ThreadRunStatus    pending | running | completed | failed | interrupted
 *
 * The list endpoint types out four; the thread state types five. `interrupted`
 * is HITL — blocked on a human rather than on the agent — and it is the one
 * column a person is meant to act on. It gets a column here even though the
 * list endpoint does not currently report it, because the column being empty
 * is a true statement, whereas having no column would silently reroute those
 * runs into "in progress" the day the endpoint does report it.
 */
export type BoardColumnId =
  | "backlog"
  | "in-progress"
  | "needs-approval"
  | "done"
  | "errored"
  | "other";

export interface BoardColumn {
  id: BoardColumnId;
  label: string;
  /** Statuses that land here. `other` declares none — it is the catch-all. */
  statuses: readonly string[];
  runs: Run[];
  /** `other` is hidden when empty; the five real columns always render. */
  hideWhenEmpty: boolean;
}

const COLUMNS: readonly Omit<BoardColumn, "runs">[] = [
  {
    id: "backlog",
    label: "Backlog",
    statuses: ["pending"],
    hideWhenEmpty: false,
  },
  {
    id: "in-progress",
    label: "In progress",
    statuses: ["running"],
    hideWhenEmpty: false,
  },
  {
    id: "needs-approval",
    label: "Needs approval",
    statuses: ["interrupted"],
    hideWhenEmpty: false,
  },
  { id: "done", label: "Done", statuses: ["completed"], hideWhenEmpty: false },
  {
    id: "errored",
    label: "Errored",
    statuses: ["failed"],
    hideWhenEmpty: false,
  },
  {
    // Nothing routes here by name. It exists so an unrecognised status is
    // VISIBLE rather than dropped — a backend that grows a state should make
    // this column appear, not make runs disappear.
    id: "other",
    label: "Other",
    statuses: [],
    hideWhenEmpty: true,
  },
];

/** Newest first, and stable: equal timestamps keep their input order. */
function byNewest(a: Run, b: Run): number {
  const ta = Date.parse(a.created_at ?? "");
  const tb = Date.parse(b.created_at ?? "");
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1; // unparseable timestamps sink, never vanish
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

export function groupRuns(runs: readonly Run[]): BoardColumn[] {
  const byStatus = new Map<string, Run[]>();
  for (const col of COLUMNS) for (const s of col.statuses) byStatus.set(s, []);

  const other: Run[] = [];
  for (const run of runs) {
    const bucket = byStatus.get(String(run.status));
    if (bucket) bucket.push(run);
    else other.push(run);
  }

  return COLUMNS.map((col) => ({
    ...col,
    runs: (col.id === "other"
      ? other
      : col.statuses.flatMap((s) => byStatus.get(s) ?? [])
    ).sort(byNewest),
  }));
}

/** Every run appears exactly once. The board must not lose work. */
export function totalIn(columns: readonly BoardColumn[]): number {
  return columns.reduce((n, c) => n + c.runs.length, 0);
}
