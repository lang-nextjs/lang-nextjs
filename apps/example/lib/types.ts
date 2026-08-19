export interface Run {
  run_id: string;
  status: "pending" | "running" | "completed" | "failed";
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
  | { type: "tool-output-available"; toolCallId: string; output: unknown };

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
  | "error"
  | "done";
