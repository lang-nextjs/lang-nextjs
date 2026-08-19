import { NextRequest } from "next/server";
import { resumePlan, CircuitOpenError } from "../../../../../../lib/langgraph-client";
import { PlatformError } from "../../../../../../lib/types";
import { parseJsonBody } from "../../../../../../lib/body-parser";

export const dynamic = "force-dynamic";

/**
 * POST /api/open-swe/runs/[runId]/plan
 *
 * Resolve open-swe's plan-mode HITL gate (the `data-approval` part rendered by
 * ApprovalCard). open-swe's approval is NOT a stream resume — it dispatches a
 * follow-up run on the thread with the decision, so this returns the NEW run.
 *
 * Body: { threadId: string, decision: "approve" | "reject", feedback?: string }
 * Returns: 201 { run_id, ... } (the follow-up run)
 * Errors: 422 bad body · 502 Platform unreachable · 503 circuit open
 */
export async function POST(request: NextRequest): Promise<Response> {
  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return new Response(
      JSON.stringify({ error: "LANGGRAPH_PLATFORM_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const result = await parseJsonBody(request);
  if (!result.ok) return result.response;
  const body = result.data as {
    threadId?: string;
    decision?: string;
    feedback?: string;
  };

  if (!body.threadId || typeof body.threadId !== "string") {
    return new Response(JSON.stringify({ error: "Missing 'threadId'" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return new Response(
      JSON.stringify({ error: "'decision' must be 'approve' or 'reject'" }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const run = await resumePlan(
      body.threadId,
      body.decision,
      typeof body.feedback === "string" ? body.feedback : "",
      platformUrl
    );
    return new Response(JSON.stringify(run), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return new Response(
        JSON.stringify({ error: "Service temporarily unavailable", retryAfter: err.retryAfterSeconds }),
        { status: 503, headers: { "Retry-After": String(err.retryAfterSeconds), "Content-Type": "application/json" } }
      );
    }
    if (err instanceof PlatformError && err.status >= 500) {
      return new Response(JSON.stringify({ error: "LangGraph Platform unreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(JSON.stringify({ error: "LangGraph Platform request timed out" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("POST /api/open-swe/runs/[runId]/plan error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
