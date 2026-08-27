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
/**
 * One raw platform status to one board status. No precedence, no context —
 * `mapStatus` below decides which of the two answers to believe.
 */
function mapOne(raw: string | undefined): Run["status"] {
  switch (raw) {
    case "running":
    case "busy":
      return "running";
    case "error":
    case "timeout":
      return "failed";
    case "success":
      return "completed";
    case "pending":
      return "pending";
    // #176's rule, applied on this side too: `idle` means the thread is not
    // executing, which is equally true before a run and after a failure, so it
    // cannot carry a claim of success.
    case "idle":
      return "idle";
    // The state a person is meant to ACT on. Collapsing it into "running" filed
    // every human-blocked run under work in progress and left the board's
    // needs-approval column permanently empty.
    case "interrupted":
      return "interrupted";
    default:
      // NEVER A TERMINAL STATE FOR SOMETHING WE DO NOT RECOGNISE. This was
      // `return "completed"` — a status this build has never seen, rendered as
      // a finished, successful run. That is the exact defect #176 exists to
      // prevent, and it lived one module away from the fix.
      return "unknown";
  }
}

/**
 * WHICH SOURCE IS BELIEVED, AND ABOUT WHAT (#246).
 *
 * This was `const s = runStatus ?? threadStatus` — the run record winning
 * unconditionally — and that single line produced the reported symptom.
 *
 * The two inputs are not two opinions about one question. They answer
 * different questions, and each is authoritative about its own:
 *
 *   the RUN RECORD  — how a run ENDED. Written once, when it ends.
 *   the THREAD      — whether anything is executing NOW. Live.
 *
 * A run record that says `running` is not a report; it is the ABSENCE of an
 * ending. Nothing overwrites it if the run dies, the worker is lost, or the
 * process is killed — so it says `running` forever. Believing it over a live
 * thread reporting `idle` is believing a record precisely where it has no
 * information, and that is what put seventeen runs on the board as "Running",
 * some a day old, every one of their threads idle.
 *
 * So: a TERMINAL run record wins, because an ending is the one thing it does
 * know and the one thing an idle thread can no longer tell us — a thread that
 * failed an hour ago and a thread that never started both read `idle`, and
 * dropping the record would lose the difference. For anything else the thread
 * wins, unless the thread itself has no answer.
 */
export function mapStatus(
  threadStatus: string | undefined,
  runStatus: string | undefined
): Run["status"] {
  const fromRun = runStatus === undefined ? undefined : mapOne(runStatus);
  const fromThread = mapOne(threadStatus);

  if (fromRun === undefined) return fromThread;
  // The record knows how it ended; an idle thread cannot say how it got there.
  if (fromRun === "completed" || fromRun === "failed") return fromRun;
  // The record only claims work is in flight. The live thread can refute that,
  // and does — but it has to actually know something to do so.
  return fromThread === "unknown" ? fromRun : fromThread;
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
        let runTask: string | undefined;

        /**
         * THE BOARD AND THE DETAIL PAGE MUST READ THE SAME SOURCE (#246, again).
         *
         * Reported a second time after #246 was fixed: the same card reads
         * "Running" on the board and "idle" on its own page. The mapper was
         * not at fault this time — it never received the thread's status at all.
         *
         *   the board   POST /threads/search   -> { thread_id, created_at }
         *   the detail  GET  /threads/{id}     -> { status: "idle", ... }
         *
         * `/threads/search` does not carry `status`. So `t.status` was
         * ALWAYS undefined here, the precedence rule added in #246 —
         * "a thread with no answer does not refute the run" — could never
         * fire, and the stale run record won forever. Which is the original
         * bug, reached by a path the original fix could not touch.
         *
         * The unit tests passed because they fed `mapStatus` both values.
         * Production supplies one. A test can be right about a function and
         * wrong about the world it runs in.
         *
         * So the thread is fetched from the endpoint that actually answers —
         * the same one the detail page uses. Two surfaces reading one source
         * is the only structural cure for two surfaces disagreeing.
         */
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
              task?: string;
            }>;
            if (arr[0]?.run_id) {
              runId = arr[0].run_id;
              runStatus = arr[0].status;
              if (typeof arr[0].task === "string" && arr[0].task.trim())
                runTask = arr[0].task.trim();
            }
          }
        } catch {
          // ignore — fall back to thread-level
        }

        /**
         * THE THREAD IS FETCHED ONLY WHEN SOMETHING STILL NEEDS IT.
         *
         * It moved BELOW the runs fetch so that decision can be made with the
         * run record in hand. Fetching it whenever `values` was absent — which
         * is always, for a platform whose search omits them — added a second
         * N+1 to every poll, and a test written for exactly that cost caught
         * it. The run record usually answers both questions.
         */
        let threadStatus = t.status;
        // The full thread, when search did not carry what we need. Its values
        // are the fallback for the task text — see the note at `task:` below.
        let threadValues: unknown = t.values;
        const needStatus = threadStatus === undefined;
        const needTask = runTask === undefined && threadValues === undefined;
        if (needStatus || needTask) {
          try {
            const tr = await platformFetch(
              `${platformUrl}/threads/${encodeURIComponent(t.thread_id)}`,
              { method: "GET", headers: makeHeaders(apiKey) }
            );
            if (tr.ok) {
              const full = (await tr.json()) as {
                status?: unknown;
                values?: unknown;
              };
              if (typeof full.status === "string") threadStatus = full.status;
              if (full.values !== undefined) threadValues = full.values;
            }
          } catch {
            // Best-effort. A thread we cannot read leaves threadStatus
            // undefined, which mapStatus already handles by deferring to the
            // run record — the pre-existing behaviour, not a new failure.
          }
        }

        return {
          run_id: runId,
          thread_id: t.thread_id,
          status: mapStatus(threadStatus, runStatus),
          created_at: t.created_at,
          /**
           * EVERY CARD READ "Untitled task", and the text was never missing.
           *
           * `taskFromValues` reads a thread's first human message out of
           * `values` — and `/threads/search`, which is what the board lists
           * from, does not return `values`. So the fallback fired for every
           * run on the board while the text sat in two other places:
           *
           *   the RUN record      task, as submitted
           *   GET /threads/{id}   values.messages[0], the human turn
           *   /threads/search     neither
           *
           * Same shape as the status bug in #246: the board asks an endpoint
           * that does not carry the field, and renders the fallback as though
           * it were an answer.
           *
           * The run record wins because it is what the person actually typed.
           * The thread's messages are the fallback for a run created outside
           * this app, where no record of the original request exists.
           */
          task: runTask ?? taskFromValues(threadValues),
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
