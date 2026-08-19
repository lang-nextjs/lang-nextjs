import type { SseTransform } from "./accumulator";

/**
 * Adapter bundle — identical shape to SvelteKit/Remix adapters.
 */
export interface SseAdapter {
  transforms: SseTransform[];
}

/**
 * Shared options for all edge handlers.
 */
export interface EdgeHandlerOptions {
  /** URL of the DeepAgents backend to proxy. */
  backendUrl: string;
  /** Optional adapter bundle (e.g. deepagentsAdapter, langGraphAdapter). */
  adapter?: SseAdapter;
  /** Additional transform functions applied after adapter.transforms. */
  transforms?: SseTransform[];
  /** Optional token getter. Returns string for Bearer injection, null/undefined to skip. */
  getToken?: (
    request: Request
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Maximum allowed request body size in bytes. Requests exceeding this cap are
   * rejected with HTTP 413 before the body is fully read into memory. 0 / negative
   * disables the guard. Default matches the server-side cap: 1_048_576 (1 MB).
   */
  maxBodyBytes?: number;
}

/**
 * Options for createDenoHandler.
 * Handler signature: (request: Request) => Promise<Response>
 * Suitable for Deno.serve({ port }, handler).
 */
export interface DenoHandlerOptions extends EdgeHandlerOptions {}

/**
 * Options for createCloudflareHandler.
 * env is Record<string, unknown> (portable — not bound to wrangler.toml Env type).
 * Consumer extracts backendUrl from env before calling the factory.
 *
 * @experimental Cloudflare Workers SSE buffering causes TTFB > 10s in production.
 * Use Deno Deploy as the primary edge target. See README for details.
 */
export interface CloudflareHandlerOptions extends EdgeHandlerOptions {
  /** Cloudflare bindings env object — flexible typing for portability. */
  env?: Record<string, unknown>;
  /** Maximum total stream duration in milliseconds. When exceeded, the handler aborts the backend connection and returns 504 (pre-stream) or errors the stream (mid-stream). Defaults to undefined (no timeout). Recommended: keep below the Cloudflare Worker CPU limit — 30s on the free tier. */
  streamTimeoutMs?: number;
}
