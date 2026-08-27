import { readFileSync } from "node:fs";

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

/**
 * IS A MODEL KEY CONFIGURED FOR THIS REPO — not merely for this process.
 *
 * Reported from a real run: the banner said "Set NVIDIA_API_KEY…" to someone
 * whose NVIDIA_API_KEY was set. It was set in the repo-root .env, which the
 * BACKEND reads through docker's env_file and which this stub — a plain node
 * process started by dev-all.sh — never sees. `pnpm dev` reports secrets by
 * name and deliberately does not copy them into child environments.
 *
 * So a check on `process.env` alone answers "did anyone export this to me",
 * and the banner reported it as "you have no key". Same defect as the
 * readiness banner an hour earlier: a verdict about a file, computed from
 * somewhere the file is not.
 *
 * ONLY PRESENCE IS READ, never a value: this returns a boolean, nothing is
 * stored, and nothing is logged. The stub has no use for the secret itself —
 * it does not call a model, which is the entire point of it.
 */
export function modelKeyConfigured() {
  if (MODEL_KEY_VARS.some((v) => !!process.env[v])) return true;
  try {
    const envPath = new URL("../../../.env", import.meta.url);
    const text = readFileSync(envPath, "utf8");
    return text
      .split(/\r?\n/)
      .some((line) => {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) return false;
        // A key present but EMPTY is not configured — `NVIDIA_API_KEY=` is
        // what a half-finished setup looks like, and calling it configured
        // sends the reader to the wrong branch of the message.
        return MODEL_KEY_VARS.includes(m[1]) && m[2].trim().length > 0;
      });
  } catch {
    // No .env, unreadable, wrong cwd — absence of evidence. Falls back to the
    // process env answer, which is what this did before.
    return false;
  }
}

/**
 * @param {{ hasKey?: boolean }} [over] — override the key check.
 *
 * INJECTABLE BECAUSE THE CHECK READS A FILE, and a function whose answer
 * depends on an untracked file is not testable in isolation: it returns one
 * thing on a machine with a .env and another in CI, so a test either passes
 * for the wrong reason or fails for one. Two existing cases broke the moment
 * the file read was added, and they were right to.
 *
 * The default is the composed check; callers that want to pin the decision
 * pass it. Production passes nothing.
 */
export function resolveMode(over) {
  const hasKey = over?.hasKey ?? modelKeyConfigured();
  if (!hasKey) {
    // Named for the QUESTION, not for one answer to it. `no-openrouter-api-key`
    // was a reason string that could only ever be right about one provider.
    return { mode: "canned", reason: "no-model-api-key" };
  }
  // A key is present. Whether a MODEL ACTUALLY ANSWERS is decided by the code
  // that serves the run, at the moment it serves it — `resolveMode` cannot
  // know, and claiming `live` from a key would be exactly the misattribution
  // this module exists to prevent. See `resolveServedMode` below.
  return { mode: "canned", reason: "live-graph-not-configured" };
}

/**
 * The mode to REPORT for a run that has already been served.
 *
 * Separate from `resolveMode` on purpose. That function answers "what will
 * probably happen", from configuration, before anything is served. This one
 * answers "what did happen", and only it may say `live` — the module's opening
 * comment is explicit that a key says what was requested, not what answered.
 *
 * @param {{ modelAnswered: boolean, detail?: string }} outcome
 */
export function resolveServedMode(outcome) {
  // STRICTLY `true`, not merely truthy. This decides a banner asserting that a
  // real agent produced what you are reading, and `live` is the claim that
  // cannot be walked back. A caller passing a string, a count, or anything it
  // has not thought about must land on `canned`, which claims less. Caught by
  // its own test: `{ modelAnswered: "yes" }` returned `live`.
  if (outcome?.modelAnswered === true) {
    return { mode: "live", reason: outcome.detail ?? "model-answered" };
  }
  return resolveMode();
}

export function stampMode(headers, m) {
  headers[AGENT_MODE_HEADER] = m.mode;
  headers[AGENT_MODE_REASON_HEADER] = m.reason;
  return headers;
}
