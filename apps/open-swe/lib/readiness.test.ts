import { describe, it, expect } from "vitest";
import {
  canSend,
  computeReadiness,
  toneForReadiness,
  type ReadinessInput,
  type ReadinessState,
} from "./readiness";

const base: ReadinessInput = {
  llmConfigured: true,
  sandboxRequired: false,
  sandboxAvailable: null,
  streamStatus: "idle",
};
const r = (over: Partial<ReadinessInput> = {}) =>
  computeReadiness({ ...base, ...over });

describe("THE BUG: idle must not read as ready", () => {
  it("is NOT ready when no API key is configured, even though idle", () => {
    const out = r({ llmConfigured: false, streamStatus: "idle" });
    expect(out.state).toBe("blocked");
    expect(out.state).not.toBe("ready");
    expect(canSend(out)).toBe(false);
  });

  it("names the missing key and where to get a free one", () => {
    const out = r({ llmConfigured: false });
    expect(out.reasons.join(" ")).toMatch(/NVIDIA_API_KEY/);
    expect(out.reasons.join(" ")).toMatch(/build\.nvidia\.com/);
  });

  it("is NOT ready when a sandbox is required and none is available", () => {
    const out = r({ sandboxRequired: true, sandboxAvailable: false });
    expect(out.state).toBe("blocked");
    expect(canSend(out)).toBe(false);
  });

  it("blocked outranks busy — a stream running toward failure is not 'busy'", () => {
    const out = r({ llmConfigured: false, streamStatus: "streaming" });
    expect(out.state).toBe("blocked");
  });
});

describe("prerequisites are reported together", () => {
  it("lists EVERY unmet prerequisite, not just the first", () => {
    const out = r({
      llmConfigured: false,
      sandboxRequired: true,
      sandboxAvailable: false,
    });
    expect(out.reasons).toHaveLength(2);
    expect(out.reasons.join(" ")).toMatch(/API key/i);
    expect(out.reasons.join(" ")).toMatch(/sandbox/i);
  });

  it("says nothing about the sandbox when the surface does not need one", () => {
    const out = r({ sandboxRequired: false, sandboxAvailable: false });
    expect(out.reasons.join(" ")).not.toMatch(/sandbox/i);
    expect(out.state).toBe("ready");
  });
});

describe("an in-flight probe is not evidence of readiness", () => {
  it("reports unknown while the LLM probe is pending", () => {
    const out = r({ llmConfigured: null });
    expect(out.state).toBe("unknown");
    expect(canSend(out)).toBe(false);
  });

  it("reports unknown while a REQUIRED sandbox probe is pending", () => {
    const out = r({ sandboxRequired: true, sandboxAvailable: null });
    expect(out.state).toBe("unknown");
  });

  it("ignores a pending sandbox probe when no sandbox is needed", () => {
    expect(r({ sandboxRequired: false, sandboxAvailable: null }).state).toBe(
      "ready"
    );
  });

  it("distinguishes 'probing' from 'absent' — null is not false", () => {
    expect(r({ llmConfigured: null }).state).toBe("unknown");
    expect(r({ llmConfigured: false }).state).toBe("blocked");
  });
});

describe("live status", () => {
  it("surfaces a stream error above everything", () => {
    const out = r({ streamStatus: "error", llmConfigured: false });
    expect(out.state).toBe("error");
  });

  it("reports busy for each streaming-ish status", () => {
    for (const s of ["streaming", "connecting", "submitted", "loading"]) {
      expect(r({ streamStatus: s }).state).toBe("busy");
    }
  });

  it("is ready — and sendable — only when everything checks out", () => {
    const out = r({
      llmConfigured: true,
      sandboxRequired: true,
      sandboxAvailable: true,
      streamStatus: "idle",
    });
    expect(out.state).toBe("ready");
    expect(canSend(out)).toBe(true);
  });

  it("canSend is false for every non-ready state", () => {
    for (const over of [
      { llmConfigured: false },
      { llmConfigured: null },
      { streamStatus: "error" },
      { streamStatus: "streaming" },
      { sandboxRequired: true, sandboxAvailable: false },
    ] as Partial<ReadinessInput>[]) {
      expect(canSend(r(over))).toBe(false);
    }
  });
});

