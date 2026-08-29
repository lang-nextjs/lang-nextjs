/**
 * Where the transcript changed hands (#253).
 *
 * You can switch framework, runtime or mode at any point in a chat and the
 * history persists unchanged, so a transcript answered by two different agents
 * reads as one continuous conversation. Forbidding the switch is the wrong fix:
 * comparing how rungs answer the SAME question is the point of a ladder, and
 * starting a new chat to do it discards the context that makes the comparison
 * mean anything. The switch is fine. The record not showing it is not.
 *
 * A BOUNDARY, NOT A BADGE. A per-message label repeated down twenty messages is
 * noise that the eye stops reading; a separator appears exactly as often as
 * something actually changed, which is what makes it information.
 *
 * The first cell produces NO boundary. There is nothing to have switched from,
 * and emitting one there would turn the marker into a header — present always,
 * therefore meaning nothing. That is the same failure this whole feature exists
 * to avoid.
 */

/** The identity of the agent that produced a message: runtime × framework × mode. */
export interface Cell {
  runtime: string;
  framework: string;
  topology: string;
}

export interface BoundaryInput {
  /** Message id, used as the React key of the separator that precedes it. */
  id: string;
  /**
   * The cell that produced this message, or undefined for messages no agent
   * produced — a user's own turn, a card the client rendered. Those must not
   * open or close a section: a user message between two assistant turns from
   * the same cell has changed nothing.
   */
  cell?: Cell;
}

export interface Boundary {
  /** Insert the separator immediately BEFORE the message with this id. */
  beforeMessageId: string;
  from: Cell;
  to: Cell;
  /** "switched to fastapi · deepagents · react" */
  label: string;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return (
    a.runtime === b.runtime &&
    a.framework === b.framework &&
    a.topology === b.topology
  );
}

export function describeCell(c: Cell): string {
  return `${c.runtime} · ${c.framework} · ${c.topology}`;
}

/**
 * Boundaries for a transcript, in order.
 *
 * Switching away and back produces TWO boundaries, not zero. The second return
 * is a real event in the conversation — the reader needs to know which agent
 * answered which turn, and "it is the same cell as earlier" does not tell them
 * where the run resumed.
 */
export function conversationBoundaries(messages: BoundaryInput[]): Boundary[] {
  const out: Boundary[] = [];
  let current: Cell | undefined;

  for (const m of messages) {
    if (!m.cell) continue; // produced by no agent — cannot be a change
    if (current === undefined) {
      current = m.cell; // the opening cell: nothing to have switched from
      continue;
    }
    if (!sameCell(current, m.cell)) {
      out.push({
        beforeMessageId: m.id,
        from: current,
        to: m.cell,
        label: `switched to ${describeCell(m.cell)}`,
      });
      current = m.cell;
    }
  }

  return out;
}
