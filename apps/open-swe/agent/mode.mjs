/**
 * Which agent actually produced a response — decided by the responder, at the
 * moment it responds.
 *
 * This is deliberately NOT `!!process.env.OPENROUTER_API_KEY`. A key being
 * present says what was *requested*; it does not say what answered. The
 * repo already has one label built the wrong way round (`/api/config` reports
 * `fastapi: !!process.env.FASTAPI_URL`, which stays true when fastapi is
 * down), and a forker who mistakes scripted output for a live agent forms a
 * false belief about what they just saw work.
 *
 * So: `resolveMode()` is called by the code path that SERVES the run, and it
 * reports the path it actually took.
 */
export const AGENT_MODE_HEADER = "x-openswe-agent-mode";
export const AGENT_MODE_REASON_HEADER = "x-openswe-agent-mode-reason";

/**
 * `canned` — deterministic scripted run. No LLM was called.
 * `live`   — a real graph answered. Only ever returned after one actually did.
 */
export function resolveMode() {
  const hasKey = !!process.env.OPENROUTER_API_KEY;
  if (!hasKey) {
    return { mode: "canned", reason: "no-openrouter-api-key" };
  }
  // A key is present, but the live graph is not wired yet (graph authorship is
  // an open product decision — see docs/LOCAL-AGENT.md). We serve the canned
  // run so the rung still works, and we say `canned`, because canned is what
  // the forker is about to watch. Claiming `live` here because a key exists is
  // precisely the misattribution this module exists to prevent.
  return { mode: "canned", reason: "live-graph-not-configured" };
}

export function stampMode(headers, m) {
  headers[AGENT_MODE_HEADER] = m.mode;
  headers[AGENT_MODE_REASON_HEADER] = m.reason;
  return headers;
}
