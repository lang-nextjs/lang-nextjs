/**
 * The four-state integration semantic — and the cases that decide it are the negative ones.
 *
 * THE BUG THIS EXISTS TO PREVENT, WHICH IS LIVE TODAY. `_common.py` computes
 *
 *     "langsmith": { "configured": langsmith_on and langsmith_key,
 *                    "tracing":    langsmith_on and langsmith_key }   <- SAME EXPRESSION
 *
 * so `tracing: true` for LangSmith means *two environment variables are set*. Nothing has
 * watched a span arrive. Rendering that as a tick is a green light for a verdict nothing
 * computed — the exact defect that started this work, and PRODUCT's requirement in nine
 * words: otherwise the panel launders inference as observation.
 *
 * WHY FOUR STATES AND NOT THREE. PRODUCT specified three, then corrected to four:
 * "never probed" and "probed and failed" are DIFFERENTLY ACTIONABLE. The first may just need
 * triggering; the second means something is broken. Collapsing them loses the distinction
 * that tells an operator what to do next, which is the only reason the panel exists.
 *
 * AND LANGFUSE IS THE MODEL, NOT THE EXCEPTION. It reports `tracing: false` with keys
 * present, because no handler is wired. So the integration behaving CORRECTLY currently looks
 * worse than the one that is lying, and an operator reading today's data would draw exactly
 * the wrong conclusion about which to trust.
 */
import { describe, it, expect } from "vitest";
import {
  computeIntegrationStatus,
  toneFor,
  type IntegrationInput,
} from "./integration-status";

const input = (over: Partial<IntegrationInput> = {}): IntegrationInput => ({
  supported: true,
  configured: true,
  tracing: null,
  ...over,
});

describe("computeIntegrationStatus", () => {
  // --- THE REGRESSION THAT MATTERS MOST -------------------------------------------------
  it("LangSmith with both env vars set and no span ever sent is NOT a tick", () => {
    // The live-and-wrong case: the backend reports tracing:true from the same expression as
    // configured. Once `tracing` is honest, "keys are set" must surface as unverified.
    const s = computeIntegrationStatus(input({ configured: true, tracing: null }));
    expect(s.state).toBe("unverified");
    expect(toneFor(s.state)).not.toBe("positive");
  });

  it("distinguishes never-probed from probed-and-failed", () => {
    // PRODUCT's correction. These are differently actionable and must not collapse.
    const never = computeIntegrationStatus(input({ tracing: null }));
    const failed = computeIntegrationStatus(input({ tracing: false }));
    expect(never.state).toBe("unverified");
    expect(failed.state).toBe("failed");
    expect(never.state).not.toBe(failed.state);
    expect(toneFor(never.state)).not.toBe(toneFor(failed.state));
  });

  it("only an accepted span is verified", () => {
    const s = computeIntegrationStatus(input({ tracing: true }));
    expect(s.state).toBe("verified");
    expect(toneFor(s.state)).toBe("positive");
  });

  it("no key is not-configured, and that is not a failure", () => {
    // Not having set something up is not an alarm. False alarms are how operators learn to
    // stop reading a panel — the same way a permanently-red CI job trains a team to ignore
    // the suite.
    const s = computeIntegrationStatus(input({ configured: false }));
    expect(s.state).toBe("not-configured");
    expect(toneFor(s.state)).not.toBe("negative");
  });

  it("an unsupported integration explains itself and is never red", () => {
    // Langfuse today. `supported` is a BUILD-TIME literal in _common.py — nothing opens a
    // socket — so it gates whether the row applies, never what colour it is.
    const s = computeIntegrationStatus(input({ supported: false, configured: true }));
    expect(s.state).toBe("unsupported");
    expect(toneFor(s.state)).not.toBe("negative");
    expect(toneFor(s.state)).not.toBe("positive");
  });

  it("unsupported outranks a tracing claim", () => {
    // If a build cannot send spans, `tracing: true` from that build is not evidence of
    // anything. Applicability is answered before the runtime fact is believed.
    const s = computeIntegrationStatus(input({ supported: false, tracing: true }));
    expect(s.state).toBe("unsupported");
  });

  // --- NOTHING DEFAULTS TO GREEN -------------------------------------------------------
  it("no state maps to positive except verified", () => {
    // The default-to-green trap, asserted rather than assumed. Derived over every state so a
    // new one cannot quietly inherit a healthy tone.
    const states = [
      "unsupported",
      "not-configured",
      "unverified",
      "failed",
      "verified",
    ] as const;
    const positive = states.filter((s) => toneFor(s) === "positive");
    expect(positive).toEqual(["verified"]);
  });

  it("every state carries a reason a human can act on", () => {
    // A panel that says "failed" without saying what to do is a status, not an instruction.
    for (const tracing of [true, false, null] as const) {
      for (const configured of [true, false]) {
        for (const supported of [true, false]) {
          const s = computeIntegrationStatus({ supported, configured, tracing });
          expect(s.detail.length, `${supported}/${configured}/${tracing}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("prefers the backend's own detail — it knows more than three booleans do", () => {
    // Verified against the LIVE backend, which distinguishes "Langfuse refused the keys"
    // from "the SDK is missing". Neither is derivable here, and both tell an operator what
    // to do next.
    const s = computeIntegrationStatus(
      input({ tracing: false, detail: "keys set, but Langfuse refused them" })
    );
    expect(s.state).toBe("failed");
    expect(s.detail).toBe("keys set, but Langfuse refused them");
  });

  it("falls back to our own detail when the backend omits or blanks it", () => {
    for (const detail of [undefined, null, "   "]) {
      const s = computeIntegrationStatus(input({ tracing: false, detail }));
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.detail).not.toBe(detail);
    }
  });
});
