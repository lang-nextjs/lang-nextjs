import { CreateRunRequest, PlatformError, Run } from "./types";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";
import { readProvenance, type AgentProvenance } from "./agent-mode";

export { CircuitOpenError };

const TIMEOUT_MS = 10_000;

const circuitBreaker = new CircuitBreaker();

export { circuitBreaker };

function makeHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

async function platformFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create a new run on the LangGraph Platform.
 *
 * Verified against a live `langgraph dev` open-swe (2026-06-27): the Platform is
 * THREAD-SCOPED and the `agent` graph takes `{messages:[...]}`, not `{task}`. So
 * we (1) create a thread, then (2) create a background run on it with the task as
 * a user message and `stream_mode: ["events"]` (astream_events v2, which
 * openSweAdapter consumes). The returned Run carries `thread_id` so the run page
 * can open `GET /threads/{tid}/runs/{rid}/stream`.
 *
 * Environment:
 *   LANGGRAPH_PLATFORM_URL — required, e.g. http://localhost:2024
 *   OPEN_SWE_ASSISTANT_ID  — graph id, e.g. "agent"
 *   LANGGRAPH_API_KEY      — optional
 */
export async function createRun(
  req: CreateRunRequest,
  platformUrl: string
): Promise<Run> {
  return circuitBreaker.execute(async () => {
    const assistantId = process.env.OPEN_SWE_ASSISTANT_ID ?? "agent";
    const apiKey = process.env.LANGGRAPH_API_KEY;

    // 1. Create a thread.
    const threadResp = await platformFetch(`${platformUrl}/threads`, {
      method: "POST",
      headers: makeHeaders(apiKey),
      body: JSON.stringify({}),
    });
    if (!threadResp.ok) {
      throw new PlatformError(
        threadResp.status,
        await threadResp.text().catch(() => "")
      );
    }
    const thread = (await threadResp.json()) as { thread_id: string };

    // 2. Create a background run on the thread (task → user message).
    const runResp = await platformFetch(
      `${platformUrl}/threads/${thread.thread_id}/runs`,
      {
        method: "POST",
        headers: makeHeaders(apiKey),
        body: JSON.stringify({
          assistant_id: assistantId,
          input: { messages: [{ role: "user", content: req.task }] },
          stream_mode: ["events"],
        }),
      }
    );
    if (!runResp.ok) {
      throw new PlatformError(
        runResp.status,
        await runResp.text().catch(() => "")
      );
    }
    const run = (await runResp.json()) as {
      run_id: string;
      thread_id?: string;
      status?: string;
      created_at?: string;
    };

    const statusMap: Record<string, Run["status"]> = {
      pending: "pending",
      running: "running",
      success: "completed",
      error: "failed",
      timeout: "failed",
      interrupted: "running",
    };

    return {
      run_id: run.run_id,
      thread_id: run.thread_id ?? thread.thread_id,
      status: statusMap[run.status ?? "pending"] ?? "pending",
      created_at: run.created_at ?? new Date().toISOString(),
      task: req.task,
    };
  });
}

/**
 * Resume open-swe's plan-mode HITL gate by dispatching a follow-up run.
 *
 * open-swe does NOT use langgraph interrupt/resume. When the agent calls
 * `enter_plan_mode` it sets `plan_mode=True` and the run ends; a human approves
 * or rejects, which DISPATCHES A NEW RUN on the same thread with the decision
 * as a user message and `plan_mode=False` (implement) or `True` (revise). This
 * mirrors open-swe's dashboard plan API (`POST /dashboard/api/plan/{thread}/
 * approve|reject` → `client.runs.create(thread,"agent",...)`).
 *
 * OPEN QUESTION (verify against a live open-swe): the exact thread-run endpoint
 * path, and whether the agent expects the approval as a plain user message vs.
 * the dashboard's richer "plan approved, implement it" formatting.
 */
