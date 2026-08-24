/**
 * Reference route: streaming chat with error reporting wired via the
 * observability `onError` hook (OPS-02).
 *
 * This mirrors ../stream/route.ts but adds an `observability.onError` hook so
 * you can see exactly where APM/error-reporting integration plugs in. It uses a
 * plain console-based reporter so it runs zero-config in CI/dev.
 *
 * Replace the console reporter below with Sentry.captureException or
 * datadogRum.addError — see docs/ERROR-REPORTING.md. The vendor SDK is the
 * consumer's dependency, never bundled here.
 */
import {
  createSseProxyHandler,
  type OnErrorContext,
} from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";
import { POST as mockPOST } from "../stream/route.mock";
import { resolveAdapter, defaultRungId } from "@/lib/rungs/adapters";

export const dynamic = "force-dynamic";

/**
 * SDK-free error reporter. Stands in for Sentry.captureException /
 * datadogRum.addError so this example needs no vendor SDK. The OnErrorContext
 * fields below are all secret-safe scalars (no headers/tokens/bodies) — see
 * docs/ERROR-REPORTING.md for the full field/safety mapping.
 */
function reportError(ctx: OnErrorContext): void {
  console.error("[error-report]", {
    type: ctx.type,
    message: ctx.error.message,
    durationMs: ctx.durationMs,
    frameIndex: ctx.frameIndex,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const backendUrl = process.env.BACKEND_URL;

  if (!backendUrl) {
    // No backend configured — fall through to the in-process mock so the route
    // works zero-config in dev/CI. onError still demonstrates the wiring above.
    return mockPOST();
  }

  // Adapter comes from the registry, not from a bound default. This route mirrors
  // ../stream/route.ts, which lets the caller pick a rung; here there is nothing to pick
  // from, so it takes the rung this build defaults to. In the full repo that resolves to
  // deepagents — identical to the `createDeepAgentsHandler` default it replaces — and in a
  // rung-1 fork it resolves to langchain instead of failing to compile.
  const handler = createSseProxyHandler({
    backendUrl,
    adapter: resolveAdapter(defaultRungId()),
    observability: { onError: reportError },
  });
  return handler(request);
}
