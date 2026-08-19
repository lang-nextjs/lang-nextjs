import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldDebug, logSseFrame } from "./debug";

afterEach(() => {
  delete process.env.DEBUG;
  vi.restoreAllMocks();
});

describe("shouldDebug", () => {
  it("returns true when DEBUG=deepagents:sse", () => {
    process.env.DEBUG = "deepagents:sse";
    expect(shouldDebug()).toBe(true);
  });

  it("returns false when DEBUG is undefined", () => {
    delete process.env.DEBUG;
    expect(shouldDebug()).toBe(false);
  });

  it("returns false when DEBUG is a different namespace", () => {
    process.env.DEBUG = "some:other";
    expect(shouldDebug()).toBe(false);
  });

  it("returns true when deepagents:sse is in a comma-separated DEBUG list", () => {
    process.env.DEBUG = "deepagents:sse,other:ns";
    expect(shouldDebug()).toBe(true);
  });

  it("returns false when DEBUG is wildcard * (exact match only)", () => {
    process.env.DEBUG = "*";
    expect(shouldDebug()).toBe(false);
  });

  it("returns false when namespace is a substring of a longer token (no partial match)", () => {
    // "notdeepagents:sse" contains "deepagents:sse" as a suffix — must NOT match
    process.env.DEBUG = "notdeepagents:sse";
    expect(shouldDebug()).toBe(false);
  });
});

describe("logSseFrame", () => {
  it("calls console.error with parsed JSON for a valid data line", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSseFrame({ raw: 'data: {"type":"text-delta","delta":"Hello"}' });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[deepagents:sse] frame: {"type":"text-delta","delta":"Hello"}'
    );
  });

  it("skips silently for [DONE] data line (not JSON)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logSseFrame({ raw: "data: [DONE]" })).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("skips silently when data line is not valid JSON", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      logSseFrame({ raw: "event: ping\ndata: not-json" })
    ).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("skips silently when frame has no data: line", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logSseFrame({ raw: "event: ping\n" })).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("uses only the first data: line when a frame contains multiple data: lines", () => {
    // SSE spec allows multi-line data fields via consecutive `data:` lines.
    // The implementation uses .find() which picks the FIRST match.
    // This test ensures the first data line is logged and no error is thrown even
    // when a second data line contains invalid JSON.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      logSseFrame({
        raw: 'data: {"type":"text-delta","delta":"A"}\ndata: not-json',
      })
    ).not.toThrow();
    // The first data line is valid JSON — it should be logged
    expect(consoleSpy).toHaveBeenCalledWith(
      '[deepagents:sse] frame: {"type":"text-delta","delta":"A"}'
    );
  });

  it("skips silently when data: line has an empty value (bare data: with no content)", () => {
    // Edge case: "data: " followed by nothing — jsonStr becomes "" which is not
    // valid JSON. The implementation should silently skip rather than throw.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logSseFrame({ raw: "data: " })).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
