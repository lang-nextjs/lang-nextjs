import type { RequestEvent } from "@sveltejs/kit";
import type { SseFrame, SseTransform } from "./accumulator";

export type { SseFrame, SseTransform };

export interface SseAdapter {
  name: string;
  transforms: SseTransform[];
}

export interface SvelteKitHandlerOptions {
  backendUrl: string;
  adapter?: SseAdapter;
  transforms?: SseTransform[];
  getToken?: (
    event: RequestEvent
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Maximum request body size in bytes. Requests above this limit are
   * rejected with HTTP 413 before the body is fully read into memory —
   * a DoS guard against unbounded payloads.
   *
   * - Number > 0: enforce this limit
   * - 0 or negative: disable the guard (consumer accepts unbounded bodies)
   * - Omitted: default to 1MB (1_048_576 bytes), matching the server/remix
   *   handler defaults.
   *
   * The guard fires in two places:
   *   1. Early reject when the client sends a Content-Length header
   *      exceeding the limit (saves bandwidth on the upload).
   *   2. Belt-and-braces re-check after the body is buffered (catches
   *      clients that omit or understate Content-Length on streamed bodies).
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
