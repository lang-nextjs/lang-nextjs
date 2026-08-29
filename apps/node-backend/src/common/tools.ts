/**
 * The shared tools, ported from apps/fastapi-backend/ai_backends/_common.py.
 *
 * Plain HTTP calls to the reference app's counter API, so they behave
 * identically in any agent framework that accepts a LangChain tool. The Python
 * versions are stdlib-only for the same reason.
 *
 * SCHEMAS ARE JSON SCHEMA, NOT ZOD, DELIBERATELY. `zod` is one of the three
 * singletons scripts/assert-single-instance.mjs tracks, and its rule R1 is that
 * a package importing a singleton must PEER it, never depend on it — a leaf app
 * cannot satisfy that without something else providing the peer. LangChain's
 * `tool()` accepts a JSON Schema directly, so this package imports no zod at
 * all and the question does not arise. Verified: the installed tree resolves
 * exactly one zod (4.4.3).
 *
 * `web_search` IS NOT PORTED. It exists in Python only inside RESEARCH_TOOLS,
 * which only the deepagents rung's deep-research topology consumes — and that
 * rung is not in this backend yet (#10). Porting it now would add a
 * DuckDuckGo scraping dependency for a code path nothing here can reach.
 */
import { tool } from "langchain";

/**
 * Where the counter lives. Same env var and same default as Python's
 * `_common.COUNTER_URL`, including `host.docker.internal` — the tools run
 * inside a container and the counter is on the host. On Linux that name only
 * resolves when the compose file declares
 * `extra_hosts: host.docker.internal:host-gateway`; ours does.
 */
export const COUNTER_URL =
  process.env.COUNTER_URL ?? "http://host.docker.internal:3000/api/counter";

const TIMEOUT_MS = 5_000;

async function counterFetch(init?: RequestInit): Promise<{ counter: number }> {
  const res = await fetch(COUNTER_URL, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // A non-2xx is thrown rather than swallowed so it reaches guardedStream,
    // which turns it into a named error frame. Returning a string like
    // "counter unavailable" would hand the model a sentence to paraphrase and
    // the user a confident answer about a call that failed.
    throw new Error(`counter endpoint returned HTTP ${res.status}`);
  }
  return (await res.json()) as { counter: number };
}

export const increment = tool(
  async () => {
    const data = await counterFetch({ method: "POST" });
    return `Counter incremented to ${data.counter}`;
  },
  {
    name: "increment",
    description: "Increment the counter by 1 and return the new value.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  }
);

export const getCounter = tool(
  async () => {
    const data = await counterFetch();
    return `Counter is ${data.counter}`;
  },
  {
    name: "get_counter",
    description: "Read the current counter value.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  }
);

/** The shared tool list — mirrors Python's `TOOLS = [increment, get_counter]`. */
export const TOOLS = [increment, getCounter];
