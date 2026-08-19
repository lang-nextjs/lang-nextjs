import { NextRequest } from "next/server";
import { getSandbox } from "../../../../../lib/sandbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/sandbox/health
 *
 * Probes the active sandbox provider (Docker daemon by default).
 * Returns: 200 { provider, available: true,  detail } when the daemon is up
 *          503 { provider, available: false, detail } when it is not,
 *               OR when the provider's health() call itself throws
 *               (DNS failure, upstream timeout, token rejection, etc.).
 *               A provider-side failure must NOT bubble up as a generic 500:
 *               clients and load-balancers key off 503 to mean "sandbox
 *               unavailable", so we convert any thrown error into the same
 *               503 contract.
 */
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    const health = await getSandbox().health();
    return Response.json(health, { status: health.available ? 200 : 503 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: "sandbox unavailable", message },
      { status: 503 }
    );
  }
}
