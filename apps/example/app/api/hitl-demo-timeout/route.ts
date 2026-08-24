/**
 * Same as /api/hitl-demo but with a 1-second approval timeoutMs.
 *
 * The mock backend's "timeout" scenario sleeps 8s, so by the time it emits
 * tool-output-available the gate has timed out and the transform emits
 * data-error code=approval_timeout. Used by the timeout E2E test.
 */

// No adapter — see ../hitl-demo/route.ts for why the HITL harness is rung-free.
import { createSseProxyHandler } from "@deepagents-nextjs/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const origin = new URL(request.url).origin;
  const backendUrl = `${origin}/api/hitl-demo/backend?scenario=timeout`;

  const handler = createSseProxyHandler({
    backendUrl,
    approvalGating: {
      getApprovalConfig: () => ({ require: true, timeoutMs: 1_000 }),
    },
  });
  return handler(request);
}
