import { describe, it, expect } from "vitest";
import { canSend, computeReadiness, type ReadinessInput } from "./readiness";

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
