/**
 * Approval route factory for the bidirectional approval control channel.
 *
 * Returns Next.js App Router GET and POST route handlers for the dynamic
 * segment `app/api/approval/[approvalId]/route.ts`.
 *
 * GET  /api/approval/[approvalId] — query approval status
 * POST /api/approval/[approvalId] — submit { decision: "approve" | "reject" }
 *
 * ── SECURITY MODEL: BEARER CAPABILITY. THIS IS NOT AUTHENTICATION. ──────────────────────
 *
 * There is no authentication here and this package does not provide any. What protects an
 * approval is POSSESSION OF UNGUESSABLE IDS, nothing else:
 *
 *   - `approvalId` is a UUID and there is NO list endpoint, so an approval cannot be
 *     enumerated — you must already hold the id. **That id is delivered to the browser
 *     inside the SSE stream**, so anyone who can read that stream holds it.
 *   - `ownerKey` (#170), when present, is a SECOND bearer token: the `x-approval-owner`
 *     header sent by the request whose stream raised the gate. A resolver must present the
 *     same value. It narrows "anyone holding the id" to "anyone holding the id AND the
 *     creator's key". It does not identify anyone.
 *
 * WHY IT EXISTS AT ALL: the registry is a single `globalThis` Map shared by every concurrent
 * stream in the process, so without the owner key there is no boundary whatsoever between
 * one visitor's approvals and another's. `ownerKey` is that boundary. It is defence in depth
 * over a capability, not access control.
 *
 * WHAT IT DOES NOT DO: it does not stop anyone who has both values, it does not survive the
 * ids being logged or shared, and it does not make these routes safe to expose publicly.
 * **Whether an unauthenticated deployment should expose approval routes at all is a product
 * decision this package cannot make.** If you need real access control, pass `authorize`.
 *
 * The owner check is driven by the RECORD, not by whether `authorize` was wired — see
 * `checkAuthorized`. An app or fork that wires nothing still gets owner-matching.
 *
 * ── AN AUTHORISATION DECISION MUST NOT MUTATE ITS SUBJECT. ──────────────────────────────
 *
 * This is why `checkAuthorized` reads through `peekApproval()` and not `getApproval()`, and
 * it is the reason to leave that indirection alone. `getApproval()` performs a lazy-TTL
 * eviction: an expired `waiting` entry flips to `timeout` ON READ. Authorising against it
 * would let a DENIED caller advance the record merely by asking about it — so "403" and
 * "your approval just timed out" would both be true of one rejected request. That is a side
 * channel and a correctness bug at once. Deciding whether to answer must be free of effects
 * the answer would have had.
 *
 * ── 403, NOT 401. ───────────────────────────────────────────────────────────────────────
 *
 * 401 invites the client to retry with credentials, and there are none — this package has no
 * authentication to offer. 403 says the true thing: you presented a capability and it does
 * not match this record.
 *
 * [QUORUM-1] CRITICAL: cleanupApproval() is NOT called from the POST handler.
 * The SSE transform reads getApproval(approvalId) on its next frame call to detect
 * the resolved status and drain bufferedFrames. Calling cleanupApproval() here would
 * cause getApproval() to return undefined and silently lose buffered frames.
 * Cleanup is the transform's responsibility (after drain). The handler finally block's
 * cleanupExpiredApprovals() handles eventual GC of abandoned entries.
 *
 * Rejection flow: when decision === "reject", resolveApproval sets status to "rejected".
 * On the next frame for that toolCallId, the approvalGating transform detects
 * approval.status === "rejected" and returns a data-error frame with
 * code="approval_rejected". The pendingApprovalsByToolCallId entry is then cleared in
 * the transform. Eventually cleanupExpiredApprovals() (called in the handler's finally
 * block) will GC the registry entry once it is past TTL.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getApproval,
  peekApproval,
  resolveApproval,
} from "./approval-registry";
import type { PendingApproval } from "./approval-registry";

export interface CreateApprovalRoutesOptions {
  /**
   * Optional authorization callback. Invoked at the start of GET and POST.
   * Return true (or resolve to true) to allow the request through. Return false
   * (or resolve to false) to short-circuit with a 401 JSON response.
   *
   * Consumers wire their own auth strategy here (Bearer token, session cookie,
   * NextAuth, etc.) — the route factory stays neutral. Mirrors the getToken
   * pattern in createDeepAgentsHandler: the policy lives at the call site, not
   * in the package.
   *
   * Invoked once the approval has been LOOKED UP, so a callback can compare the
   * request against the RECORD. The previous `(request)`-only signature made that
   * impossible, which is why this hook shipped unused.
   *
   * `approval` is undefined when no such approval exists; both handlers answer 404
   * either way, so a callback need not special-case it.
   *
   * ABSENT NO LONGER MEANS FAIL-OPEN. It means "no consumer policy" — the built-in
   * owner-key check in `checkAuthorized` still applies. (#170)
   */
  authorize?: (
    request: NextRequest,
    approval?: PendingApproval
  ) => boolean | Promise<boolean>;
}

