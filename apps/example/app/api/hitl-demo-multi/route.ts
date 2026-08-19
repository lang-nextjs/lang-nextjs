/**
 * Multi-interrupt variant: the mock backend emits TWO gated tool-input-starts
 * in sequence. Used by the multi-interrupt E2E test.
 */

import { createDeepAgentsHandler } from "@deepagents-nextjs/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const origin = new URL(request.url).origin;
  const backendUrl = `${origin}/api/hitl-demo/backend?scenario=multi`;

  const handler = createDeepAgentsHandler({
    backendUrl,
    approvalGating: {
      getApprovalConfig: () => ({ require: true, timeoutMs: 60_000 }),
    },
  });
  return handler(request);
}
