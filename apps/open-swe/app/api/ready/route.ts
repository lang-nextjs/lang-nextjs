import { NextRequest } from "next/server";
import { createReadinessProbe } from "@deepagents-nextjs/server";

export const dynamic = "force-dynamic";

/**
 * Readiness probe (Phase 18 PROBE-02) — the rollout health-gate.
 *
 * Returns 200 { ready: true, status: "ok" } when the instance can take traffic,
 * and 503 { ready: false, status: "draining" } once graceful shutdown begins
 * (Phase 19 createGracefulShutdown.isDraining() wires in here). The staging
 * smoke-test workflow gates promotion on a 200 from this route; see
 * docs/DEPLOYMENT-RUNBOOK.md "Health-Gated Rollout".
 *
 * Cheap by default: no backend round-trip. To gate on a dependency, pass
 * consumer-supplied `checks` to createReadinessProbe.
 */
export async function GET(_request: NextRequest): Promise<Response> {
  const result = await createReadinessProbe();
  return Response.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}
