/**
 * Approval route factory for the bidirectional approval control channel.
 *
 * Returns Next.js App Router GET and POST route handlers for the dynamic
 * segment `app/api/approval/[approvalId]/route.ts`.
 *
 * GET  /api/approval/[approvalId] — query approval status
 * POST /api/approval/[approvalId] — submit { decision: "approve" | "reject" }
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
import { getApproval, resolveApproval } from "./approval-registry";

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
   * Behavior when absent (fail-open): both handlers accept all requests. This
   * preserves the current zero-arg factory contract for backward compatibility.
   * Authoring an app that exposes approval routes publicly without an authorize
   * callback means anyone with an approvalId can resolve approvals.
   */
  authorize?: (request: NextRequest) => boolean | Promise<boolean>;
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

  async function checkAuthorized(
    request: NextRequest
  ): Promise<NextResponse | null> {
    if (!authorize) return null;
    const allowed = await authorize(request);
    if (allowed) return null;
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return {
    /**
     * GET /api/approval/[approvalId]
     *
     * Returns the current status of a pending approval as JSON.
     * Useful for clients that want to poll before displaying the approval UI.
     */
    GET: async (request, context) => {
      const unauthorized = await checkAuthorized(request);
      if (unauthorized) return unauthorized;
      const { approvalId } = await context.params;
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
      const unauthorized = await checkAuthorized(request);
      if (unauthorized) return unauthorized;
      const { approvalId } = await context.params;

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
