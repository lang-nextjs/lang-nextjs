import type { ActionFunctionArgs } from "@remix-run/node";
import type { SseFrame, SseTransform } from "./accumulator";

export type { SseFrame, SseTransform };

export interface SseAdapter {
  name: string;
  transforms: SseTransform[];
}

export interface RemixHandlerOptions {
  backendUrl: string;
  adapter?: SseAdapter;
  transforms?: SseTransform[];
  getToken?: (
    args: ActionFunctionArgs
  ) => Promise<string | null | undefined> | string | null | undefined;
  /**
   * Maximum request body size in bytes. Requests above this limit are
   * rejected with HTTP 413 before the body is fully read into memory —
   * a DoS guard against unbounded payloads.
   *
   * - Number > 0: enforce this limit
   * - 0 or negative: disable the guard (consumer accepts unbounded bodies)
   * - Omitted: default to 1MB (1_048_576 bytes), matching the open-swe
   *   app's body-parser and typical chat-message payload sizes.
   *
   * @default 1_048_576 (1 MB)
   */
  maxBodyBytes?: number;
}

export interface DeepAgentsState {
  messages: unknown[];
  status: "idle" | "loading" | "streaming" | "done" | "error";
  error: Error | null;
}

/** Return type of useDeepAgentsChat — exported so consumers can type their props */
export type DeepAgentsChatResult = DeepAgentsState & { start: () => void };
