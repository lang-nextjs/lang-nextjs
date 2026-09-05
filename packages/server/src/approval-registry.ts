/**
 * In-memory approval registry with lazy TTL eviction and stale-approved GC.
 *
 * Uses a globalThis singleton (??= pattern) for HMR stability — mirrors
 * the stream-registry.ts pattern and the Prisma client singleton convention.
 *
 * Key design decisions:
 *   - No background setInterval: lazy TTL eviction on getApproval() + explicit
 *     cleanupExpiredApprovals() called from the handler finally block.
 *   - getApproval() mutates status to "timeout" on lazy TTL check but does NOT
 *     delete the entry — caller is responsible for cleanup via cleanupApproval().
 *   - cleanupExpiredApprovals() removes terminal-state entries (approved /
 *     rejected / edited / responded) immediately past expiresAt, but defers
 *     "waiting" / "timeout" entries by graceMs (default 30s) so a concurrent
 *     request's finally-block GC doesn't yank a live approval before its
 *     originating handler's proactiveDrain runs.
 */

import type { SseFrame } from "./accumulator";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  /** ISO 8601 string — Date.now().toString() or new Date().toISOString() */
  createdAt: string;
  /** Unix timestamp in ms — Date.now() + timeoutMs */
  expiresAt: number;
  bufferedFrames?: SseFrame[];
  /**
   * Opaque key identifying WHO created this approval — the value of the
   * `x-approval-owner` header on the request whose stream raised the gate.
   *
   * THIS IS NOT AUTHENTICATION. It is a second bearer token. The security model
   * for approvals is capability: possession of the unguessable `approvalId` is
   * the authorization, and that id is delivered to the browser inside the SSE
   * stream. `ownerKey` narrows the capability from "anyone holding the id" to
   * "anyone holding the id AND the creator's key" — which is what stops one
   * session resolving another's approval inside this process, since the registry
   * is a single `globalThis` Map with no boundary between concurrent streams.
   *
   * ABSENT means the creating request sent no header, and the approval is
   * resolvable by id alone — the pre-#170 behaviour, preserved so wiring the
   * header is opt-in. The guard is driven by THIS FIELD rather than by whether a
   * consumer remembered to pass an `authorize` callback, so an app (or a fork)
   * that wires nothing still gets owner-matching the moment the header is sent.
   */
  ownerKey?: string;
  status:
    | "waiting"
    | "approved"
    | "rejected"
    | "edited"
    | "responded"
    | "timeout";
  /**
   * Edited tool input — populated when status === "edited" via
   * resolveApproval(id, "edit", { editedInput }). The approvalGating
   * transform substitutes this for the buffered tool-input-start.input
   * before draining. Maps to LangGraph HumanInterrupt's "edit" response.
   */
  editedInput?: Record<string, unknown>;
  /**
   * Human-authored response — populated when status === "responded" via
   * resolveApproval(id, "respond", { response }). The transform emits a
   * data-human-response frame carrying this text, drops the buffered tool
   * frames (the action does not execute), and clears the pending entry.
   * Maps to LangGraph HumanInterrupt's "response" reply. The consumer (UI
   * or upstream agent loop) decides how to surface the text back to the
   * LLM — typically by sending a new user message.
   */
  response?: string;
}

// Stable singleton that survives Next.js HMR — mirrors Prisma client pattern
function getRegistry(): Map<string, PendingApproval> {
  const g = globalThis as unknown as {
    __deepagents_approval_registry?: Map<string, PendingApproval>;
  };
  g.__deepagents_approval_registry ??= new Map();
  return g.__deepagents_approval_registry;
}

/**
 * Register a pending approval in the registry.
 */
export function registerApproval(approval: PendingApproval): void {
  getRegistry().set(approval.approvalId, approval);
}

/**
 * Get a pending approval by ID.
 *
 * Lazy TTL check: if expiresAt < Date.now() AND status === "waiting",
 * sets status = "timeout". Always returns the record (does NOT delete on TTL).
 */
/**
 * Read an approval WITHOUT the lazy-TTL side effect.
 *
 * `getApproval` mutates: an expired `waiting` entry flips to `timeout` on read. That is
 * correct for a handler serving a response, and wrong for an AUTHORIZATION decision — an
 * unauthorized caller must not be able to change the record's state merely by asking about
 * it. `checkAuthorized` needs only `ownerKey`, so it reads through here. (#170)
 */
export function peekApproval(approvalId: string): PendingApproval | undefined {
  return getRegistry().get(approvalId);
}

/**
 * HAS THIS APPROVAL'S WINDOW CLOSED? ONE PREDICATE, CALLED FROM BOTH SIDES (#417).
 *
 * This existed twice, as two comparisons of the same instant that disagreed by a strict
 * versus inclusive bound:
 *
 *   approval-registry  expiresAt <  Date.now()          -> at now === expiresAt: NOT expired
 *   approval-gating    min(expiry, grace) - now <= 0    -> at now === expiresAt: give up
 *
 * So at exactly `expiresAt` the drain stopped waiting while the registry still called the
 * approval `waiting`, the loop fell through to the release sweep, and a call one comparison
 * away from `approval_timeout` was reported as `approval_pending_at_close` — which claims the
 * operator still had a decision window they did not have.
 *
 * MEASURED, not read: freezing the clock at exactly `expiresAt` yields
 * `approval_pending_at_close`, and at `expiresAt + 1` yields `approval_timeout`. The window
 * is one millisecond wide and it is real.
 *
 * INCLUSIVE, because `expiresAt` is the instant the window CLOSES rather than the last
 * instant it is open. And exported rather than duplicated: two call sites agreeing today is
 * what this already was.
 */
