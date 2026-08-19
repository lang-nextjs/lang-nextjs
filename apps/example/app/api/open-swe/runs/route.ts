import { NextRequest } from "next/server";
import { createRun, listRuns } from "../../../../lib/langgraph-client";
import { CreateRunRequest, PlatformError } from "../../../../lib/types";

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
      JSON.stringify({
        error:
          "LANGGRAPH_PLATFORM_URL is not set. Copy .env.example to .env.local and configure it.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: Partial<CreateRunRequest> = {};
  try {
    body = (await request.json()) as Partial<CreateRunRequest>;
  } catch (err) {
    // Malformed JSON — surface a distinct 400 so callers can tell the body
    // was unparseable apart from a missing/invalid task field. Silently
    // falling through to the task-field validation error is misleading.
    const detail = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: "Invalid JSON body",
        detail,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

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
      JSON.stringify({
        error:
          "LANGGRAPH_PLATFORM_URL is not set. Copy .env.example to .env.local and configure it.",
      }),
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
