// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ProcessingRow } from "./ProcessingRow";
import { deriveProcessingSignals } from "./processing-status";

/**
 * The component-level halves of #231 — the ones the pure logic cannot state:
 * that it is absent when idle, that the timer STOPS, and that the live region
 * announces the verb rather than the tick.
 */

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const T0 = 1_700_000_000_000;

type Props = React.ComponentProps<typeof ProcessingRow>;

function renderAt(props: Partial<Props>) {
  vi.setSystemTime(T0);
  const merged: Props = { status: "submitted", startedAt: T0, ...props };
  return render(<ProcessingRow {...merged} />);
}

describe("the control — absent unless something is happening", () => {
  it("renders NOTHING while idle", () => {
    renderAt({ status: "idle" });
    expect(screen.queryByTestId("processing-row")).toBeNull();
  });

  it("renders NOTHING on error — the error card owns that moment", () => {
    renderAt({ status: "error" });
    expect(screen.queryByTestId("processing-row")).toBeNull();
  });

  it("renders nothing when no start time is known, rather than counting from zero", () => {
    // A timer with no origin would show a duration it did not measure.
    renderAt({ status: "submitted", startedAt: null });
    expect(screen.queryByTestId("processing-row")).toBeNull();
  });

  it("renders in the dead air — submitted, before any text exists", () => {
    renderAt({ status: "submitted" });
    expect(screen.getByTestId("processing-row")).toBeTruthy();
    expect(screen.getByTestId("processing-row").getAttribute("data-verb")).toBe(
      "Thinking"
    );
  });
});

describe("the timer is honest at both ends", () => {
  it("ticks while visible", () => {
    renderAt({ status: "submitted" });
    expect(screen.getByTestId("processing-detail").textContent).toBe("(0s)");
    // `advanceTimersByTime` moves the mocked clock too, so calling
    // `setSystemTime` alongside it counts the interval twice.
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByTestId("processing-detail").textContent).toBe("(8s)");
  });

  it("STOPS when the turn ends — no interval survives the row", () => {
    const { rerender } = renderAt({ status: "streaming" });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId("processing-detail").textContent).toBe("(5s)");

    // Terminal. A counter that keeps climbing after the stream ended is
    // reporting activity that is not happening.
    rerender(<ProcessingRow status="idle" startedAt={T0} />);
    expect(screen.queryByTestId("processing-row")).toBeNull();
    expect(vi.getTimerCount(), "an interval outlived the row").toBe(0);
  });
});

describe("accessibility", () => {
  it("is a polite live region", () => {
    renderAt({ status: "submitted" });
    const row = screen.getByTestId("processing-row");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.getAttribute("aria-live")).toBe("polite");
  });

  it("the ticking duration is HIDDEN from the live region", () => {
    // The criterion this exists for: a timer re-announcing every second is
    // unusable with a screen reader. Only the verb may be announced.
    renderAt({ status: "submitted" });
    expect(
      screen.getByTestId("processing-detail").getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("the verb IS in the announced text", () => {
    renderAt({ status: "streaming", hasText: true });
    expect(screen.getByTestId("processing-row").textContent).toContain(
      "Writing"
    );
  });

  it("the decorative glyph animates only under motion-safe", () => {
    renderAt({ status: "submitted" });
    const glyph = screen.getByText("✶");
    expect(glyph.className).toContain("motion-safe:animate-pulse");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the token segment", () => {
  it("is absent when usage is not supplied — not zeroed", () => {
    renderAt({ status: "submitted" });
    expect(screen.getByTestId("processing-detail").textContent).not.toContain(
      "token"
    );
  });

  it("appears once usage exists", () => {
    renderAt({ status: "streaming", usage: { outputTokens: 8_500 } });
    expect(screen.getByTestId("processing-detail").textContent).toContain(
      "8.5k tokens"
    );
  });
});

/**
 * #790 — the COMPOSITION, which is the only place the defect existed.
 *
 * Three units were each correct: `processingVerb` refused to say "Writing" without text,
 * the converter emitted its caret as specified, and the row rendered what it was handed.
 * The screen still carried a false statement, because nothing asserted the three together.
 * This renders what the app renders.
 */
describe("#790 — what a person sees while a tool is running", () => {
  const CARET = { type: "ai", content: "" };
  const RUNNING = {
    type: "tool-call",
    toolName: "web_search",
    status: "running",
  };

  it("does NOT say Writing when the only ai bubble is an empty caret", () => {
    renderAt({
      status: "streaming",
      ...deriveProcessingSignals([RUNNING, CARET]),
    });
    expect(screen.queryByText(/Writing/)).toBeNull();
  });

  it("says Searching — the more specific TRUE thing about a web_search in flight", () => {
    renderAt({
      status: "streaming",
      ...deriveProcessingSignals([RUNNING, CARET]),
    });
    expect(screen.getByText(/Searching/)).toBeTruthy();
  });

  it("says Thinking when the tool has FINISHED and no token has arrived yet", () => {
    /*
     * THE ARM THAT ACTUALLY BITES `hasText`, and mutation testing is what found it.
     *
     * Restoring the old existence-proxy killed only the unit arm: the two arms above
     * survived, because `processingVerb` checks `activeTool` FIRST and returned
     * "Searching" whatever `hasText` said. A running tool MASKS the text defect — which
     * is the same masking that made "fix the caret" and "pass activeTool" each look like
     * a complete repair.
     *
     * With the tool COMPLETE and the turn still streaming, there is no activeTool to fall
     * back on, the caret is the only ai message, and the verb comes straight off hasText.
     * This is the state the old code called "Writing" with nothing written.
     */
    renderAt({
      status: "streaming",
      ...deriveProcessingSignals([
        { type: "tool-call", toolName: "web_search", status: "complete" },
        CARET,
      ]),
    });
    expect(screen.queryByText(/Writing/)).toBeNull();
    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it("still says Writing once a token has actually arrived (the companion)", () => {
    // Without this, "never says Writing" would pass a row that had lost the verb entirely.
    renderAt({
      status: "streaming",
      ...deriveProcessingSignals([{ type: "ai", content: "Sorting algo" }]),
    });
    expect(screen.getByText(/Writing/)).toBeTruthy();
  });
});
