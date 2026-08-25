/**
 * HITL approval decisions for open-swe (#160 gap 1).
 *
 * GET  /api/approval/[approvalId]   current status
 * POST /api/approval/[approvalId]   the decision, which RESUMES the paused run
 *
 * This is the endpoint that makes the approval buttons real. Before it existed,
 * approve sent a chat message containing the literal text "Approved: X" — the
 * agent was never paused, so there was nothing to resume and nothing to gate.
 *
 * NOT MOUNTED FAIL-OPEN. apps/example mounts these routes with no authorize
 * callback and a comment explaining that a demo may do so. That sentence is
 * true there and false here: open-swe reaches real backends with a real key,
 * every fork inherits it, and the actions behind this endpoint are by policy
 * the MUTATING ones. See lib/approval-local-only.ts for what the constraint is
 * and — more importantly — what it is not.
 */

import { createApprovalRoutes } from "@deepagents-nextjs/server";
import { isLocalOnlyRequest } from "../../../../lib/approval-local-only";

const routes = createApprovalRoutes({
  // An explicit refusal, not an omitted callback. Both are limited; only this
  // one is a decision, and only this one changes when someone changes it.
  authorize: (request) => isLocalOnlyRequest(request),
});

export const GET = routes.GET;
export const POST = routes.POST;
