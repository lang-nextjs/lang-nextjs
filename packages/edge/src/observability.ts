// Copied from @deepagents-nextjs/server — avoids cross-package dep that would pull in Next.js
//
// SOURCE OF TRUTH: packages/server/src/observability.ts. This is a verbatim copy
// of the type definitions; keep all copies (sveltekit/remix/edge) in sync when
// the source changes.

/**
 * Vendor-neutral observability hooks for the DeepAgents SSE handler (OBS-01..03).
 *
 * SECURITY (OBS-03): context objects carry ONLY safe scalar fields — no raw
 * request/response objects, headers, tokens, cookies, or bodies. SAFETY
 * (OBS-02): callbacks must not throw; invocations are wrapped in try-catch and a
 * throwing/rejecting callback never interrupts the SSE stream.
 */

/** Context for `onRequest` — fired once a request is accepted, before fetch. */
export interface OnRequestContext {
  sessionId: string;
  backendUrl: string;
  timestamp: number;
}

/** Context for `onFetchStart` — fired immediately before the upstream fetch. */
export interface OnFetchStartContext {
  backendUrl: string;
  timeoutMs?: number;
  timestamp: number;
}

/**
 * Context for `onFetchEnd` — fired after the upstream fetch resolves or fails.
 * On the failure path `error` is set and `status` is omitted.
 */
export interface OnFetchEndContext {
  backendUrl: string;
  status?: number;
  bytesReceived: number;
  durationMs: number;
  error?: Error;
  timestamp: number;
}

/** Context for `onStreamStart` — fired once the upstream body is confirmed. */
export interface OnStreamStartContext {
  backendUrl: string;
  status: number;
  timestamp: number;
}

/** Context for `onTransformBegin` — fired before a frame enters the pipeline. */
export interface OnTransformBeginContext {
  frameIndex: number;
  frameBytes: number;
  timestamp: number;
}

/** Context for `onTransformEnd` — fired after a frame leaves the pipeline. */
export interface OnTransformEndContext {
  frameIndex: number;
  dropped: boolean;
  outputCount: number;
  durationMs: number;
  timestamp: number;
}

/** Context for `onError` — fired on any lifecycle failure path. */
export interface OnErrorContext {
  type: "fetch" | "stream" | "transform" | "rate-limit" | "circuit-breaker";
  error: Error;
  durationMs: number;
  frameIndex?: number;
  sessionId: string;
  timestamp: number;
}

/** Context for `onStreamEnd` — fired once in the stream loop's finally block. */
export interface OnStreamEndContext {
  success: boolean;
  frameCount: number;
  byteCount: number;
  durationMs: number;
  error?: Error;
  timestamp: number;
}

/**
 * Lifecycle callback hooks. All are optional; callbacks may be sync or async.
 *
 * Callbacks must not throw; errors are logged but never interrupt the stream.
 * No secrets are passed — see the module-level SECURITY note.
 */
export interface ObservabilityHooks {
  onRequest?: (context: OnRequestContext) => void | Promise<void>;
  onFetchStart?: (context: OnFetchStartContext) => void | Promise<void>;
  onFetchEnd?: (context: OnFetchEndContext) => void | Promise<void>;
  onStreamStart?: (context: OnStreamStartContext) => void | Promise<void>;
  onTransformBegin?: (context: OnTransformBeginContext) => void | Promise<void>;
  onTransformEnd?: (context: OnTransformEndContext) => void | Promise<void>;
  onError?: (context: OnErrorContext) => void | Promise<void>;
  onStreamEnd?: (context: OnStreamEndContext) => void | Promise<void>;
}
