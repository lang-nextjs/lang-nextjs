/**
 * HITL demo proxy route.
 *
 * Wraps the transport core with approvalGating: { require: true } so the mock
 * backend's tool-input-start frame gets gated. The transform emits
 * data-approval-required to the client; the human resolves via
 * POST /api/approval/[approvalId] (see app/api/approval/[approvalId]/route.ts).
 *
 * NO ADAPTER, DELIBERATELY — and this is a severability fix, not a style change.
 *
 * This used `createDeepAgentsHandler`, whose only behaviour is binding
 * `deepagentsAdapter`. That adapter is exactly one transform,
 * stripMessageIdTransform, and the sibling mock emits no messageId — so it was
 * a no-op here, while making three HITL harness routes depend on rung 3. After
 * `eject langchain` they failed to compile, which is why the fork did not build.
 *
 * Approval gating itself is CORE (#30 moved it there), so nothing about HITL
 * needs a rung. The precondition — that the mock stays adapter-free — is held by
 * ./backend/backend.test.ts rather than by this comment.
 */

import { createSseProxyHandler } from "@deepagents-nextjs/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  // The proxy backend is the sibling /api/hitl-demo/backend route. We resolve
  // it from the incoming request's origin so this works in any deployment
  // without an extra env var (dev server, preview, prod).
  const origin = new URL(request.url).origin;
  const backendUrl = `${origin}/api/hitl-demo/backend`;

  const handler = createSseProxyHandler({
    backendUrl,
    approvalGating: {
      // Demo policy: gate every tool that the upstream tries to run.
      getApprovalConfig: () => ({ require: true, timeoutMs: 60_000 }),
    },
  });
  return handler(request);
}
