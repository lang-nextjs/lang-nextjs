import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { describeProvenance, type AgentProvenance } from "./agent-mode";
import { resolveMode } from "../agent/mode.mjs";

/**
 * WHICH KEY THE APP TELLS YOU TO SET.
 *
 * Reported from a real run: a user with NVIDIA_API_KEY configured — the free
 * provider this repo recommends — was shown
 *
 *     "Set OPENROUTER_API_KEY to run against a real model once a graph is
 *      configured."
 *
 * `resolveMode` read `!!process.env.OPENROUTER_API_KEY` alone, while the actual
 * resolution order is NVIDIA -> OpenRouter -> Anthropic (`make_llm` in both
 * backends, and lib/readiness.ts, which already named all three).
 *
 * The verdict was never wrong — the run genuinely IS canned until a graph is
 * wired, and saying so is the whole point of this module. What was wrong was
 * the REASON, and therefore the remedy offered: it sent you to fix a key you do
 * not need while ignoring the one you have.
 *
 * These assert the message a user actually reads, because that is where the
 * defect lived. Asserting only `mode === "canned"` passes on both the old and
 * new code and would not have caught it.
 */

const KEYS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveMode — every provider in the chain counts", () => {
  it.each(KEYS)("treats %s as a model key", (key) => {
    // THE REGRESSION. Before the fix only OPENROUTER_API_KEY moved this, so
    // NVIDIA and ANTHROPIC users got the no-key branch and its wrong remedy.
    process.env[key] = "set-for-test";
    expect(resolveMode().reason).toBe("live-graph-not-configured");
  });

  it("reports no-model-api-key when NONE of the three is set", () => {
    expect(resolveMode().reason).toBe("no-model-api-key");
  });

  it("still says canned in BOTH cases — a key is not a graph", () => {
    // The verdict must not track the key. Claiming `live` because a key exists
    // is the misattribution agent/mode.mjs exists to prevent, and the fix to
    // the reason string must not weaken that.
    expect(resolveMode().mode).toBe("canned");
    process.env.NVIDIA_API_KEY = "set-for-test";
    expect(resolveMode().mode).toBe("canned");
  });

  it("the two reasons are distinguishable — the case is not vacuous", () => {
    const without = resolveMode().reason;
    process.env.NVIDIA_API_KEY = "set-for-test";
    const with_ = resolveMode().reason;
    expect(without).not.toBe(with_);
  });
});

describe("describeProvenance — the remedy it offers", () => {
  const canned = (reason: string): AgentProvenance =>
    ({ mode: "canned", reason }) as AgentProvenance;

  it("names EVERY provider when no key is set, not just one", () => {
    const { detail } = describeProvenance(canned("no-model-api-key"));
    expect(detail).toContain("NVIDIA_API_KEY");
    expect(detail).toContain("OPENROUTER_API_KEY");
    expect(detail).toContain("ANTHROPIC_API_KEY");
  });

  it("points at the free provider, since that is the recommended path", () => {
    const { detail } = describeProvenance(canned("no-model-api-key"));
    expect(detail).toContain("build.nvidia.com");
  });

  it("does NOT name a single provider once a key is set", () => {
    // The header says a key exists; it does not say which. Naming one is a
    // guess, and guessing wrong is the original bug.
    const { detail } = describeProvenance(canned("live-graph-not-configured"));
    expect(detail).not.toContain("OPENROUTER_API_KEY");
    expect(detail).not.toContain("NVIDIA_API_KEY");
    expect(detail).toMatch(/model API key is set/i);
  });

  it("still labels the run as scripted in both canned cases", () => {
    for (const r of ["no-model-api-key", "live-graph-not-configured"]) {
      const d = describeProvenance(canned(r));
      expect(d.label).toMatch(/scripted/i);
      expect(d.tone).toBe("canned");
    }
  });

  it("a live run says so, and offers no key advice at all", () => {
    const d = describeProvenance({ mode: "live", reason: "x" } as AgentProvenance);
    expect(d.tone).toBe("live");
    expect(d.detail).not.toMatch(/API_KEY/);
  });

  it("an unidentified backend is UNKNOWN, not assumed canned", () => {
    // Absence of a header is not evidence of a scripted run. Same three-state
    // discipline as `tracing` and `llmConfigured`.
    const d = describeProvenance({ mode: "unknown" } as AgentProvenance);
    expect(d.tone).toBe("unknown");
  });
});
