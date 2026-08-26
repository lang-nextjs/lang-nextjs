/**
 * WHERE THE TRANSCRIPT CHANGED HANDS.
 *
 * Switching framework, runtime or mode mid-conversation is allowed and useful —
 * comparing how two rungs answer the same question is the point of a ladder,
 * and forcing a new conversation to do it throws away the context that makes
 * the comparison meaningful. What was missing is that the record did not show
 * it: a transcript answered by two different agents read as one continuous
 * conversation.
 *
 * A BOUNDARY, NOT A PER-MESSAGE BADGE. A badge repeated across twenty messages
 * is noise that people stop reading; a boundary appears exactly as often as
 * something actually changed, which is the definition of information here.
 *
 * PURE ON PURPOSE. The rule is small and the ways to get it wrong are specific
 * — a separator before the first message, two in a row, one that fires when
 * nothing changed — and none of them are convenient to provoke through a
 * browser. This is where the rule lives so those cases can be cheap.
 */

/** The coordinates a message was answered under. */
export interface Cell {
  framework: string;
  runtime: string;
  topology: string;
}

/** Stable identity for a cell, used to decide whether two messages differ. */
export function cellKey(cell: Cell): string {
  return `${cell.framework}|${cell.runtime}|${cell.topology}`;
}

/**
 * What changed between two cells, in the order a reader cares about.
 *
 * Returns the changed axes only. A switch that changes two axes at once should
 * say so rather than naming one and implying the other stayed put.
 */
export function changedAxes(from: Cell, to: Cell): string[] {
  const out: string[] = [];
  if (from.framework !== to.framework) out.push(to.framework);
  if (from.runtime !== to.runtime) out.push(to.runtime);
  if (from.topology !== to.topology) out.push(to.topology);
  return out;
}

/** Human-readable summary of a switch, for the separator itself. */
export function describeSwitch(from: Cell, to: Cell): string {
  const changed = changedAxes(from, to);
  return changed.length ? `switched to ${changed.join(" · ")}` : "";
}

export interface Boundary {
  /** Index in the message list that this separator sits BEFORE. */
  index: number;
  from: Cell;
  to: Cell;
  label: string;
}

/**
 * The indices at which the answering cell changed.
 *
 * `cells[i]` is the cell message `i` was answered under. A message with no
 * recorded cell — anything that predates this feature, or a user message the
 * app did not tag — is SKIPPED rather than treated as a change. Treating an
 * absent cell as different would put a separator in front of every untagged
 * message, which is the failure mode that makes a feature like this get turned
 * off rather than fixed.
 *
 * NEVER BEFORE THE FIRST TAGGED MESSAGE. There is nothing to have switched
 * from, and a separator there reads as though the conversation began by
 * changing something.
 */
export function boundariesFor(cells: Array<Cell | undefined>): Boundary[] {
  const out: Boundary[] = [];
  let previous: Cell | undefined;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) continue;
    if (previous && cellKey(previous) !== cellKey(cell)) {
      out.push({
        index: i,
        from: previous,
        to: cell,
        label: describeSwitch(previous, cell),
      });
    }
    previous = cell;
  }
  return out;
}
