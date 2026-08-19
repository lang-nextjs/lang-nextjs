/**
 * HITL approval routes — mounts createApprovalRoutes() at
 * /api/approval/[approvalId] for GET (status query) and POST (decision).
 *
 * No authorize callback in this demo (fail-open). Production deployments
 * should wire one against their session / API-key system.
 */

import { createApprovalRoutes } from "@deepagents-nextjs/server";

const routes = createApprovalRoutes();
export const GET = routes.GET;
export const POST = routes.POST;
