import { NextRequest } from "next/server";
import { getThreadState, CircuitOpenError } from "../../../../../../lib/langgraph-client";
import { PlatformError } from "../../../../../../lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/runs/[runId]/state?threadId=...
 *
 * Returns a finished (or in-progress) run's thread state — message history,
 * files, status — so the run page can render COMPLETED runs as history rather
 * than trying to live-stream an already-closed run.
 *
 * Returns: 200 { status, messages, files }
 * Errors: 400 (missing threadId), 502/503 (Platform unreachable / breaker open)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  await params; // runId is implied by the thread; threadId carries the lookup.
  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return Response.json(
      { error: "LANGGRAPH_PLATFORM_URL is not configured" },
      { status: 502 }
    );
  }

  const threadId = request.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return Response.json({ error: "threadId is required" }, { status: 400 });
  }

  try {
    const thread = await getThreadState(threadId, platformUrl);
    return Response.json({
      status: thread.status ?? "idle",
      interrupts: thread.interrupts ?? null,
      messages: thread.values?.messages ?? [],
      files: thread.values?.files ?? {},
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return Response.json(
        { error: "Service temporarily unavailable", retryAfter: err.retryAfterSeconds },
        { status: 503, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
    }
    if (err instanceof PlatformError && err.status === 404) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
    console.error("[open-swe/state] error:", err);
    return Response.json(
      { error: "Failed to load run state" },
      { status: 502 }
    );
  }
}
