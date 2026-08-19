import { NextRequest } from "next/server";
import { createRun, listRuns, CircuitOpenError } from "../../../../lib/langgraph-client";
import { CreateRunRequest, PlatformError } from "../../../../lib/types";
import { parseJsonBody } from "../../../../lib/body-parser";

export const dynamic = "force-dynamic";

/**
 * POST /api/open-swe/runs
 *
 * Body: { task: string }
 * Returns: 201 { run_id, status, created_at, task }
 * Errors:
 *   422 — missing or invalid task field (including non-string and whitespace-only)
 *   502 — LANGGRAPH_PLATFORM_URL unset or Platform unreachable/5xx
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
  if (!result.ok) {
    return result.response;
  }
  const rawBody = result.data as Partial<CreateRunRequest> | null | undefined;
  // parseJsonBody returns ok:true with data === null for a literal "null"
  // body, and data can be any non-object (e.g. array, string, number) for
  // valid JSON that isn't a request object. Guard before field access —
  // otherwise `body.task` throws a TypeError that becomes a 500. We coerce
  // non-object shapes to {} so the existing task-validation branch produces
  // the same 422 response it would for an empty body.
  const body: Partial<CreateRunRequest> =
    rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody
      : {};

  if (!body.task || typeof body.task !== "string" || body.task.trim() === "") {
    return new Response(
      JSON.stringify({ error: "Missing or invalid 'task' field" }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const run = await createRun({ task: body.task.trim() }, platformUrl);
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
    console.error("POST /api/open-swe/runs error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * GET /api/open-swe/runs
 *
 * Returns: 200 [{ run_id, status, created_at, task }, ...]
 * Errors:
 *   502 — LANGGRAPH_PLATFORM_URL unset or Platform unreachable/5xx
 */
export async function GET(_request: NextRequest): Promise<Response> {
  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return new Response(
      JSON.stringify({ error: "LANGGRAPH_PLATFORM_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const runs = await listRuns(platformUrl);
    return new Response(JSON.stringify(runs), {
      status: 200,
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
    console.error("GET /api/open-swe/runs error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
