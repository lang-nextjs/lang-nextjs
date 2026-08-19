import { CreateRunRequest, PlatformError, Run } from "./types";

const TIMEOUT_MS = 10_000;

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
 * OPEN QUESTION: The exact endpoint path (/runs vs /api/runs vs
 * /threads/{id}/runs) must be verified against the local Platform server
 * before deployment. See task action for curl verification steps.
 *
 * Environment:
 *   LANGGRAPH_PLATFORM_URL — required, e.g. http://localhost:8000
 *   OPEN_SWE_ASSISTANT_ID  — required, e.g. "open-swe"
 *   LANGGRAPH_API_KEY      — optional
 */
export async function createRun(
  req: CreateRunRequest,
  platformUrl: string
): Promise<Run> {
  const assistantId = process.env.OPEN_SWE_ASSISTANT_ID ?? "open-swe";
  const apiKey = process.env.LANGGRAPH_API_KEY;

  const url = `${platformUrl}/runs`;
  const response = await platformFetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey),
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { task: req.task },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PlatformError(response.status, text);
  }

  return response.json() as Promise<Run>;
}

/**
 * List all runs from the LangGraph Platform.
 * GET /runs
 *
 * OPEN QUESTION: Same endpoint path uncertainty as createRun above.
 *
 * Returns Run[] with run_id, status, created_at, task fields.
 */
export async function listRuns(platformUrl: string): Promise<Run[]> {
  const apiKey = process.env.LANGGRAPH_API_KEY;

  const url = `${platformUrl}/runs`;
  const response = await platformFetch(url, {
    method: "GET",
    headers: makeHeaders(apiKey),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PlatformError(response.status, text);
  }

  return response.json() as Promise<Run[]>;
}

/**
 * Retrieve a single run by ID from the LangGraph Platform.
 * Maps to: GET /runs/{runId}
 */
export async function getRun(runId: string, platformUrl: string): Promise<Run> {
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
}
