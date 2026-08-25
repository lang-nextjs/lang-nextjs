// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TaskCard } from "./TaskCard";
import type { DataTask } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeTask(overrides: Partial<DataTask> = {}): DataTask {
  return {
    id: "task-1",
    seq: 0,
    taskName: "Migrate session store",
    status: "in-progress",
    description: null,
    groupLabel: null,
    ...overrides,
  };
}

describe("TaskCard — rendering", () => {
  it("renders name and status badge", () => {
    render(<TaskCard task={makeTask()} />);
    expect(screen.getByTestId("task-name").textContent).toBe(
      "Migrate session store"
    );
    expect(screen.getByTestId("task-status").textContent).toBe("in-progress");
  });

  it("exposes id, seq, and status as data-* attributes", () => {
    render(
      <TaskCard task={makeTask({ id: "task-9", seq: 4, status: "done" })} />
    );
    const card = screen.getByTestId("task-card");
    expect(card.getAttribute("data-task-id")).toBe("task-9");
    expect(card.getAttribute("data-task-seq")).toBe("4");
    expect(card.getAttribute("data-task-status")).toBe("done");
  });

  it("renders description when provided", () => {
    render(
      <TaskCard
        task={makeTask({ description: "Drop the old in-memory store" })}
      />
    );
    expect(screen.getByTestId("task-description").textContent).toBe(
      "Drop the old in-memory store"
    );
  });

  it("does not render description when null/undefined", () => {
    render(<TaskCard task={makeTask({ description: null })} />);
    expect(screen.queryByTestId("task-description")).toBeNull();
  });

  it("renders groupLabel when provided", () => {
    render(<TaskCard task={makeTask({ groupLabel: "Phase 2" })} />);
    expect(screen.getByTestId("task-group").textContent).toBe("Phase 2");
  });

  it("does not render groupLabel when null", () => {
    render(<TaskCard task={makeTask({ groupLabel: null })} />);
    expect(screen.queryByTestId("task-group")).toBeNull();
  });

  it("status badge text matches status enum (pending/in-progress/done)", () => {
    for (const status of ["pending", "in-progress", "done"] as const) {
      const { unmount } = render(<TaskCard task={makeTask({ status })} />);
      expect(screen.getByTestId("task-status").textContent).toBe(status);
      unmount();
    }
  });

  it("forwards className to the outer article", () => {
    render(<TaskCard task={makeTask()} className="custom" />);
    expect(screen.getByTestId("task-card").className).toContain("custom");
  });

  it("outer article has aria-label derived from taskName", () => {
    render(<TaskCard task={makeTask({ taskName: "Reindex users" })} />);
    expect(
      screen.getByTestId("task-card").getAttribute("aria-label")
    ).toContain("Reindex users");
  });
});
