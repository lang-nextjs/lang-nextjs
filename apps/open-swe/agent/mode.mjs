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
/**
 * EVERY PROVIDER IN THE CHAIN, not just one.
 *
 * This read `!!process.env.OPENROUTER_API_KEY` alone, while the repo's actual
 * resolution order is NVIDIA -> OpenRouter -> Anthropic (see `make_llm` in both
 * backends' _common.py, and lib/readiness.ts which already names all three).
 *
 * So somebody with NVIDIA_API_KEY set — the provider we RECOMMEND, because it is
 * the free one — was told "Set OPENROUTER_API_KEY". A message naming a key you
 * do not need, while ignoring the one you have, sends you to fix something that
 * was never broken. Reported from a real run.
 *
 * The single-provider check was not a typo: it was written when OpenRouter was
 * the only path, and it kept being true-looking after the chain grew.
 */
const MODEL_KEY_VARS = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
];

export function resolveMode() {
  const hasKey = MODEL_KEY_VARS.some((v) => !!process.env[v]);
  if (!hasKey) {
    // Named for the QUESTION, not for one answer to it. `no-openrouter-api-key`
    // was a reason string that could only ever be right about one provider.
    return { mode: "canned", reason: "no-model-api-key" };
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
