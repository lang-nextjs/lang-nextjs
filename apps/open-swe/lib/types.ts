/**
 * THE BOARD'S STATUS VOCABULARY, AS A VALUE (#246).
 *
 * Declared as a const array with the type derived from it, rather than as a
 * bare union, for one reason: a union exists only at compile time, so a test
 * that wants to assert "the board can express everything the thread can" has
 * nothing to read and must hand-copy the list. A hand-copied list agrees with
 * whatever it was copied from and cannot fail — the check would name the
 * property and be incapable of detecting its loss. Importing this array makes
 * a later narrowing of the vocabulary break the test that says it must not.
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "idle",
  "unknown",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  run_id: string;
  /** Thread the run belongs to — required to open the run's SSE stream. */
  thread_id?: string;
  /**
   * WIDENED TO MATCH WHAT THE THREAD CAN ACTUALLY REPORT (#246).
   *
   * This was pending | running | completed | failed, and the thread reports
   * three more: interrupted, idle, unknown. The mapper therefore had nowhere to
   * put them and was FORCED to invent an answer for every one:
   *
   *   interrupted -> running     waiting on a human, filed as work in progress
   *   idle        -> completed   stopped, claimed as succeeded
   *   unknown     -> completed   never seen, claimed as succeeded
   *
   * Seventeen runs sat on a live board as "Running", some a day old, every one
   * of their threads idle. Patching the mapper alone could not fix it: there was
   * no correct value for it to return.
   *
   * It also explains a comment in run-board.ts that nobody could act on — the
   * `needs-approval` column declares `statuses: ["interrupted"]` "even though
   * the list endpoint does not currently report it". This type is why it did
   * not. The one state a person is meant to act on was the one the board could
   * not express.
   */
  status: RunStatus;
  created_at: string; // ISO 8601
  task: string;
}

export interface CreateRunRequest {
  task: string;
}

export class PlatformError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

// Stream event types — emitted by GET /api/open-swe/runs/[runId]/stream
export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  // DeepAgents `data-*` parts emitted by openSweAdapter (plan/file/sub-agent/
  // approval/…). Envelope shape: { type: "data-*", data: {...} }. Parsed and
  // validated downstream via parseDataPart from @deepagents-nextjs/react.
  | { type: `data-${string}`; data: Record<string, unknown> };

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  status: "pending" | "completed";
}

export type RunStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "cancelling"
  | "error"
  | "done";
