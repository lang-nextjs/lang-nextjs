/**
 * Auth-protected approval routes — accepts only Bearer "test-secret-token".
 * Used by the auth-deny E2E test to verify the 401 path. Any other token (or
 * none) results in a 401 BEFORE the registry is touched.
 */

import { createApprovalRoutes } from "@deepagents-nextjs/server";

const routes = createApprovalRoutes({
  authorize: (req) => {
    const header = req.headers.get("authorization");
    const match = header?.match(/^Bearer\s+(.+)$/);
    return match?.[1] === "test-secret-token";
  },
});

export const GET = routes.GET;
export const POST = routes.POST;
