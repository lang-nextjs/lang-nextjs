import { NextRequest } from "next/server";
import {
  cancelRun,
  CircuitOpenError,
} from "../../../../../../lib/langgraph-client";
import { PlatformError } from "../../../../../../lib/types";
import { parseJsonBody } from "../../../../../../lib/body-parser";

export const dynamic = "force-dynamic";

/**
 * POST /api/open-swe/runs/[runId]/cancel
 *
 * Returns: 200 { run_id, status, created_at, task } (with status = failed or cancelled)
 * Errors:
 *   502 — LANGGRAPH_PLATFORM_URL unset or Platform unreachable/5xx
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  // Validate request body size and Content-Type
  const bodyResult = await parseJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return new Response(
      JSON.stringify({ error: "LANGGRAPH_PLATFORM_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const { runId } = await params;

  try {
    const run = await cancelRun(runId, platformUrl);
    return new Response(JSON.stringify(run), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return new Response(
        JSON.stringify({
          error: "Service temporarily unavailable",
          retryAfter: err.retryAfterSeconds,
        }),
        {
          status: 503,
          headers: {
            "Retry-After": String(err.retryAfterSeconds),
            "Content-Type": "application/json",
          },
        }
      );
    }
    if (err instanceof PlatformError && err.status >= 500) {
      return new Response(
        JSON.stringify({ error: "LangGraph Platform unreachable" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: "LangGraph Platform request timed out" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("POST /api/open-swe/runs/[runId]/cancel error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
