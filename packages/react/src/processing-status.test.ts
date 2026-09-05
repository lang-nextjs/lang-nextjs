import { describe, expect, it } from "vitest";
import {
  deriveProcessingSignals,
  formatElapsed,
  processingDetail,
  processingVerb,
  shouldShowProcessing,
  tokenSegment,
} from "./processing-status";

/**
 * #231's acceptance criteria, each as an assertion.
 *
 * The controls come first, because two of them are the criteria that carry the
 * feature's meaning: an indicator that is always on is not an indicator, and a
 * token count that is invented is worse than one that is absent.
 */

describe("criterion 1 + the control — it appears in the dead air, and only there", () => {
  it("CONTROL: idle shows nothing. An indicator that is always on is not one", () => {
    expect(shouldShowProcessing({ status: "idle" })).toBe(false);
  });

  it("submitted — the dead air — DOES show", () => {
    // This is the whole gap: before the first token there is no assistant
    // bubble, so the caret indicator rendered nothing here.
    expect(shouldShowProcessing({ status: "submitted" })).toBe(true);
  });

  it("streaming still shows, so the row is replaced by the reply rather than flickering", () => {
    expect(shouldShowProcessing({ status: "streaming" })).toBe(true);
  });

  it("criterion 7: error shows nothing — the error card owns that moment", () => {
    // Two things claiming the same moment is worse than one.
    expect(shouldShowProcessing({ status: "error" })).toBe(false);
  });
});

describe("criterion 2 — the verb is derived from state, never decorative", () => {
  it("submitted with no frames yet is Thinking", () => {
    expect(processingVerb({ status: "submitted" })).toBe("Thinking");
  });

  it("streaming text is Writing", () => {
    expect(processingVerb({ status: "streaming", hasText: true })).toBe(
      "Writing"
    );
  });

  it("streaming with no text yet is still Thinking, not Writing", () => {
    // Claiming "Writing" before a token has arrived would be the row asserting
    // something it has not observed.
    expect(processingVerb({ status: "streaming", hasText: false })).toBe(
      "Thinking"
    );
  });

  it.each([
    ["read_file", "Reading"],
    ["cat", "Reading"],
    ["web_search", "Searching"],
    ["grep", "Searching"],
    ["write_file", "Writing files"],
    ["edit_file", "Writing files"],
  ])("a %s tool in flight reads as %s", (tool, verb) => {
    expect(processingVerb({ status: "streaming", activeTool: tool })).toBe(
      verb
    );
  });

  it("an unrecognised tool is NAMED rather than guessed at", () => {
    // Inventing a verb for a tool we do not recognise is exactly the decorative
    // mapping this criterion forbids. Saying its name is always true.
    expect(
      processingVerb({ status: "streaming", activeTool: "increment" })
    ).toBe("Running increment");
  });

  it("a tool in flight outranks text — it is the more specific true statement", () => {
    expect(
      processingVerb({ status: "streaming", hasText: true, activeTool: "grep" })
    ).toBe("Searching");
  });
});

