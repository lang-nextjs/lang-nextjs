/**
 * HITL demo proxy route.
 *
 * Wraps createDeepAgentsHandler with approvalGating: { require: true } so the
 * mock backend's tool-input-start frame gets gated. The transform emits
 * data-approval-required to the client; the human resolves via
 * POST /api/approval/[approvalId] (see app/api/approval/[approvalId]/route.ts).
 */

import { createDeepAgentsHandler } from "@deepagents-nextjs/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  // The proxy backend is the sibling /api/hitl-demo/backend route. We resolve
  // it from the incoming request's origin so this works in any deployment
  // without an extra env var (dev server, preview, prod).
  const origin = new URL(request.url).origin;
  const backendUrl = `${origin}/api/hitl-demo/backend`;

  const handler = createDeepAgentsHandler({
    backendUrl,
    approvalGating: {
      // Demo policy: gate every tool that the upstream tries to run.
      getApprovalConfig: () => ({ require: true, timeoutMs: 60_000 }),
    },
  });
  return handler(request);
}
