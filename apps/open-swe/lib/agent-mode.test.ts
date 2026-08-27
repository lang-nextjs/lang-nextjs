import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  REASON_IN_PROGRESS,
  describeProvenance,
  readProvenance,
  type AgentProvenance,
} from "./agent-mode";
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
    // `hasKey: false` is PASSED rather than assumed from an empty environment.
    // resolveMode also consults the repo-root .env — a key set there is
    // configured for this repo even when nothing exported it to this process,
    // which is the case the banner used to get wrong. That makes the bare call
    // depend on an untracked file: it answers one way on a machine with a .env
    // and another in CI. This case broke the day that read was added, and was
    // right to.
    expect(resolveMode({ hasKey: false }).reason).toBe("no-model-api-key");
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
    const without = resolveMode({ hasKey: false }).reason;
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

/**
 * A RUN IN FLIGHT HAS NOT ANSWERED "WHAT MADE THIS".
 *
 * Reported after #282 gave the queue a live path: a run displayed
 *
 *   Scripted run — no LLM was called
 *
 * while it was calling one, then flipped to "Live agent run" when it finished.
 *
 * The banner fell back to `resolveMode()` — a prediction from configuration,
 * and always `canned`, because a key does not wire a graph. That fallback is a
 * POSITIVE CLAIM, and it was false for the whole time it was on screen.
 *
 * "Not yet determined" is a third thing, and the module already had a state for
 * not knowing. What it lacked was the ability to tell "I do not know YET" from
 * "this backend never identified itself" — one resolves in seconds, the other
 * never will.
 */
describe("provenance while a run is still going", () => {
  it("IN PROGRESS IS NOT REPORTED AS SCRIPTED", () => {
    // The reported bug. Anything claiming no LLM was called is wrong here.
    const d = describeProvenance({
      mode: "unknown",
      reason: REASON_IN_PROGRESS,
    });
    expect(d.label).not.toMatch(/scripted/i);
    expect(d.detail).not.toMatch(/no LLM was called/i);
  });

  it("and NOT as live either — nothing has answered yet", () => {
    // The other direction, which would be worse: claiming a real agent
    // produced output that does not exist yet.
    const d = describeProvenance({
      mode: "unknown",
      reason: REASON_IN_PROGRESS,
    });
    expect(d.label).not.toMatch(/live/i);
    expect(d.tone).toBe("unknown");
  });

  it("says it is still running, and that the answer is coming", () => {
    const d = describeProvenance({
      mode: "unknown",
      reason: REASON_IN_PROGRESS,
    });
    expect(d.label).toMatch(/still running/i);
    expect(d.detail).toMatch(/once it finishes|in progress/i);
  });

  it("IS DISTINCT FROM a backend that never identified itself", () => {
    // Both are `unknown`, and they call for different actions: one is a wait,
    // the other is a configuration problem that will not resolve on its own.
    const inProgress = describeProvenance({
      mode: "unknown",
      reason: REASON_IN_PROGRESS,
    });
    const silent = describeProvenance({ mode: "unknown" });
    expect(inProgress.label).not.toBe(silent.label);
    expect(inProgress.detail).not.toBe(silent.detail);
    expect(silent.detail).toMatch(/did not identify itself/i);
  });

  it("the reason survives readProvenance for an unknown mode", () => {
    // The wiring. Dropping it here — which is what the parser used to do —
    // makes every unknown look like a silent backend, and the banner goes back
    // to being wrong in a different way.
    const h = new Headers({
      "x-openswe-agent-mode": "something-else",
      "x-openswe-agent-mode-reason": REASON_IN_PROGRESS,
    });
    expect(readProvenance(h)).toEqual({
      mode: "unknown",
      reason: REASON_IN_PROGRESS,
    });
  });

  it("a genuinely absent header still yields a bare unknown", () => {
    // No reason invented when none was sent.
    expect(readProvenance(new Headers())).toEqual({ mode: "unknown" });
  });
});