describe("criterion 3 — the duration formats at the boundaries the issue names", () => {
  it.each([
    [0, "0s"],
    [8_000, "8s"],
    [59_000, "59s"],
    [60_000, "1m 00s"],
    [64_000, "1m 04s"],
    [958_000, "15m 58s"],
    [3_600_000, "60m 00s"],
  ])("%dms renders as %s", (ms, out) => {
    expect(formatElapsed(ms)).toBe(out);
  });

  it("seconds are padded only once minutes are present", () => {
    // `04s` alone reads as a stopwatch fragment; `1m 04s` reads as a duration.
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(64_000)).toBe("1m 04s");
  });

  it("a negative elapsed clamps to zero rather than rendering a minus", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("criterion 4 — unmeasured tokens are ABSENT, never zeroed", () => {
  it.each([undefined, null, {}, { outputTokens: undefined }])(
    "no usage (%o) yields null, not a zero",
    (usage) => {
      expect(tokenSegment(usage as never)).toBeNull();
    }
  );

  it("the detail line is the duration ALONE when usage is unmeasured", () => {
    // The shape the issue specifies for today: `✶ Thinking… (15m 58s)`.
    expect(processingDetail(958_000)).toBe("15m 58s");
    expect(processingDetail(958_000)).not.toContain("token");
  });

  it("a MEASURED zero is rendered — suppressing it is the same error reversed", () => {
    // A zero meaning "not measured" and a zero meaning "measured, and it was
    // zero" are different facts. Hiding the second to avoid the first would
    // recreate the confusion from the other side.
    expect(tokenSegment({ outputTokens: 0 })).toBe("↓ 0 tokens");
  });

  it("formats thousands the way the issue writes them", () => {
    expect(tokenSegment({ outputTokens: 8_500 })).toBe("↓ 8.5k tokens");
    expect(tokenSegment({ outputTokens: 999 })).toBe("↓ 999 tokens");
    expect(tokenSegment({ outputTokens: 42_000 })).toBe("↓ 42k tokens");
  });

  it("a non-finite count is treated as unmeasured, not printed", () => {
    expect(tokenSegment({ outputTokens: NaN })).toBeNull();
    expect(tokenSegment({ outputTokens: Infinity })).toBeNull();
  });

  it("with usage present the detail carries both segments", () => {
    expect(processingDetail(958_000, { outputTokens: 8_500 })).toBe(
      "15m 58s · ↓ 8.5k tokens"
    );
  });
});

/**
 * #790 — the DERIVATION, which is where the defect actually was.
 *
 * `processingVerb` was correct and its test ("streaming with no text yet is still Thinking,
 * not Writing") passed the whole time, because it calls the function directly. The wrong
 * value was computed by the caller and no test could reach it. These arms hold the thing
 * that was broken.
 */
describe("deriveProcessingSignals — hasText is about CONTENT, not existence", () => {
  const caret = { type: "ai", content: "" };
  const text = { type: "ai", content: "Sorting algorithms are…" };
  const running = {
    type: "tool-call",
    toolName: "web_search",
    status: "running",
  };
  const done = { type: "tool-call", toolName: "read_file", status: "complete" };

  it("an EMPTY ai bubble is not text — the exact #790 defect", () => {
    // The converter emits this caret bubble for a turn with only tool parts. The old
    // call site asked `messages.some(m => m.type === "ai")`, which this satisfies, and
    // the row then said "Writing…" with no token having arrived.
    expect(deriveProcessingSignals([caret]).hasText).toBe(false);
  });

  it("...and a NON-empty one is (the companion)", () => {
    expect(deriveProcessingSignals([text]).hasText).toBe(true);
  });

  it("a RUNNING TOOL outranks the caret — the verb is Searching, not the text branch at all", () => {
    // NAMED FOR WHAT IT ASSERTS. This said "is Thinking, not Writing", which it does not
    // test: with a running tool `processingVerb` returns from the `activeTool` branch before
    // it ever reads `hasText`. It is also one of the two arms that SURVIVES the hasText
    // mutation, so the old name over-claimed exactly where the coverage is weakest.
    const signals = deriveProcessingSignals([running, caret]);
    expect(processingVerb({ status: "streaming", ...signals })).not.toBe(
      "Writing"
    );
    expect(processingVerb({ status: "streaming", ...signals })).toBe(
      "Searching"
    );
  });

  it("activeTool is the RUNNING one, not a finished one", () => {
    expect(deriveProcessingSignals([done]).activeTool).toBeUndefined();
    expect(deriveProcessingSignals([running]).activeTool).toBe("web_search");
  });

  it("the LAST running tool wins — it is the one being waited on", () => {
    const first = {
      type: "tool-call",
      toolName: "read_file",
      status: "running",
    };
    expect(deriveProcessingSignals([first, running]).activeTool).toBe(
      "web_search"
    );
  });

  it("a terminal tool does not linger as the active one (the companion)", () => {
    expect(deriveProcessingSignals([running, done, caret]).activeTool).toBe(
      "web_search"
    );
    expect(
      deriveProcessingSignals([
        { type: "tool-call", toolName: "web_search", status: "error" },
      ]).activeTool
    ).toBeUndefined();
  });
});