/**
 * NOTHING DEFAULTS TO GREEN (PRODUCT's case 4).
 *
 * The dot in chat/page.tsx mapped state to colour with a ternary chain ending
 * `: "bg-success"`. That was correct only because ReadinessState has five members and the
 * else was reachable solely by "ready" — **defused by accident, not by construction. Add a
 * sixth state and it ships HEALTHY**, which is the exact defect the indicator exists to fix,
 * one state over.
 *
 * `describeDependency` in lib/dependency-status.ts already solved this for the dependency
 * union and imports assertNever from packages/rungs rather than re-declaring it. This is that
 * pattern carried to the readiness union — the call site it had not reached. A lesson recorded
 * at one call site does not travel to the next unless a person carries it.
 */
describe("toneForReadiness", () => {
  it("only 'ready' is a success tone", () => {
    // Derived over every member, so a new state cannot quietly inherit a healthy tone. A
    // hand-listed expectation here would rot the moment the union grew.
    const states: ReadinessState[] = [
      "blocked",
      "error",
      "busy",
      "ready",
      "unknown",
    ];
    expect(states.filter((s) => toneForReadiness(s) === "success")).toEqual([
      "ready",
    ]);
  });

  it("busy is not healthy and not broken", () => {
    // The original bug in one line: "the UI is not busy" was read as "the system is ready".
    // Busy is activity, so it must be neither the success tone nor the failure tone.
    const t = toneForReadiness("busy");
    expect(t).not.toBe("success");
    expect(t).not.toBe("destructive");
  });

  it("unknown — a probe in flight — is not success", () => {
    // An absence of evidence must never render as evidence of health.
    expect(toneForReadiness("unknown")).not.toBe("success");
  });

  it("blocked and error are both failure tones", () => {
    expect(toneForReadiness("blocked")).toBe("destructive");
    expect(toneForReadiness("error")).toBe("destructive");
  });

  it("returns a Tone from dependency-status, not a new vocabulary", () => {
    // PRODUCT's one-home requirement: this reuses the existing Tone union rather than
    // introducing a second colour vocabulary for the same idea.
    const valid = ["success", "destructive", "muted", "info"];
    for (const s of [
      "blocked",
      "error",
      "busy",
      "ready",
      "unknown",
    ] as ReadinessState[]) {
      expect(valid).toContain(toneForReadiness(s));
    }
  });
});

/**
 * A STOPPED BACKEND IS NOT A MISSING KEY.
 *
 * Reported as: "how come open-swe doesn't see our nvidia key". It did not see
 * it because it never looks — and nothing was wrong with the key:
 *
 *   .env (repo root)   NVIDIA_API_KEY set
 *   backend :8001      STOPPED (Ctrl-C on `pnpm dev` stops what it started)
 *   /api/config        activeLlm: null, llmSource: "local-env"
 *   the banner         "No model API key configured — set NVIDIA_API_KEY…"
 *
 * open-swe asks the BACKEND, which reads the key through docker's env_file,
 * and that indirection is correct: a key present only in this process would
 * read as configured while every completion failed. But when the process that
 * would know cannot be reached, "no key is configured" is a verdict nobody
 * computed — the same defect shape this module's own header was written about.
 *
 * `llmSource` was in the payload the whole time and nothing read it.
 */
