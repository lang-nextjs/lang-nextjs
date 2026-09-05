import { describe, expect, it } from "vitest";
import { GENERIC_TEXT, MAPPED_CODES, userFacingError } from "./error-copy";

/**
 * #262 names the control that carries the weight here:
 *
 *   "a control asserting the raw text does NOT reach the rendered output"
 *
 * Every positive assertion below would pass against a function that returned
 * the raw message unchanged, as long as the expected string happened to match.
 * The negative ones are what make this a test of the fix rather than of the
 * defect.
 */

const LEAK =
  "Upstream ended while an approval was still pending; releasing buffered frames";

describe("the raw upstream text never becomes user-facing copy", () => {
  it.each([...MAPPED_CODES, "some_code_nobody_mapped", ""])(
    "code %s: the rendered text is not the raw message",
    (code) => {
      const out = userFacingError(code, LEAK);
      expect(out.text).not.toBe(LEAK);
      expect(out.text).not.toContain("buffered frames");
      expect(out.text).not.toContain("Upstream ended");
    }
  );

  it("an unmapped code falls back to the generic line, NOT to the backend's words", () => {
    // Fail closed. A code added later that nobody maps must land here rather
    // than passing whatever the backend happened to say straight through.
    const out = userFacingError("a_code_added_next_year", LEAK);
    expect(out.text).toBe(GENERIC_TEXT);
  });

  it("a missing code also falls back, rather than rendering the message", () => {
    expect(userFacingError(null, LEAK).text).toBe(GENERIC_TEXT);
    expect(userFacingError(undefined, LEAK).text).toBe(GENERIC_TEXT);
  });
});

describe("the detail survives for the console", () => {
  it("the raw message is preserved on `detail`, not discarded", () => {
    // Suppressing the leak must not destroy the information. It moves; it does
    // not vanish — the message was the only record of the real cause.
    expect(userFacingError("approval_pending_at_close", LEAK).detail).toBe(
      LEAK
    );
    expect(userFacingError("nope", LEAK).detail).toBe(LEAK);
  });

  it("an empty or absent message yields a null detail, not an empty string", () => {
    expect(userFacingError("backend_error", "").detail).toBeNull();
    expect(userFacingError("backend_error", "   ").detail).toBeNull();
    expect(userFacingError("backend_error", null).detail).toBeNull();
  });
});

describe("known codes say something a person can act on", () => {
  it.each(MAPPED_CODES)(
    "%s has copy distinct from the generic line",
    (code) => {
      const out = userFacingError(code, LEAK);
      expect(out.text).not.toBe(GENERIC_TEXT);
      expect(out.text.length).toBeGreaterThan(10);
    }
  );

  it("a rejected approval is NOT offered as retryable", () => {
    // "Try again" after the person deliberately rejected an action is the app
    // arguing with them.
    expect(userFacingError("approval_rejected", null).retryable).toBe(false);
  });

  it("an action that already ran is NOT retryable — retrying would run it twice", () => {
    expect(
      userFacingError("tool_executed_without_approval", null).retryable
    ).toBe(false);
    expect(userFacingError("approval_pending_at_close", null).retryable).toBe(
      false
    );
  });

  it("a dropped connection IS retryable — nothing was decided", () => {
    expect(userFacingError("upstream_disconnect", null).retryable).toBe(true);
    expect(userFacingError("upstream_unreachable", null).retryable).toBe(true);
  });

  it("the codes the server actually emits are all mapped", () => {
    // Pinned against the emitters: packages/server/src/approval-gating.ts and
    // ai_backends/_common.py's _error_code. A new emitter that lands unmapped
    // still renders safely (generic), but this fails so it is a decision rather
    // than a default.
    for (const code of [
      "upstream_disconnect",
      "upstream_unreachable",
      "backend_error",
      "approval_rejected",
      "approval_timeout",
      "approval_pending_at_close",
      "tool_executed_without_approval",
    ]) {
      expect(MAPPED_CODES, `${code} is emitted but has no copy`).toContain(
        code
      );
    }
  });
});
