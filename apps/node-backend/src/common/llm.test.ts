/**
 * `llmStatus()` must never disagree with `makeLlm()`.
 *
 * The Python note this is guarding is explicit: "MIRRORS make_llm()'s FALLBACK
 * ORDER and must keep mirroring it. If that chain changes and this does not,
 * the UI gets a confident wrong answer, which is worse than the no answer it
 * had before." Two functions asked to encode one ordering is a drift waiting to
 * happen, and the readiness indicator is downstream of the one that drifts.
 *
 * So this asserts them against EACH OTHER over every subset of the three keys,
 * rather than asserting each against a literal. A literal on both sides would
 * be satisfied by changing the literal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { llmStatus, makeLlm } from "./llm.js";

const KEYS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"] as const;
const saved = { ...process.env };

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, saved);
});

/** Which provider a built model actually belongs to, by its own class + base URL. */
function providerOf(model: unknown): string {
  const m = model as {
    constructor: { name: string };
    clientConfig?: { baseURL?: string };
  };
  if (m.constructor.name === "ChatAnthropic") return "anthropic";
  const base = m.clientConfig?.baseURL ?? "";
  if (base.includes("integrate.api.nvidia.com")) return "nvidia";
  if (base.includes("openrouter.ai")) return "openrouter";
  return `unknown(${m.constructor.name}, ${base})`;
}

describe("llmStatus mirrors makeLlm", () => {
  // All 8 subsets, so the ORDER is pinned and not just the presence rule.
  for (let mask = 0; mask < 8; mask++) {
    const present = KEYS.filter((_, i) => (mask >> i) & 1);
    it(`keys present: [${present.join(", ") || "none"}]`, () => {
      for (const k of KEYS) delete process.env[k];
      for (const k of present) process.env[k] = "test-key";

      const status = llmStatus(process.env);

      if (present.length === 0) {
        // No key at all: status says so. makeLlm still RETURNS a model (the
        // Anthropic branch is unconditional) — it fails on use, not on
        // construction. That asymmetry is real in the Python too and is why
        // `configured` is computed rather than inferred from a build.
        expect(status).toEqual({ configured: false, provider: null });
        return;
      }

      expect(status.configured).toBe(true);
      expect(
        providerOf(makeLlm()),
        "llmStatus named a different provider than makeLlm would build"
      ).toBe(status.provider);
    });
  }
});