describe("what a `false` about the model actually means", () => {
  const base = {
    sandboxRequired: false,
    sandboxAvailable: null,
    streamStatus: "idle",
  } as const;

  it("BACKEND SAID NO -> tell them to set a key", () => {
    // The backend answered. There genuinely is no key, and naming the
    // variables is the useful thing to say.
    const r = computeReadiness({
      ...base,
      llmConfigured: false,
      llmSource: "backend",
    });
    expect(r.state).toBe("blocked");
    expect(r.reasons[0]).toMatch(/NVIDIA_API_KEY/);
  });

  it("COULD NOT ASK -> name the backend, not the key", () => {
    // The reported case. Blaming the key sends someone to check a file that
    // is already correct, which is the specific waste this fixes.
    const r = computeReadiness({
      ...base,
      llmConfigured: false,
      llmSource: "local-env",
    });
    expect(r.reasons[0]).toMatch(/backend isn't answering/i);
    expect(r.reasons[0]).not.toMatch(/set NVIDIA_API_KEY/);
  });

  it("the two messages are DIFFERENT, so neither can be quietly merged", () => {
    const asked = computeReadiness({
      ...base,
      llmConfigured: false,
      llmSource: "backend",
    }).reasons[0];
    const unasked = computeReadiness({
      ...base,
      llmConfigured: false,
      llmSource: "local-env",
    }).reasons[0];
    expect(asked).not.toBe(unasked);
  });

  it("an unknown source keeps the original message", () => {
    // Older payloads, and the in-flight case. Falling back to the key advice
    // is the safe direction: it is what this said before, and it is right
    // whenever the backend did answer.
    for (const src of [undefined, null] as const) {
      const r = computeReadiness({
        ...base,
        llmConfigured: false,
        llmSource: src,
      });
      expect(r.reasons[0]).toMatch(/NVIDIA_API_KEY/);
    }
  });

  it("STILL BLOCKED EITHER WAY — the state does not soften", () => {
    // The message changes; the verdict must not. A surface that cannot reach
    // a model is not ready, whichever of the two reasons applies, and
    // downgrading the unreachable case to "unknown" would re-enable a
    // composer that is going to fail on send.
    for (const src of ["backend", "local-env"] as const) {
      expect(
        computeReadiness({ ...base, llmConfigured: false, llmSource: src })
          .state
      ).toBe("blocked");
    }
  });

  it("the source is irrelevant while the probe is still in flight", () => {
    // null means "not known yet" and must stay distinct from false — the
    // distinction this module's header exists to protect.
    for (const src of ["backend", "local-env", null] as const) {
      const r = computeReadiness({
        ...base,
        llmConfigured: null,
        llmSource: src,
      });
      expect(r.state).not.toBe("blocked");
    }
  });

  it("a live stream error still outranks both", () => {
    // The precedence rule already in this file, asserted against the new
    // branch so adding a reason cannot reorder it.
    const r = computeReadiness({
      ...base,
      llmConfigured: false,
      llmSource: "local-env",
      streamStatus: "error",
    });
    expect(r.state).toBe("error");
  });
});

/**
 * A REASON IS RENDERED AS-IS, INTO A SMALL BOX.
 *
 * `readiness.reasons` reaches the screen as `{why}` inside a <li>, on two
 * surfaces, with no formatter between. So a reason written like documentation
 * arrives as documentation: the first version of the unreachable-backend
 * message was three sentences of architecture — where the key lives, which
 * process reads it, what Ctrl-C does — and it carried markdown backticks
 * around `pnpm dev` that reached the screen as literal backticks.
 *
 * These guard every reason, present and future, because the mistake is easy
 * to repeat and invisible in a unit test that only checks the text is right.
 */
describe("every reason is fit to render", () => {
  const everyReason = (): string[] => {
    const out: string[] = [];
    for (const llmSource of ["backend", "local-env", null] as const) {
      for (const sandboxRequired of [true, false]) {
        out.push(
          ...computeReadiness({
            llmConfigured: false,
            llmSource,
            sandboxRequired,
            sandboxAvailable: false,
            streamStatus: "idle",
          }).reasons
        );
      }
    }
    return [...new Set(out)];
  };

  it("CARRIES NO MARKDOWN — it is not rendered as markdown", () => {
    // Backticks, bold, and link syntax all reach the screen verbatim.
    //
    // BARE UNDERSCORES ARE NOT MARKDOWN HERE, and the first version of this
    // check said they were — it failed on "set NVIDIA_API_KEY", which is a
    // variable name and exactly what that message should say. A guard that
    // forbids the correct text is worse than none: the obvious response is to
    // mangle the message to satisfy it.
    for (const why of everyReason()) {
      expect(why, why.slice(0, 40)).not.toMatch(/`|\*\*|\[.+\]\(.+\)/);
    }
  });

  it("stays short enough for a banner", () => {
    // Not a style preference: this renders inside a "Not ready to run" box
    // above a composer, and a paragraph there pushes the control off screen
    // on the phone viewport the app is now tested at.
    for (const why of everyReason()) {
      expect(why.length, why.slice(0, 40)).toBeLessThanOrEqual(180);
    }
  });

  it("names an action, so the box is not merely a diagnosis", () => {
    // Each reason must tell a person what to DO. "No model API key
    // configured" names the variables to set; the backend one names the
    // command to run.
    for (const why of everyReason()) {
      expect(why, why.slice(0, 40)).toMatch(/set |start |pnpm |run /i);
    }
  });

  it("reads as one or two sentences, not a paragraph", () => {
    for (const why of everyReason()) {
      const sentences = why.split(/[.!?]\s/).filter(Boolean).length;
      expect(sentences, why.slice(0, 40)).toBeLessThanOrEqual(2);
    }
  });
});
