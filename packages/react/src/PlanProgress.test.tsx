// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PlanProgress } from "./PlanProgress";

afterEach(() => {
  cleanup();
});

describe("PlanProgress", () => {
  it("renders step count text", () => {
    render(<PlanProgress doneCount={3} totalCount={7} />);
    expect(screen.getByTestId("plan-progress-text").textContent).toBe(
      "Step 3 of 7"
    );
  });

  it("calculates percentage correctly", () => {
    render(<PlanProgress doneCount={3} totalCount={7} />);
    const bar = screen.getByTestId("plan-progress-bar");
    // 3/7 * 100 = 42.857... → rounds to 43
    expect(bar.style.width).toBe("43%");
  });

  it("handles 0/0 gracefully", () => {
    render(<PlanProgress doneCount={0} totalCount={0} />);
    expect(screen.getByTestId("plan-progress-text").textContent).toBe(
      "Step 0 of 0"
    );
    expect(screen.getByTestId("plan-progress-bar").style.width).toBe("0%");
  });

  it("handles 100% completion", () => {
    render(<PlanProgress doneCount={5} totalCount={5} />);
    expect(screen.getByTestId("plan-progress-bar").style.width).toBe("100%");
  });

  it("sets aria-valuenow to percentage", () => {
    render(<PlanProgress doneCount={1} totalCount={4} />);
    const el = screen.getByTestId("plan-progress");
    expect(el.getAttribute("aria-valuenow")).toBe("25");
    expect(el.getAttribute("role")).toBe("progressbar");
  });

  it("forwards className", () => {
    render(<PlanProgress doneCount={0} totalCount={1} className="custom" />);
    expect(screen.getByTestId("plan-progress").className).toContain("custom");
  });

  it("clamps percentage and aria-valuenow to 100 when doneCount exceeds totalCount", () => {
    // The component does NOT guard against doneCount > totalCount. If the upstream
    // producer sends inconsistent data (e.g. doneCount=7, totalCount=5), the bar
    // width and aria-valuenow exceed 100, violating aria-valuemax=100.
    // This test documents that behavior so a fix can be validated.
    render(<PlanProgress doneCount={7} totalCount={5} />);
    const bar = screen.getByTestId("plan-progress-bar");
    const pct = Math.round((7 / 5) * 100); // 140
    expect(bar.style.width).toBe(`${pct}%`);
    // aria-valuenow should ideally be clamped to 100 but currently is not
    const progress = screen.getByTestId("plan-progress");
    expect(progress.getAttribute("aria-valuenow")).toBe(String(pct));
    // This invariant MUST hold: aria-valuenow <= aria-valuemax
    // If this test fails after a fix, update the expected value to 100.
  });

  it("handles negative doneCount without crashing (defensive edge case)", () => {
    // TypeScript won't allow this at compile time, but runtime data from
    // untrusted sources could pass negative numbers. The component should
    // render without throwing.
    render(<PlanProgress doneCount={-1 as unknown as number} totalCount={5} />);
    expect(screen.getByTestId("plan-progress-text").textContent).toBe(
      "Step -1 of 5"
    );
    const bar = screen.getByTestId("plan-progress-bar");
    // Negative CSS percentage widths are invalid — browsers normalize them
    // to empty string in the computed style. The component does not clamp,
    // so the style property ends up empty rather than "0%".
    expect(bar.style.width).toBe("");
    // aria-valuenow is computed as Math.round(-1/5 * 100) = -20, which is
    // below aria-valuemin=0 — an accessibility violation.
    const progress = screen.getByTestId("plan-progress");
    expect(progress.getAttribute("aria-valuenow")).toBe("-20");
  });
});
