import { NextRequest } from "next/server";
import { getSandbox, sandboxErrorToResponse } from "../../../../../lib/sandbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/sandbox/capacity
 *
 * Returns: 200 { provider, used, max, available } — how many workspace slots
 * are in use and how many remain before create() starts rejecting at_capacity.
 * Errors:  503 when a remote provider (Blazing) is unreachable.
 */
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    const capacity = await getSandbox().capacity();
    return Response.json(capacity, { status: 200 });
  } catch (err) {
    return sandboxErrorToResponse(err);
  }
}