export function createApprovalRoutes(
  options: CreateApprovalRoutesOptions = {}
): {
  GET: (
    request: NextRequest,
    context: { params: Promise<{ approvalId: string }> }
  ) => Promise<NextResponse>;
  POST: (
    request: NextRequest,
    context: { params: Promise<{ approvalId: string }> }
  ) => Promise<NextResponse>;
} {
  const { authorize } = options;

  /**
   * Consumer policy first, then the built-in owner check.
   *
   * THE OWNER CHECK IS DRIVEN BY THE RECORD, NOT BY THE WIRING. An approval
   * carrying an `ownerKey` requires a matching `x-approval-owner` header; one
   * without is resolvable by id alone, exactly as before #170.
   *
   * That asymmetry is the design. Had the check been conditional on the consumer
   * passing `authorize`, or implemented in the app's route file, a fork that kept
   * packages/server and wrote its own route would ship the gate UNGUARDED — and it
   * would LOOK guarded, because the package still exports an authorize hook. A
   * property enforced at the call site is one a fork can drop without noticing.
   * This one travels with the data.
   *
   * 403, not 401: the caller is not unauthenticated — there is no authentication
   * here at all — they presented a capability that does not match this record.
   */
  async function checkAuthorized(
    request: NextRequest,
    approval: PendingApproval | undefined
  ): Promise<NextResponse | null> {
    if (authorize) {
      const allowed = await authorize(request, approval);
      if (!allowed) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    if (approval?.ownerKey !== undefined) {
      if (request.headers.get("x-approval-owner") !== approval.ownerKey) {
        return NextResponse.json(
          { error: "approval belongs to another session" },
          { status: 403 }
        );
      }
    }

    return null;
  }

  return {
    /**
     * GET /api/approval/[approvalId]
     *
     * Returns the current status of a pending approval as JSON.
     * Useful for clients that want to poll before displaying the approval UI.
     */
    GET: async (request, context) => {
      const { approvalId } = await context.params;
      // Authorize against a PEEK — a denied caller must not trip the lazy TTL.
      const unauthorized = await checkAuthorized(
        request,
        peekApproval(approvalId)
      );
      if (unauthorized) return unauthorized;
      const approval = getApproval(approvalId);
      if (!approval) {
        return NextResponse.json(
          { error: "approval not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({
        id: approval.approvalId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        status: approval.status,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      });
    },

    /**
     * POST /api/approval/[approvalId]
     *
     * Body: { decision: "approve" | "reject" }
     *
     * Resolves the pending approval. The approvalGating transform detects the
     * resolved status on its next call and either drains buffered frames (approved)
     * or emits a data-error frame (rejected).
     *
     * [QUORUM-1] cleanupApproval() is intentionally NOT called here — see module JSDoc.
     */
    POST: async (request, context) => {
      const { approvalId } = await context.params;
      const unauthorized = await checkAuthorized(
        request,
        peekApproval(approvalId)
      );
      if (unauthorized) return unauthorized;

      let body: {
        decision?: unknown;
        editedInput?: unknown;
        response?: unknown;
      };
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "invalid JSON body" },
          { status: 400 }
        );
      }

      const decision = body.decision;
      if (
        decision !== "approve" &&
        decision !== "reject" &&
        decision !== "edit" &&
        decision !== "respond"
      ) {
        return NextResponse.json(
          {
            error: "decision must be 'approve', 'reject', 'edit', or 'respond'",
          },
          { status: 400 }
        );
      }

      // Validate payload before touching the registry so a malformed
      // decision doesn't leave the approval in a half-resolved state.
      if (decision === "edit") {
        const editedInput = body.editedInput;
        if (
          editedInput === null ||
          typeof editedInput !== "object" ||
          Array.isArray(editedInput)
        ) {
          return NextResponse.json(
            {
              error: "decision 'edit' requires editedInput to be a JSON object",
            },
            { status: 400 }
          );
        }
      }
      if (decision === "respond") {
        const response = body.response;
        if (typeof response !== "string" || response.length === 0) {
          return NextResponse.json(
            {
              error:
                "decision 'respond' requires response to be a non-empty string",
            },
            { status: 400 }
          );
        }
      }

      const approval = getApproval(approvalId);
      if (!approval) {
        return NextResponse.json(
          { error: "approval not found or expired" },
          { status: 404 }
        );
      }

      if (approval.status !== "waiting") {
        return NextResponse.json(
          { error: "approval already resolved", status: approval.status },
          { status: 409 }
        );
      }

      // Resolve: update status in registry. The approvalGating transform reads
      // the status on its next frame call and handles:
      //   - "approved":  drains bufferedFrames → calls cleanupApproval() after drain
      //   - "edited":    drains, but rewrites the tool-input-start.input with the
      //                  supplied editedInput before draining
      //   - "rejected":  emits data-error frame → entry is eventually GC'd by
      //                  cleanupExpiredApprovals()
      //   - "responded": emits data-human-response frame with the response text,
      //                  drops buffered tool frames, drains globals, clears pending
      //
      // [QUORUM-1] CRITICAL: Do NOT call cleanupApproval(approvalId) here.
      if (decision === "edit") {
        resolveApproval(approvalId, "edit", {
          editedInput: body.editedInput as Record<string, unknown>,
        });
      } else if (decision === "respond") {
        resolveApproval(approvalId, "respond", {
          response: body.response as string,
        });
      } else {
        resolveApproval(approvalId, decision);
      }

      return NextResponse.json({ id: approvalId, decision, accepted: true });
    },
  };
}
