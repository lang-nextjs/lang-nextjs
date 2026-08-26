/**
 * createSseProxyHandler — Next.js App Router SSE proxy handler factory. TRANSPORT CORE.
 *
 * Ports and generalizes the POST handler from:
 * stsfront/next-app/app/api/chat/stream/route.ts
 *
 * This module imports NO adapter. The adapter is injected by the caller, and the
 * DeepAgents-flavoured convenience binding lives in ./deepagents-handler — a rung-owned
 * entry point. Until 2026-08-24 this file imported `deepagentsAdapter` directly, so
 * deleting the DeepAgents rung broke the transport for every other rung. See issue #17.
 *
 * Consumers keep using the public two-line setup, which is unchanged:
 *   import { createDeepAgentsHandler } from '@deepagents-nextjs/server'
 *   export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })
 */
import { NextRequest, NextResponse } from "next/server";
import { SseFrameAccumulator, isFrameOversized } from "./accumulator";
import type { SseAdapter } from "./adapter-contract";
import type { SseFrame, SseTransform, SseMultiTransform } from "./accumulator";
import { shouldDebug, logSseFrame } from "./debug";
import {
  atomicRegisterIfAbsent,
  markStreamDone,
  deleteStream,
} from "./stream-registry";
import { isStreamReconnectEnabled } from "./reconnect";
import { createApprovalGatingTransform } from "./approval-gating";
import type { ApprovalGatingConfig } from "./approval-gating";
import { cleanupExpiredApprovals } from "./approval-registry";
import type { ObservabilityHooks } from "./observability";
import { getSafeCurrentTime } from "./timing";
import { checkRateLimit, checkCircuit } from "./resilience";
import type { ResilienceConfig } from "./resilience";

export interface SseProxyHandlerOptions {
  /** URL of the DeepAgents Django backend SSE endpoint */
  backendUrl: string;

  /**
   * Named adapter bundle that normalizes backend SSE format to AI SDK v6.
   * Pipeline: [...adapter.transforms, ...options.transforms]
   *
   * INJECTED, never defaulted here. Omitting it runs the pipeline with no adapter
   * transforms at all — the core has no opinion about which backend you are talking to.
   * `createDeepAgentsHandler` (./deepagents-handler) binds `deepagentsAdapter` for the
   * DeepAgents default, which is where a backend-specific default belongs.
   */
  adapter?: SseAdapter;

  /**
   * Optional retry policy for backend connection failures (fetch() throws).
   * Only retries when the initial fetch() call throws — this covers network
   * errors, DNS failures, and connection refused. Mid-stream failures (errors
   * thrown by reader.read() or JSON.parse inside the streaming loop) are NOT
   * retried and propagate as stream errors.
   *
   * Default: maxRetries=0 (no retry when this option is entirely omitted).
   * Backward compat: callers that do not pass `retry` get zero retries,
   * identical to pre-v1.2 behavior. To enable retries, pass explicitly:
   *   retry: { maxRetries: 3 }  // retries 3 times with default 100ms base delay
   *
   * @example
   * createDeepAgentsHandler({ backendUrl, retry: { maxRetries: 3 } })
   */
  retry?: {
    /** @default 0 — no retry when option is omitted */
    maxRetries?: number;
    /** @default 100 */
    initialDelayMs?: number;
  };

