// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanCard } from "./PlanCard";
import type { DataPlan } from "./schemas";

afterEach(() => {
  cleanup();
});

function makePlan(overrides: Partial<DataPlan> = {}): DataPlan {
  return {
    id: "plan-1",
    seq: 0,
    title: "Refactor auth",
    markdown: "## Plan\n\nRefactor auth into Clerk.",
    subtasks: [
      { id: "s1", label: "Install Clerk", status: "done" },
      { id: "s2", label: "Wire middleware", status: "in-progress" },
      { id: "s3", label: "Migrate users", status: "pending" },
    ],
    updatedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  };
}

describe("PlanCard — rendering", () => {
  it("renders title, summary, markdown, and updatedAt", () => {
    render(<PlanCard plan={makePlan()} />);
    expect(screen.getByTestId("plan-title").textContent).toBe("Refactor auth");
    expect(screen.getByTestId("plan-summary").textContent).toContain("1 of 3");
    expect(screen.getByTestId("plan-markdown").textContent).toContain("Clerk");
    expect(screen.getByTestId("plan-updated-at").getAttribute("dateTime")).toBe(
      "2026-04-29T00:00:00Z"
    );
  });

  it("renders one subtask <li> per item with status + icon attributes", () => {
    render(<PlanCard plan={makePlan()} />);
    const items = screen.getAllByTestId("plan-subtask");
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute("data-subtask-status")).toBe("done");
    expect(items[1].getAttribute("data-subtask-status")).toBe("in-progress");
    expect(items[2].getAttribute("data-subtask-status")).toBe("pending");
  });

  it("exposes plan id and seq as data-* attributes", () => {
    render(
      <PlanCard
        plan={makePlan({ id: "plan-xyz", seq: 9 })}
      />
    );
    const card = screen.getByTestId("plan-card");
    expect(card.getAttribute("data-plan-id")).toBe("plan-xyz");
    expect(card.getAttribute("data-plan-seq")).toBe("9");
  });

  it("uses '0 of 0' summary for a plan with no subtasks", () => {
    render(<PlanCard plan={makePlan({ subtasks: [] })} />);
    expect(screen.getByTestId("plan-summary").textContent).toContain("0 of 0");
    expect(screen.queryByTestId("plan-subtask")).toBeNull();
  });

  it("suppresses the markdown block when showMarkdown={false}", () => {
    render(<PlanCard plan={makePlan()} showMarkdown={false} />);
    expect(screen.queryByTestId("plan-markdown")).toBeNull();
  });

  it("does NOT render the markdown block when plan.markdown is empty", () => {
    render(<PlanCard plan={makePlan({ markdown: "" })} />);
    expect(screen.queryByTestId("plan-markdown")).toBeNull();
  });

  it("renders icon glyphs that distinguish done / in-progress / pending", () => {
    render(<PlanCard plan={makePlan()} />);
    const icons = screen.getAllByTestId("plan-subtask-icon");
    expect(icons[0].textContent).toBe("✓"); // done
    expect(icons[1].textContent).toBe("◐"); // in-progress
    expect(icons[2].textContent).toBe("○"); // pending
  });

  it("forwards className to the outer section", () => {
    render(<PlanCard plan={makePlan()} className="my-plan" />);
    expect(screen.getByTestId("plan-card").className).toContain("my-plan");
  });

  it("outer section has role=region and aria-label derived from the title", () => {
    render(<PlanCard plan={makePlan({ title: "Ship v2" })} />);
    const card = screen.getByTestId("plan-card");
    // <section> with aria-label is implicitly a region landmark.
    expect(card.tagName).toBe("SECTION");
    expect(card.getAttribute("aria-label")).toContain("Ship v2");
  });
});