export async function resumePlan(
  threadId: string,
  decision: "approve" | "reject",
  feedback: string,
  platformUrl: string
): Promise<Run> {
  return circuitBreaker.execute(async () => {
    const assistantId = process.env.OPEN_SWE_ASSISTANT_ID ?? "open-swe";
    const apiKey = process.env.LANGGRAPH_API_KEY;

    const content =
      decision === "approve"
        ? `The plan has been approved. Implement it now.${
            feedback
              ? ` Also take this reviewer feedback into account: ${feedback}`
              : ""
          }`
        : `The plan needs changes before implementation.${
            feedback ? ` ${feedback}` : ""
          }`;

    const url = `${platformUrl}/threads/${encodeURIComponent(threadId)}/runs`;
    const response = await platformFetch(url, {
      method: "POST",
      headers: makeHeaders(apiKey),
      body: JSON.stringify({
        assistant_id: assistantId,
        input: { messages: [{ role: "user", content }] },
        config: { configurable: { plan_mode: decision === "reject" } },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlatformError(response.status, text);
    }

    return response.json() as Promise<Run>;
  });
}

/**
 * List all runs from the LangGraph Platform.
 * GET /runs
 *
 * OPEN QUESTION: Same endpoint path uncertainty as createRun above.
 *
 * Returns Run[] with run_id, status, created_at, task fields.
 */
/** Map a LangGraph thread/run status onto the dashboard's Run status. */
function mapStatus(
  threadStatus: string | undefined,
  runStatus: string | undefined
): Run["status"] {
  const s = runStatus ?? threadStatus;
  switch (s) {
    case "running":
    case "busy":
    case "interrupted":
      return "running";
    case "error":
    case "timeout":
      return "failed";
    case "success":
    case "idle":
      return "completed";
    case "pending":
      return "pending";
    default:
      return "completed";
  }
}

/** Extract a human-readable task title from a thread's state values. */
function taskFromValues(values: unknown): string {
  const messages = (values as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return "Untitled task";
  for (const m of messages) {
    const msg = m as { type?: string; role?: string; content?: unknown };
    if (msg.type === "human" || msg.role === "user") {
      const c = msg.content;
      if (typeof c === "string" && c.trim()) return c.trim();
      if (Array.isArray(c)) {
        const text = c
          .map((p) =>
            typeof p === "object" && p && "text" in p
              ? String((p as { text: unknown }).text)
              : ""
          )
          .join(" ")
          .trim();
        if (text) return text;
      }
    }
  }
  return "Untitled task";
}

interface ThreadSummary {
  thread_id: string;
  created_at: string;
  status?: string;
  values?: unknown;
}

/**
 * List recent runs for the dashboard. LangGraph has no global "list runs"
 * endpoint, so enumerate recent threads via /threads/search and map each to its
 * most-recent run (for the run_id + live status the detail link needs).
 */
export async function listRuns(platformUrl: string): Promise<Run[]> {
  return circuitBreaker.execute(async () => {
    const apiKey = process.env.LANGGRAPH_API_KEY;

    const searchResp = await platformFetch(`${platformUrl}/threads/search`, {
      method: "POST",
      headers: makeHeaders(apiKey),
      body: JSON.stringify({
        limit: 20,
        sort_by: "created_at",
        sort_order: "desc",
      }),
    });
    if (!searchResp.ok) {
      const text = await searchResp.text().catch(() => "");
      throw new PlatformError(searchResp.status, text);
    }
    const threads = (await searchResp.json()) as ThreadSummary[];

    return Promise.all(
      threads.map(async (t): Promise<Run> => {
        let runId = t.thread_id;
        let runStatus: string | undefined;
        // Best-effort: the latest run gives a real run_id (for the stream link)
        // and a precise status. Failures fall back to thread-level data.
        try {
          const r = await platformFetch(
            `${platformUrl}/threads/${t.thread_id}/runs?limit=1`,
            { method: "GET", headers: makeHeaders(apiKey) }
          );
          if (r.ok) {
            const arr = (await r.json()) as Array<{
              run_id?: string;
              status?: string;
            }>;
            if (arr[0]?.run_id) {
              runId = arr[0].run_id;
              runStatus = arr[0].status;
            }
          }
        } catch {
          // ignore — fall back to thread-level
        }
        return {
          run_id: runId,
          thread_id: t.thread_id,
          status: mapStatus(t.status, runStatus),
          created_at: t.created_at,
          task: taskFromValues(t.values),
        };
      })
    );
  });
}

/**
 * Retrieve a single run by ID from the LangGraph Platform.
 * Maps to: GET /runs/{runId}
 */
export async function getRun(runId: string, platformUrl: string): Promise<Run> {
  return circuitBreaker.execute(async () => {
    const apiKey = process.env.LANGGRAPH_API_KEY;

    const url = `${platformUrl}/runs/${encodeURIComponent(runId)}`;
    const response = await platformFetch(url, {
      method: "GET",
      headers: makeHeaders(apiKey),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlatformError(response.status, text);
    }

    return response.json() as Promise<Run>;
  });
}

/**
 * Request cancellation of an active run on the LangGraph Platform.
 * Maps to: POST /runs/{runId}/cancel
 * Returns the updated run object (status will be "cancelled" or "failed").
 */
export async function cancelRun(
  runId: string,
  platformUrl: string
): Promise<Run> {
  return circuitBreaker.execute(async () => {
    const apiKey = process.env.LANGGRAPH_API_KEY;

    const url = `${platformUrl}/runs/${encodeURIComponent(runId)}/cancel`;
    const response = await platformFetch(url, {
      method: "POST",
      headers: makeHeaders(apiKey),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlatformError(response.status, text);
    }

    return response.json() as Promise<Run>;
  });
}

/**
 * Fetch a thread's full object (status + state values incl. message history).
 * Maps to: GET /threads/{threadId}. Used by the run page to render COMPLETED
 * runs as history (a finished run can't be live-streamed).
 */
export interface ThreadStateResponse {
  status?: string;
  interrupts?: unknown;
  values?: {
    messages?: unknown[];
    files?: Record<string, unknown>;
    plan_mode?: unknown;
  };
  /**
   * Who answered, read off THIS response's headers rather than off config.
   * Always populated — an unidentified backend resolves to `unknown`, never
   * to `live`. See lib/agent-mode.ts.
   */
  provenance?: AgentProvenance;
}

export async function getThreadState(
  threadId: string,
  platformUrl: string
): Promise<ThreadStateResponse> {
  return circuitBreaker.execute(async () => {
    const apiKey = process.env.LANGGRAPH_API_KEY;
    const url = `${platformUrl}/threads/${encodeURIComponent(threadId)}`;
    const response = await platformFetch(url, {
      method: "GET",
      headers: makeHeaders(apiKey),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlatformError(response.status, text);
    }
    const provenance = readProvenance(response.headers);
    const state = (await response.json()) as ThreadStateResponse;
    return { ...state, provenance };
  });
}