  /**
   * Optional async function that returns an auth token.
   *
   * Behavior (fail-open per CONTEXT.md locked decision):
   * - Returns string  → inject as `Authorization: Bearer {token}`, replacing client Authorization
   * - Returns null/undefined → proxy without Authorization header (let backend decide)
   * - Throws           → error propagates (do NOT catch — consumer is responsible)
   * - Absent           → forward all non-hop-by-hop client headers as-is
   */
  getToken?: (
    req: NextRequest
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Additional SSE transforms appended AFTER adapter.transforms.
   *
   * Per CONTEXT.md locked decision: user transforms are appended after adapter transforms.
   * The messageId strip always runs unless the user bypasses the adapter entirely.
   *
   * Pipeline: (frame: SseFrame) => SseFrame | null  (null drops the frame)
   */
  transforms?: SseTransform[];

  /**
   * Enable tool-level approval gating. When set, a `data-approval-required` frame
   * is emitted before tool execution and the stream pauses until an explicit
   * approval or rejection is received via POST to the approval endpoint.
   *
   * When absent (default): pass-through behavior — no `data-approval-required` frames
   * are emitted and the adapter behaves identically to the non-gating path.
   *
   * @example
   * createDeepAgentsHandler({
   *   backendUrl,
   *   approvalGating: {
   *     getApprovalConfig: (toolCall) => ({ require: true })
   *   }
   * })
   */
  approvalGating?: ApprovalGatingConfig;

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
   * The guard fires in two places:
   *   1. Early reject when the client sends a Content-Length header
   *      exceeding the limit (saves bandwidth on the upload).
   *   2. Belt-and-braces re-check after the body is buffered (catches
   *      clients that omit or understate Content-Length on streamed bodies).
   *
   * @default 1_048_576 (1 MB)
   * @example
   * createDeepAgentsHandler({ backendUrl, maxBodyBytes: 4_194_304 }) // 4 MB
   * createDeepAgentsHandler({ backendUrl, maxBodyBytes: 0 })          // disable
   */
  maxBodyBytes?: number;

  /**
   * Vendor-neutral observability hooks (OBS-01). Register async callbacks that
   * fire at lifecycle points (request, fetch start/end, stream start/end,
   * error) with timing, frame-count, and byte-count metadata.
   *
   * SAFETY (OBS-02): every callback invocation is wrapped in a try-catch — a
   * hook that throws or rejects is logged but NEVER aborts or corrupts the SSE
   * stream. SECURITY (OBS-03): no raw headers, tokens, cookies, or request
   * bodies are passed to any callback; only safe scalar metadata.
   *
   * @example
   * createDeepAgentsHandler({
   *   backendUrl,
   *   observability: {
   *     onStreamEnd: ({ frameCount, byteCount, durationMs }) => metrics.record(...),
   *   },
   * })
   */
  observability?: ObservabilityHooks;

  /**
   * Stateless resilience controls (RESIL-02/03/05/06). Rate limiting and a
   * circuit breaker, each backed by a consumer-provided async store so the
   * library holds ZERO module-scope state and is correct under serverless/edge
   * invocation isolation.
   *
   * - Over-limit requests are rejected with 429 BEFORE any backend fetch.
   * - OPEN-breaker requests are rejected with 503 BEFORE any backend fetch.
   * - Breaker outcomes are recorded after the stream (success on clean finish,
   *   failure on fetch/mid-stream error). Store calls are fail-open: a throwing
   *   store is logged but never crashes the stream.
   * - Rejections fire the observability `onError` hook with the matching type.
   *
   * Retry policy is configured via the separate `retry` option (connection-level
   * fetch failures only; mid-stream failures are never retried). `timeoutMs` is
   * accepted here for type completeness and wired in a later plan.
   *
   * @example
   * createDeepAgentsHandler({
   *   backendUrl,
   *   resilience: { rateLimitStore, circuitBreakerStore },
   * })
   */
  resilience?: ResilienceConfig;
}

/**
 * Hop-by-hop headers that must not be proxied.
 * Per stsfront source: host is set by fetch automatically;
 * content-length may change if body is transformed.
 */
const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Apply a transform pipeline to a frame. Returns an array of zero or more
 * frames — a transform may drop the frame (null → []), emit a single frame
 * (1-in-1-out, the common case), or fan out to multiple frames (SseFrame[]).
 *
 * The pipeline flattens at each stage: each transform processes every frame
 * the previous stage produced. If any transform throws, that frame is
 * skipped (other transforms in the pipeline may continue with the prior
 * stage's output for it — actually here we restart the pipeline with the
 * original frame as a safe fallback, matching legacy behavior).
 */
/**
 * A transform that may be holding frames back and can release them at stream close.
 *
 * STRUCTURAL ON PURPOSE, and both members are optional. The pipeline carries plain
 * transforms — ordinary functions with neither method — and the overwhelmingly common case is
 * that none of them buffers anything. Requiring a nominal type would mean every caller
 * declaring what it does not implement, and an `instanceof` check would tie the core transport
 * to a rung-owned class. Asking the object what it can do keeps this working for any transform
 * a fork writes, including ones this repository will never see.
 */
interface DrainableTransform {
  hasPending?: () => boolean;
  drainOnClose?: () => Promise<SseFrame[]>;
}

function applyTransforms(
  transforms: SseMultiTransform[],
  frame: SseFrame
): SseFrame[] {
  let current: SseFrame[] = [frame];
  for (const t of transforms) {
    const next: SseFrame[] = [];
    for (const f of current) {
      try {
        const result = t(f);
        if (result === null) continue;
        if (Array.isArray(result)) {
          next.push(...result);
        } else {
          next.push(result);
        }
      } catch (err) {
        console.error(
          "[deepagents/server] transform error, skipping frame:",
          err
        );
        // Forward the original frame unchanged so the stream continues —
        // matches legacy 1-out behavior of dropping the failing transform
        // step but preserving downstream stages.
        next.push(f);
      }
    }
    current = next;
  }
  return current;
}

/**
 * True if a transformed frame is the stream's terminal marker.
 *
 * A terminal frame is either the literal `[DONE]` sentinel or an SSE `data:`
 * line whose JSON `type` is `"finish"`. Used to distinguish a clean stream
 * completion from a premature `done` (backend killed mid-stream — TCP closes
 * with no terminal frame ever sent).
 */
function isTerminalFrame(frame: SseFrame): boolean {
  const raw = frame.raw;
  // Check for [DONE] as a standalone SSE line (not embedded in JSON data).
  // The [DONE] marker appears as its own SSE event, not inside a data: payload.
  // Match: entire line is [DONE], or [DONE] at start/end with only whitespace.
  if (/^\s*\[\s*DONE\s*\]\s*$/.test(raw)) return true;
  // SSE data lines look like: data: {...json...}
  const match = raw.match(/data:\s*(\{.*\})/s);
  if (!match) return false;
  try {
    const parsed = JSON.parse(match[1]) as { type?: string };
    return parsed.type === "finish";
  } catch {
    return false;
  }
}

/**
 * Build a client-parseable in-band SSE error event frame (without trailing \n\n).
 *
 * Uses the AI SDK custom data-part error channel, matching the convention in
 * approval-gating.ts so all in-band errors share one shape. The message is
 * intentionally generic; the raw upstream error object/stack is never leaked.
 *
 * THE SHAPE IS NOT OPTIONAL, AND THIS FUNCTION USED TO GET IT WRONG. It emitted
 * `{code, message}` while `DataErrorSchema` requires `id`, `seq`, `code`,
 * `message` and `retryable`. The client rejected every frame it produced:
 *
 *   data-error — rejected by its schema
 *   [ id: expected string, received undefined,
 *     seq: expected number, received undefined,
 *     retryable: expected boolean, received undefined ]
 *
 * The comment above this function CLAIMED it matched approval-gating.ts's
 * shape. It did not, and nothing checked — the claim and the code disagreed for
 * as long as both existed. What made it survive is that the failure only shows
 * up on the error path: you have to lose the upstream connection mid-stream to
 * see it, and at that point an unreadable error frame looks like part of the
 * disconnection rather than a second, separate bug.
 *
 * Only #140's work made it visible at all. Before that a rejected data part was
 * indistinguishable from an absent one, so this frame was silently dropped and
 * the client showed a truncated stream with no error — exactly the silent
 * truncation the frame exists to prevent.
 */
function buildErrorFrame(
  code: string,
  message: string,
  retryable: boolean,
  seq: number
): string {
  return `data: ${JSON.stringify({
    type: "data-error",
    data: { id: `err_${seq}`, seq, code, message, retryable },
  })}`;
}

/**
 * Retry helper with exponential backoff for connection-level fetch failures.
 *
 * Attempt numbering and delay timing:
 * - attempt=0: fires immediately with no delay (first try)
 * - attempt=1: waits initialDelayMs before retrying (1 * 2^0 = 1 * initialDelayMs)
 * - attempt=2: waits 2*initialDelayMs before retrying (1 * 2^1 = 2 * initialDelayMs)
 * - attempt=N: waits initialDelayMs * 2^(N-1) before the next retry
 *
 * The delay formula is: delayMs = initialDelayMs * Math.pow(2, attemptNumber)
 * This is applied AFTER each failed attempt, before retrying.
 *
 * Example: maxRetries=3, initialDelayMs=100
 * - Attempt 0: try fetch (fail) → delay 100ms
 * - Attempt 1: try fetch (fail) → delay 200ms
 * - Attempt 2: try fetch (fail) → delay 400ms
 * - Attempt 3: try fetch (fail) → throw
 *
 * If any attempt succeeds, return immediately without further delays.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number,
  initialDelayMs: number
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Fire an observability hook with uniform error containment (OBS-02).
 *
 * EVERY hook invocation routes through this wrapper so that a callback which
 * throws synchronously OR returns a rejected Promise is caught and logged but
 * NEVER propagates — a misbehaving consumer hook can never abort or corrupt the
 * SSE stream. `fn` is invoked lazily so a missing hook costs nothing.
 */
async function fireHook(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[deepagents/server] ${name} hook failed:`, e);
  }
}

/**
 * Creates a Next.js App Router POST handler that proxies SSE streams from an SSE backend
 * with configurable transforms.
 *
 * Backend-agnostic: whatever normalization a given backend needs arrives via
 * `options.adapter`. For the DeepAgents default, use `createDeepAgentsHandler`.
 */
export function createSseProxyHandler(options: SseProxyHandlerOptions) {
  // null, not a default adapter — see the `adapter` option doc. Still resolved once at
  // factory scope so `.transforms` is read per-request, preserving the fresh-closure
  // behaviour adapter getters (e.g. langchainAdapter) rely on.
  const effectiveAdapter = options.adapter ?? null;

  return async function POST(request: NextRequest): Promise<NextResponse> {
    // PER REQUEST, not per module. A module-level counter made two otherwise
    // identical streams differ in their error frames, which `handler.test.ts`'s
    // "empty transforms array behaves identically to omitting transforms" case
    // caught immediately by comparing whole outputs. Per-stream numbering also
    // matches approval-gating.ts, whose seqCounter is scoped the same way.
    let errorFrameSeq = 0;
    // Per-request observability context (OBS-01). sessionId is a fresh UUID per
    // request; hooks default to an empty object so every `hooks.onX?.(...)` is a
    // no-op when unconfigured. startedAt anchors all durationMs deltas using the
    // edge-safe time source (OBS-04).
    const hooks = options.observability ?? {};
    const sessionId = crypto.randomUUID();
    const startedAt = getSafeCurrentTime();

    // Evaluate transforms per-request so adapter getters (e.g. langchainAdapter)
    // return a fresh closure on each call — prevents toolCallCounters bleed across
    // sequential requests through the same handler instance.
    // Read the owner key from a HEADER, not the body. The handler proxies the body
    // as bytes (`arrayBuffer()` below) and deliberately does not know its schema;
    // parsing a session id out of it would couple the transport to a body shape it
    // has been careful to stay ignorant of. Mirrors how `x-resume-id` is read.
    // An absent header leaves `ownerKey` undefined and approvals stay resolvable by
    // id alone — the pre-#170 behaviour. See PendingApproval.ownerKey. (#170)
    const approvalOwnerKey =
      request.headers.get("x-approval-owner") ?? undefined;
    const approvalTransform = options.approvalGating
      ? createApprovalGatingTransform({
          ...options.approvalGating,
          ownerKey: approvalOwnerKey,
        })
      : null;

    const allTransforms = [
      ...(effectiveAdapter?.transforms ?? []),
      ...(approvalTransform ? [approvalTransform] : []),
      ...(options.transforms ?? []),
    ];
    // Read resumeId from header BEFORE consuming the body — header reads are safe before arrayBuffer()
    const resumeId = request.headers.get("x-resume-id") ?? undefined;

    // Dedup guard: if reconnection is enabled and resumeId provided, check registry
    let registeredResumeId: string | undefined;
    if (resumeId && isStreamReconnectEnabled()) {
      const result = atomicRegisterIfAbsent(resumeId, crypto.randomUUID());
      if (!result.ok) {
        return new NextResponse(
          "stream already in progress for this resumeId",
          { status: 409 }
        );
      }
      registeredResumeId = resumeId;
    }

    // Body-size guard: refuse payloads larger than MAX_BODY_BYTES (1MB)
    // before reading the full buffer into memory. Prevents unbounded
    // memory growth from a hostile or malformed client. Configurable via
    // options.maxBodyBytes; 0 / negative disables. Default matches the
    // open-swe app's body-parser for consistency.
    const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    if (maxBodyBytes > 0) {
      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          return new NextResponse(
            JSON.stringify({
              error: "Payload too large",
              maxBytes: maxBodyBytes,
            }),
            {
              status: 413,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
    }

    const body = await request.arrayBuffer();
    // Belt-and-braces: re-check after read in case Content-Length was
    // missing or under-stated (some HTTP clients omit it for streamed
    // bodies). Catches the attack a content-length-only check would miss.
    if (maxBodyBytes > 0 && body.byteLength > maxBodyBytes) {
      return new NextResponse(
        JSON.stringify({
          error: "Payload too large",
          maxBytes: maxBodyBytes,
          actual: body.byteLength,
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Resilience gate (RESIL-02/03). Placed AFTER the body-size guard but BEFORE
    // building forwardedHeaders / the upstream fetch, so rejected requests never
    // pay for the expensive backend round-trip. All state is consumer-provided
    // via stores — the library holds zero module-scope state.
    const resilience = options.resilience;
    // Breaker key is captured here so the same key used for the early OPEN check
    // is reused for the post-stream outcome recording below.
    let breakerKey: string | undefined;
    if (resilience) {
      // 1. Rate limit → 429 before fetch.
      if (resilience.rateLimitStore) {
        const key = resilience.rateLimitKey?.(request) ?? sessionId;
        const allowed = await checkRateLimit(resilience.rateLimitStore, key);
        if (!allowed) {
          // Release any registry slot so a rejected request does not lock out
          // the resumeId with a permanent 409.
          if (registeredResumeId) deleteStream(registeredResumeId);
          await fireHook("onError", () =>
            hooks.onError?.({
              type: "rate-limit",
              error: new Error("Rate limited"),
              durationMs: getSafeCurrentTime() - startedAt,
              sessionId,
              timestamp: getSafeCurrentTime(),
            })
          );
          return NextResponse.json({ error: "Rate limited" }, { status: 429 });
        }
        // Under the limit: account this hit. record is the consumer's job to
        // make atomic; the library only calls it.
        await resilience.rateLimitStore.record(
          key,
          resilience.rateLimitWindowMs ?? 60000
        );
      }

      // 2. Circuit breaker → 503 before fetch when OPEN.
      if (resilience.circuitBreakerStore) {
        breakerKey = resilience.circuitBreakerKey?.(request) ?? sessionId;
        const { allowed } = await checkCircuit(
          resilience.circuitBreakerStore,
          breakerKey
        );
        if (!allowed) {
          if (registeredResumeId) deleteStream(registeredResumeId);
          await fireHook("onError", () =>
            hooks.onError?.({
              type: "circuit-breaker",
              error: new Error("Service unavailable"),
              durationMs: getSafeCurrentTime() - startedAt,
              sessionId,
              timestamp: getSafeCurrentTime(),
            })
          );
          return NextResponse.json(
            { error: "Service unavailable" },
            { status: 503 }
          );
        }
      }
    }

    /**
     * Record a circuit-breaker outcome, fail-open. A store that throws/rejects
     * is logged but never crashes the request/stream (RESEARCH locked decision
     * 7). No-op when no breaker store is configured.
     */
    const recordBreakerOutcome = async (
      outcome: "success" | "failure"
    ): Promise<void> => {
      if (!resilience?.circuitBreakerStore || breakerKey === undefined) return;
      try {
        await resilience.circuitBreakerStore.recordEvent(
          breakerKey,
          outcome,
          resilience.circuitBreakerResetMs
        );
      } catch (e) {
        console.error(
          "[deepagents/server] circuit-breaker recordEvent failed:",
          e
        );
      }
    };

    // Strict per-header validation: reject duplicate single-value headers up-front.
    //
    // The Fetch API combines duplicate header lines on iteration per RFC 7230
    // §3.2.2, with per-header join semantics that do NOT match what most clients
    // intend or what most backends accept:
    //
    //   Header         Join  RFC         Notes
    //   ─────────────  ────  ──────────  ─────────────────────────────────────
    //   Content-Type   ", "  7231 §3.1.1 Malformed — no valid media-type has a comma
    //   Authorization  ", "  RFC 7235    Single auth-scheme + token; comma = bypass attempt
    //   Cookie         "; "  6265 §4.2  CORRECT — RFC 6265 syntax IS "; "-separated
    //   Set-Cookie     sep   6265 §3    Yields SEPARATE iterations via getSetCookie()
    //   Accept         ", "  7231 §5.3  CORRECT — comma-separated media types
    //   Vary           ", "  7231 §7.1  CORRECT — comma-separated header names
    //   Cache-Control  ", "  7234 §5.2  CORRECT — comma-separated directives
    //
    // We reject with 400 when a STRICT single-value header has a comma (Content-Type,
    // Authorization). Strict-mode backends (Django, Express strict, FastAPI strict)
    // reject the combined value anyway, so failing closed at the proxy gives a
    // clearer error than letting the backend reject with a generic 400.
    //
    // We do NOT generalize the comma check to Cookie / Accept / Vary / Cache-Control:
    // - Cookie: "; " joining IS the correct RFC 6265 grammar — `set-cookie: a=1`
    //   then `set-cookie: b=2` legitimately becomes `cookie: a=1; b=2` for the
    //   backend. URL-encoded values can also legitimately contain literal commas
    //   (e.g. `data=%2C`), so the comma heuristic has false positives.
    // - Accept / Vary / Cache-Control: comma-joined IS the spec-defined multi-value
    //   syntax — the iteration yields exactly what the client intended.
    // - Host / Content-Length are excluded — they're hop-by-hop and not forwarded.
    // - User-Agent is left alone — duplicate UA is rare and forgiving.
    const STRICT_SINGLE_VALUE_HEADERS = ["content-type", "authorization"];
    for (const headerName of STRICT_SINGLE_VALUE_HEADERS) {
      const value = request.headers.get(headerName);
      if (value && value.includes(",")) {
        return new NextResponse(
          JSON.stringify({
            error: "Bad Request",
            message: `Duplicate ${headerName} header is not allowed`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Build forwarded headers per CONTEXT.md locked decisions
    const forwardedHeaders = new Headers();

    if (options.getToken !== undefined) {
      // getToken provided: apply auth policy
      // Forward non-hop-by-hop client headers, excluding Authorization (getToken controls it)
      for (const [key, value] of request.headers) {
        if (
          !HOP_BY_HOP.has(key.toLowerCase()) &&
          key.toLowerCase() !== "authorization"
        ) {
          forwardedHeaders.set(key, value);
        }
      }
      // getToken throws → propagates (not caught here per CONTEXT.md locked decision)
      const token = await options.getToken(request);
      if (token && token.trim()) {
        // Returns non-empty, non-whitespace string → inject as Authorization: Bearer {token}
        forwardedHeaders.set("authorization", `Bearer ${token}`);
      }
      // Returns null/undefined/empty string/whitespace-only → no Authorization header (fail-open)
    } else {
      // getToken absent → forward all non-hop-by-hop headers as-is
      for (const [key, value] of request.headers) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          forwardedHeaders.set(key, value);
        }
      }
    }

    // Default maxRetries=0 (no retry when option omitted) — preserves pre-v1.2 behavior.
    // Only connection-level fetch() failures are retried. The catch block here covers
    // fetchWithRetry exhausting all attempts; it does NOT wrap the streaming loop.
    // Mid-stream failures (reader.read() throws, JSON.parse errors) are caught separately
    // inside the streaming loop and do NOT call fetchWithRetry.
    const maxRetries = options.retry?.maxRetries ?? 0;
    const initialDelayMs = options.retry?.initialDelayMs ?? 100;
    // AbortController for the upstream connection. Aborted in the streaming
    // loop's `finally` block on every exit path (clean finish, truncation, or
    // thrown error) so the upstream fetch socket is released and cannot leak.
    const abortController = new AbortController();

    // Per-request timeout (RESIL-01). When resilience.timeoutMs is set and > 0,
    // a function-LOCAL timer aborts the upstream fetch after the deadline. The
    // handle is per-request (no module-scope state) and is cleared on EVERY exit
    // path — fetch throws, no body, clean finish, mid-stream error, truncation,
    // or timeout firing — so a timer never outlives its request and no FD/socket
    // leaks across repeated aborts (the lsof FD-stability gate, unit-proxied by
    // handler.resource-cleanup.test.ts; real stress test deferred to Phase 20
    // OPS-05).
    const timeoutMs = options.resilience?.timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Centralized timer clear so every exit path uses one idempotent helper.
    const clearTimeoutHandle = (): void => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    }

    // onRequest fires after the request is accepted (auth resolved, headers
    // built) and immediately before the upstream fetch begins. No secrets are
    // passed — only sessionId, backendUrl, and a timestamp.
    await fireHook("onRequest", () =>
      hooks.onRequest?.({
        sessionId,
        backendUrl: options.backendUrl,
        timestamp: getSafeCurrentTime(),
      })
    );
    await fireHook("onFetchStart", () =>
      hooks.onFetchStart?.({
        backendUrl: options.backendUrl,
        timeoutMs,
        timestamp: getSafeCurrentTime(),
      })
    );

    let backendResponse: Response;
    try {
      backendResponse = await fetchWithRetry(
        options.backendUrl,
        {
          method: "POST",
          headers: forwardedHeaders,
          body,
          signal: abortController.signal,
          // @ts-expect-error — Node 18 fetch needs duplex for streaming bodies
          duplex: "half",
        },
        maxRetries,
        initialDelayMs
      );
    } catch (err) {
      // Clear the per-request timeout — the fetch will never start streaming, so
      // the timer must not outlive the failed attempt (RESIL-01 cleanup).
      clearTimeoutHandle();
      // Clean up registry entry if we registered but fetch failed — prevents permanent 409 lockout
      if (registeredResumeId) {
        deleteStream(registeredResumeId);
      }
      const fetchError = err instanceof Error ? err : new Error(String(err));
      // Connection-level failure counts as a circuit-breaker "failure" outcome.
      await recordBreakerOutcome("failure");
      // Fire onFetchEnd (failure path) and onError before returning 502 so
      // consumers can record the failed upstream attempt.
      await fireHook("onFetchEnd", () =>
        hooks.onFetchEnd?.({
          backendUrl: options.backendUrl,
          bytesReceived: 0,
          durationMs: getSafeCurrentTime() - startedAt,
          error: fetchError,
          timestamp: getSafeCurrentTime(),
        })
      );
      await fireHook("onError", () =>
        hooks.onError?.({
          type: "fetch",
          error: fetchError,
          durationMs: getSafeCurrentTime() - startedAt,
          sessionId,
          timestamp: getSafeCurrentTime(),
        })
      );
      console.error(
        "[deepagents/server] backend fetch failed after retries",
        err
      );
      return new NextResponse("upstream error", { status: 502 });
    }

    // onFetchEnd (success path). bytesReceived is 0 here — the running byte
    // count is not yet available at fetch resolution (the stream has not been
    // read); the total is reported via onStreamEnd.byteCount instead.
    await fireHook("onFetchEnd", () =>
      hooks.onFetchEnd?.({
        backendUrl: options.backendUrl,
        status: backendResponse.status,
        bytesReceived: 0,
        durationMs: getSafeCurrentTime() - startedAt,
        timestamp: getSafeCurrentTime(),
      })
    );

    if (!backendResponse.body) {
      // No body to stream — clear the timer now since the streaming loop (which
      // owns the finally cleanup) never runs (RESIL-01 cleanup).
      clearTimeoutHandle();
      abortController.abort();
      return new NextResponse(null, { status: backendResponse.status });
    }

    // onStreamStart fires once the upstream body is confirmed, before the
    // ReadableStream is constructed.
    await fireHook("onStreamStart", () =>
      hooks.onStreamStart?.({
        backendUrl: options.backendUrl,
        status: backendResponse.status,
        timestamp: getSafeCurrentTime(),
      })
    );

    // Build the passthrough response headers.
    const responseHeaders = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    // Forward the AI SDK stream-version marker so useChat knows which protocol
    // to use. Without this header the SDK falls back to legacy parsing.
    const aiSdkMarker = backendResponse.headers.get(
      "x-vercel-ai-ui-message-stream"
    );
    if (aiSdkMarker) {
      responseHeaders.set("x-vercel-ai-ui-message-stream", aiSdkMarker);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const accumulator = new SseFrameAccumulator();

    // Transform the SSE stream: buffer by frame boundary (\n\n) and apply
    // the transforms pipeline. We cannot regex-replace on raw bytes because
    // a chunk boundary can split a frame in the middle.
    //
    // BACKPRESSURE (RESIL-04): this source is `pull`-driven, not eager. The
    // Web Streams runtime calls `pull(controller)` only when the consumer is
    // ready (the internal queue has room, i.e. desiredSize > 0) and will NOT
    // call it again until the previously enqueued chunks have been pulled. By
    // returning from `pull` as soon as we have enqueued the frames from one
    // backend read, a slow client throttles how fast we read from the upstream
    // — the in-flight gap stays bounded (one backend read), so a slow consumer
    // can never cause unbounded buffering. This uses ONLY Web Streams APIs
    // (no Node stream.pipeline) so the code path stays edge-compatible.
    const reader = backendResponse.body!.getReader();
    // Tracks whether a terminal frame ({"type":"finish"} or [DONE]) was
    // observed before the reader signalled `done`. A clean finish sets this
    // true; a premature `done` (backend killed mid-stream) leaves it false,
    // which is how we detect a silent truncation.
    //
    // Checked against the RAW backend frame (before user transforms) so that a
    // user transform dropping frames is NOT mistaken for an upstream
    // disconnect — truncation is a property of what the BACKEND sent, not of
    // what survives the transform pipeline.
    let sawTerminalFrame = false;
    // Observability accumulators (OBS-01). frameCount counts frames enqueued to
    // the client; byteCount sums the encoded byte length of each enqueued
    // frame. Reported via onStreamEnd. streamError captures a mid-stream
    // failure so it can be surfaced to onStreamEnd as well.
    let frameCount = 0;
    let byteCount = 0;
    let streamError: Error | undefined;
    // Guards the one-time teardown so cleanup runs exactly once across the
    // multiple pull() invocations / cancel().
    let finished = false;

    // One-time teardown shared by the done-path, the error-path, and cancel().
    // Runs on EVERY stream exit path (clean finish, truncation, thrown error,
    // client cancel) exactly once.
    const finalize = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      // Clear the per-request timeout FIRST so the timer never outlives the
      // stream on ANY exit path — clean finish, truncation, mid-stream error,
      // or the timeout having already fired (RESIL-01: no dangling timer).
      clearTimeoutHandle();
      // Abort the upstream fetch on every exit path so the connection is
      // released and does not leak (issue #4 "clean up the AbortController").
      // Idempotent if the timeout already aborted it.
      abortController.abort();
      if (registeredResumeId && isStreamReconnectEnabled()) {
        markStreamDone(registeredResumeId);
      }
      // Clean up any expired/abandoned approvals from this request
      if (options.approvalGating) {
        cleanupExpiredApprovals();
      }
      // onStreamEnd fires on EVERY stream exit path (clean finish, truncation,
      // or thrown error). success reflects whether a terminal frame was seen;
      // frameCount/byteCount report the totals delivered to the client
      // (OBS-01). Wrapped in fireHook so a throwing hook never escapes (OBS-02).
      await fireHook("onStreamEnd", () =>
        hooks.onStreamEnd?.({
          success: sawTerminalFrame,
          frameCount,
          byteCount,
          durationMs: getSafeCurrentTime() - startedAt,
          error: streamError,
          timestamp: getSafeCurrentTime(),
        })
      );
      // Record the circuit-breaker outcome for this request: success only on a
      // clean finish (terminal frame seen AND no mid-stream error), failure
      // otherwise (truncation or mid-stream error). Fail-open.
      await recordBreakerOutcome(
        sawTerminalFrame && !streamError ? "success" : "failure"
      );
    };

    // Process a batch of raw frames: oversized-skip, terminal-detect,
    // transform, encode, enqueue, and account observability counts. Shared by
    // the streaming-chunk path and the final flush.
    const emitFrames = (
      frames: string[],
      controller: ReadableStreamDefaultController<Uint8Array>
    ): void => {
      for (const frame of frames) {
        // Skip oversized frames to prevent the transform pipeline from
        // processing unreasonably large payloads.
        if (isFrameOversized(frame)) {
          console.error(
            `[deepagents/server] oversized frame (${frame.length} bytes), skipping`
          );
          continue;
        }
        sawTerminalFrame = sawTerminalFrame || isTerminalFrame({ raw: frame });
        const transformed = applyTransforms(allTransforms, { raw: frame });
        for (const out of transformed) {
          if (shouldDebug()) logSseFrame(out);
          const encoded = encoder.encode(`${out.raw}\n\n`);
          frameCount++;
          byteCount += encoded.length;
          controller.enqueue(encoded);
        }
      }
    };

    // Frames released by a transform's drainOnClose() have ALREADY been through every
    // transform up to and including that one — they are its output. Re-running the full
    // pipeline would feed them back into the gate that just released them. Only the
    // transforms AFTER it in `allTransforms` still apply, which is why the downstream set is
    // a PARAMETER rather than the constant it used to be: it depends on where the draining
    // transform sits, and the handler no longer assumes that position is fixed.
    const emitDrainedFrames = (
      frames: SseFrame[],
      controller: ReadableStreamDefaultController<Uint8Array>,
      downstream: SseMultiTransform[]
    ): void => {
      for (const frame of frames) {
        if (isFrameOversized(frame.raw)) {
          console.error(
            `[deepagents/server] oversized frame (${frame.raw.length} bytes), skipping`
          );
          continue;
        }
        sawTerminalFrame = sawTerminalFrame || isTerminalFrame(frame);
        for (const out of applyTransforms(downstream, frame)) {
          if (shouldDebug()) logSseFrame(out);
          const encoded = encoder.encode(`${out.raw}\n\n`);
          frameCount++;
          byteCount += encoded.length;
          controller.enqueue(encoded);
        }
      }
    };

    const transformedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // Read exactly ONE chunk per pull, enqueue its frames, then return.
          // Returning hands control back to the runtime, which re-invokes pull
          // only once the consumer has drained the queue (desiredSize > 0) —
          // this is the backpressure mechanism that bounds the in-flight gap.
          // Loop only to skip empty reads that yielded no complete frame yet.
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any remaining buffer content.
              emitFrames(accumulator.flush(), controller);

              // Upstream has ended — but a human may still be deciding on a gated tool.
              // The approval transform drains only from inside itself, and it only runs per
              // input frame, so once `done` arrives there is no remaining call site and every
              // buffered frame becomes unreachable. Previously we closed here and those
              // frames were discarded with no frame and no error: the approval POST still
              // returned 200 and the registry still read "success" while the continuation
              // was dropped. Hold the response open until the approvals settle. (Issue #25b.)
              //
              // EVERY DRAINABLE, NOT JUST THE ONE THIS HANDLER BUILT. This used to drain only
              // `approvalTransform` — the gate constructed here from `options.approvalGating`.
              // A gate supplied through `options.transforms` was never drained at all, and
              // open-swe supplies it exactly that way BECAUSE ORDERING REQUIRES IT: its gate
              // must run after the enrichment transform, and `approvalGating` is spliced in
              // before `options.transforms`. So the caller had to choose between correct
              // ordering and the #25b guarantee, with nothing saying so — the frames were
              // dropped in silence, the approval POST still returned 200, and the client was
              // never even told the stream had finished.
              //
              // Draining in pipeline order matters: a frame released by transform i is fed
              // through i+1..n, any of which may buffer it in turn, and those sit later in
              // this loop so they still get their own chance to release it.
              for (let i = 0; i < allTransforms.length; i++) {
                const candidate = allTransforms[i] as DrainableTransform;
                if (!candidate.hasPending?.()) continue;
                try {
                  emitDrainedFrames(
                    await candidate.drainOnClose!(),
                    controller,
                    allTransforms.slice(i + 1)
                  );
                } catch (drainErr) {
                  // Draining must never turn a recoverable truncation into a crashed stream.
                  // Per-transform, so one bad drain cannot strand the transforms after it.
                  console.error(
                    "[deepagents/server] drain-on-close failed:",
                    drainErr
                  );
                }
              }
              // Premature `done` with no terminal frame ever seen = the backend
              // disconnected mid-stream. Emit a parseable in-band error event
              // BEFORE closing so the client is not left with a silent
              // truncation.
              if (!sawTerminalFrame) {
                try {
                  controller.enqueue(
                    encoder.encode(
                      `${buildErrorFrame(
                        "upstream_disconnect",
                        "upstream backend disconnected mid-stream",
                        true,
                        errorFrameSeq++
                      )}\n\n`
                    )
                  );
                } catch {
                  // controller already errored/closed (client gone) — ignore
                }
              }
              // Run teardown (onStreamEnd + breaker outcome + timer/socket
              // release) BEFORE closing so a consumer that observes `done`
              // is guaranteed the end-of-stream side effects have completed.
              await finalize();
              controller.close();
              return;
            }

            const chunk = decoder.decode(value, { stream: true });
            const before = frameCount;
            emitFrames(accumulator.push(chunk), controller);
            // If this read produced at least one enqueued frame, return so the
            // runtime can apply backpressure before the next read. If it
            // produced nothing (partial frame still buffering), loop to read
            // again rather than stalling the stream.
            if (frameCount > before) return;
          }
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err));
          console.error("[deepagents/server] mid-stream error", err);
          // Surface the mid-stream failure to the onError hook (OBS-01) —
          // wrapped in fireHook so a throwing hook cannot mask the original
          // error.
          await fireHook("onError", () =>
            hooks.onError?.({
              type: "stream",
              error: streamError!,
              durationMs: getSafeCurrentTime() - startedAt,
              sessionId,
              timestamp: getSafeCurrentTime(),
            })
          );
          // Deliver the failure to the client as a parseable in-band SSE error
          // event, then CLOSE (not error) the stream so the client can reliably
          // read that final frame. The guard tolerates the client having
          // already disconnected (enqueue throws "Invalid state").
          try {
            controller.enqueue(
              encoder.encode(
                `${buildErrorFrame(
                  "upstream_disconnect",
                  "upstream backend disconnected mid-stream",
                  true,
                  errorFrameSeq++
                )}\n\n`
              )
            );
          } catch {
            // controller already errored/closed — do not mask the original error
          }
          // Teardown before close so end-of-stream side effects complete before
          // the consumer observes `done` (mirrors the clean-finish ordering).
          await finalize();
          try {
            controller.close();
          } catch {
            // controller already closed/errored — safe to ignore
          }
        }
      },
      // The consumer (client) went away — cancel the upstream and run teardown
      // so timers/sockets are released even when no done/error path was reached.
      async cancel() {
        await finalize();
      },
    });

    return new NextResponse(transformedStream, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  };
}

/**
 * Public alias, unchanged for consumers. The interface is named `SseProxyHandlerOptions`
 * internally because the transport core is not DeepAgents-specific; the exported name stays
 * `DeepAgentsHandlerOptions` because renaming the public surface is issue #3's scope, not
 * this one's. Nominal coupling is cosmetic with respect to severability.
 */
export type DeepAgentsHandlerOptions = SseProxyHandlerOptions;