describe("PlanCard — onSubtaskClick", () => {
  it("when onSubtaskClick is provided, each subtask renders a button that fires the handler with the subtask", () => {
    const onSubtaskClick = vi.fn();
    render(<PlanCard plan={makePlan()} onSubtaskClick={onSubtaskClick} />);

    const buttons = screen.getAllByTestId("plan-subtask-button");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1]);
    expect(onSubtaskClick).toHaveBeenCalledTimes(1);
    expect(onSubtaskClick).toHaveBeenCalledWith({
      id: "s2",
      label: "Wire middleware",
      status: "in-progress",
    });
  });

  it("when onSubtaskClick is NOT provided, no button is rendered (subtask label is inline)", () => {
    render(<PlanCard plan={makePlan()} />);
    expect(screen.queryByTestId("plan-subtask-button")).toBeNull();
    // Labels still present as plain spans.
    const labels = screen.getAllByTestId("plan-subtask-label");
    expect(labels.map((l) => l.textContent)).toEqual([
      "Install Clerk",
      "Wire middleware",
      "Migrate users",
    ]);
  });
});

describe("PlanCard — subtask transition tracking", () => {
  it("does NOT mark subtasks as new or transitioned on re-render with identical subtasks", () => {
    // On the first render, all subtasks are "new" (prevMap is empty).
    // On a re-render with the exact same subtasks, no subtask should have
    // data-subtask-new="true" or data-subtask-transition set.
    const { rerender } = render(<PlanCard plan={makePlan()} />);

    // First render: all 3 are new (prevMap was empty)
    let items = screen.getAllByTestId("plan-subtask");
    expect(items.filter((el) => el.hasAttribute("data-subtask-new"))).toHaveLength(3);

    // Re-render with same plan
    rerender(<PlanCard plan={makePlan()} />);
    items = screen.getAllByTestId("plan-subtask");
    // After re-render, prevMap was set from the first render, so none should be new
    expect(items.filter((el) => el.hasAttribute("data-subtask-new"))).toHaveLength(0);
    // No transitions since statuses are unchanged
    expect(items.filter((el) => el.hasAttribute("data-subtask-transition"))).toHaveLength(0);
  });

  it("detects data-subtask-transition when a subtask status changes between renders", () => {
    const { rerender } = render(
      <PlanCard plan={makePlan()} />
    );

    // First render populates prevMap. Now change s2 from in-progress to done.
    rerender(
      <PlanCard
        plan={makePlan({
          subtasks: [
            { id: "s1", label: "Install Clerk", status: "done" },
            { id: "s2", label: "Wire middleware", status: "done" },
            { id: "s3", label: "Migrate users", status: "pending" },
          ],
        })}
      />
    );

    const items = screen.getAllByTestId("plan-subtask");
    // s1: done->done = no transition
    expect(items[0].hasAttribute("data-subtask-transition")).toBe(false);
    // s2: in-progress->done = transition
    expect(items[1].getAttribute("data-subtask-transition")).toBe("in-progress->done");
    // s3: pending->pending = no transition
    expect(items[2].hasAttribute("data-subtask-transition")).toBe(false);
  });

  it("handles subtasks being removed between renders (plan shrinks) without stale data-subtask-new on surviving subtasks", () => {
    // Render with 3 subtasks, then remove s2 and s3, keeping only s1.
    // The prevSubtasksRef still has s1, s2, s3 from the prior render.
    // Surviving subtask s1 should NOT be marked as new (it existed before),
    // and removed subtasks should simply not appear.
    const { rerender } = render(
      <PlanCard plan={makePlan()} />
    );

    // First render: all 3 are new
    expect(screen.getAllByTestId("plan-subtask")).toHaveLength(3);

    // Now shrink the plan to just s1
    rerender(
      <PlanCard
        plan={makePlan({
          subtasks: [{ id: "s1", label: "Install Clerk", status: "done" }],
        })}
      />
    );

    const items = screen.getAllByTestId("plan-subtask");
    expect(items).toHaveLength(1);
    // s1 existed in the previous render, so it should NOT be marked new
    expect(items[0].hasAttribute("data-subtask-new")).toBe(false);
    expect(items[0].getAttribute("data-subtask-id")).toBe("s1");
  });
});