export function hasExpired(
  expiresAt: number,
  now: number = Date.now()
): boolean {
  return expiresAt <= now;
}

export function getApproval(approvalId: string): PendingApproval | undefined {
  const registry = getRegistry();
  const approval = registry.get(approvalId);
  if (!approval) return undefined;

  // Lazy TTL eviction: only mark "waiting" entries as timed out
  if (hasExpired(approval.expiresAt) && approval.status === "waiting") {
    approval.status = "timeout";
  }

  return approval;
}

/**
 * Resolve an approval decision.
 *
 * Idempotent: if status is not "waiting", this is a no-op.
 *
 * Decision modes:
 *   - "approve" → status="approved"; transform drains buffered frames as-is.
 *   - "reject"  → status="rejected"; transform emits data-error approval_rejected.
 *   - "edit"    → status="edited"; transform rewrites the buffered
 *                 tool-input-start.input with payload.editedInput before draining.
 *                 Maps to LangGraph HumanInterrupt's "edit" response.
 *   - "respond" → status="responded"; transform emits a data-human-response
 *                 frame with payload.response, drops the buffered tool frames
 *                 (the action does not execute), and clears the pending entry.
 *                 Maps to LangGraph HumanInterrupt's "response" reply.
 */
export function resolveApproval(
  approvalId: string,
  decision: "approve" | "reject"
): void;
export function resolveApproval(
  approvalId: string,
  decision: "edit",
  payload: { editedInput: Record<string, unknown> }
): void;
export function resolveApproval(
  approvalId: string,
  decision: "respond",
  payload: { response: string }
): void;
export function resolveApproval(
  approvalId: string,
  decision: "approve" | "reject" | "edit" | "respond",
  payload?: { editedInput: Record<string, unknown> } | { response: string }
): void {
  const registry = getRegistry();
  const approval = registry.get(approvalId);
  if (!approval || approval.status !== "waiting") return;
  if (decision === "approve") {
    approval.status = "approved";
  } else if (decision === "reject") {
    approval.status = "rejected";
  } else if (decision === "edit") {
    approval.status = "edited";
    approval.editedInput = (
      payload as { editedInput: Record<string, unknown> }
    ).editedInput;
  } else {
    approval.status = "responded";
    approval.response = (payload as { response: string }).response;
  }
}

/**
 * Delete an approval entry from the registry.
 */
export function cleanupApproval(approvalId: string): void {
  getRegistry().delete(approvalId);
}

/**
 * Default grace period for cleanupExpiredApprovals. A just-expired "waiting"
 * approval is kept around for at least this long after expiresAt so the
 * originating handler's proactiveDrain has a chance to call getApproval
 * (lazy-mark → drainRejectOrTimeout → emit data-error). Without this grace
 * a concurrent request's finally-block GC pass could delete the approval
 * before its own handler drains it, causing the upstream tool-output-available
 * to leak through raw — see the hitl timeout E2E test for repro details.
 */
const DEFAULT_CLEANUP_GRACE_MS = 30_000;

/**
 * Delete entries past expiresAt + graceMs grace.
 *
 * Behaviour by status:
 *   - "waiting"   → kept until expiresAt + graceMs. This avoids racing with
 *                   the originating handler's proactiveDrain (which lazy-marks
 *                   "timeout" via getApproval on the next upstream frame).
 *   - "timeout"   → kept until expiresAt + graceMs. Same race window applies:
 *                   the handler may still be mid-drain (drainRejectOrTimeout).
 *   - "approved" / "rejected" / "edited" / "responded" → deleted on expiresAt
 *                   past now. These are terminal states; the handler that owns
 *                   them has either already called cleanupApproval() or has
 *                   crashed, so they're safe to GC immediately past TTL.
 *
 * [QUORUM-4]: stale "approved" entries (handler crashed mid-drain without
 * cleanupApproval) are still removed here on the same TTL the original code
 * used, so abandoned-drain coverage is preserved.
 *
 * @param graceMs Grace window for "waiting"/"timeout" entries. Defaults to
 *                DEFAULT_CLEANUP_GRACE_MS. Tests pass 0 to verify deletion
 *                without waiting on the grace.
 * @returns count of removed entries.
 */
export function cleanupExpiredApprovals(
  graceMs: number = DEFAULT_CLEANUP_GRACE_MS
): number {
  const now = Date.now();
  let cleaned = 0;
  const registry = getRegistry();
  for (const [id, approval] of registry) {
    if (approval.expiresAt >= now) continue;

    // Terminal states past TTL: safe to evict immediately.
    const isTerminal =
      approval.status === "approved" ||
      approval.status === "rejected" ||
      approval.status === "edited" ||
      approval.status === "responded";
    if (isTerminal) {
      registry.delete(id);
      cleaned++;
      continue;
    }

    // "waiting" / "timeout": only evict after grace, so a concurrent handler's
    // proactiveDrain has time to observe and drain the entry.
    if (now - approval.expiresAt > graceMs) {
      registry.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
