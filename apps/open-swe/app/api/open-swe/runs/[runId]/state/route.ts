import { NextRequest } from "next/server";
import {
  getThreadState,
  CircuitOpenError,
} from "../../../../../../lib/langgraph-client";
import { PlatformError } from "../../../../../../lib/types";
import {
  AGENT_MODE_HEADER,
  AGENT_MODE_REASON_HEADER,
} from "../../../../../../lib/agent-mode";

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
    // `provenance` describes the backend that served THIS state, read off its
    // response headers — not off our own env. An unidentified backend comes
    // back as `unknown`, which the UI renders as "we can't tell you", rather
    // than silently reading as a live agent.
    const provenance = thread.provenance ?? { mode: "unknown" as const };
    return Response.json(
      {
        // Absence stays absent. Defaulting to "idle" here manufactured a
        // real-looking value from a missing one, and downstream `idle` used to
        // mean "completed" — so a thread with no status rendered as a finished
        // run (#176). The mapper turns undefined into "unknown".
        status: thread.status,
        interrupts: thread.interrupts ?? null,
        messages: thread.values?.messages ?? [],
        files: thread.values?.files ?? {},
        provenance,
      },
      {
        headers: {
          [AGENT_MODE_HEADER]: provenance.mode,
          ...(provenance.reason
            ? { [AGENT_MODE_REASON_HEADER]: provenance.reason }
            : {}),
        },
      }
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return Response.json(
        {
          error: "Service temporarily unavailable",
          retryAfter: err.retryAfterSeconds,
        },
        {
          status: 503,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
        }
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
