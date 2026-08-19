// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TodoCard } from "./TodoCard";
import type { DataTodo } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeTodo(overrides: Partial<DataTodo> = {}): DataTodo {
  return {
    id: "todo-1",
    seq: 0,
    items: [
      { id: "item-1", text: "Set up CI", status: "done" },
      { id: "item-2", text: "Write tests", status: "in-progress" },
      { id: "item-3", text: "Deploy", status: "pending" },
    ],
    ...overrides,
  };
}

describe("TodoCard", () => {
  it("renders item count in header", () => {
    render(<TodoCard todo={makeTodo()} />);
    expect(screen.getByTestId("todo-count").textContent).toBe("3 items");
  });

  it("exposes id and seq as data-* attributes", () => {
    render(<TodoCard todo={makeTodo({ id: "todo-9", seq: 4 })} />);
    const card = screen.getByTestId("todo-card");
    expect(card.getAttribute("data-todo-id")).toBe("todo-9");
    expect(card.getAttribute("data-todo-seq")).toBe("4");
  });

  it("renders all items with status icons", () => {
    render(<TodoCard todo={makeTodo()} />);
    const items = screen.getAllByTestId("todo-item");
    expect(items).toHaveLength(3);
    expect(screen.getAllByTestId("todo-item-icon")).toHaveLength(3);
  });

  it("exposes item id and status as data-* attributes", () => {
    render(<TodoCard todo={makeTodo()} />);
    const items = screen.getAllByTestId("todo-item");
    expect(items[0].getAttribute("data-item-id")).toBe("item-1");
    expect(items[0].getAttribute("data-item-status")).toBe("done");
    expect(items[1].getAttribute("data-item-status")).toBe("in-progress");
    expect(items[2].getAttribute("data-item-status")).toBe("pending");
  });

  it("renders status icons: ✓ done, ◐ in-progress, ○ pending", () => {
    render(<TodoCard todo={makeTodo()} />);
    const icons = screen.getAllByTestId("todo-item-icon");
    expect(icons[0].textContent).toBe("✓");
    expect(icons[1].textContent).toBe("◐");
    expect(icons[2].textContent).toBe("○");
  });

  it("renders item text", () => {
    render(<TodoCard todo={makeTodo()} />);
    const texts = screen.getAllByTestId("todo-item-text");
    expect(texts[0].textContent).toBe("Set up CI");
  });

  it("renders priority badge when present", () => {
    const todo = makeTodo({
      items: [
        { id: "i1", text: "Urgent", status: "pending", priority: "high" },
        { id: "i2", text: "Normal", status: "pending" },
      ],
    });
    render(<TodoCard todo={todo} />);
    expect(screen.getByTestId("todo-item-priority").textContent).toBe("high");
  });

  it("does not render priority when absent", () => {
    render(<TodoCard todo={makeTodo()} />);
    expect(screen.queryByTestId("todo-item-priority")).toBeNull();
  });

  it("forwards className to the outer article", () => {
    render(<TodoCard todo={makeTodo()} className="custom" />);
    expect(screen.getByTestId("todo-card").className).toContain("custom");
  });

  it("has aria-label with item count", () => {
    render(<TodoCard todo={makeTodo()} />);
    expect(screen.getByTestId("todo-card").getAttribute("aria-label")).toContain(
      "3 items"
    );
  });

  it("calls onItemClick when button is clicked", () => {
    const onClick = vi.fn();
    render(<TodoCard todo={makeTodo()} onItemClick={onClick} />);
    fireEvent.click(screen.getAllByTestId("todo-item-button")[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-1" })
    );
  });

  it("renders items without buttons when onItemClick is not provided", () => {
    render(<TodoCard todo={makeTodo()} />);
    expect(screen.queryByTestId("todo-item-button")).toBeNull();
  });

  it("renders '0 items' header and empty list when items array is empty", () => {
    const todo = makeTodo({ items: [] });
    render(<TodoCard todo={todo} />);
    expect(screen.getByTestId("todo-count").textContent).toBe("0 items");
    expect(screen.getByTestId("todo-card").getAttribute("aria-label")).toBe(
      "Todo list (0 items)"
    );
    // The <ul> still renders but contains zero <li> children
    const list = screen.getByTestId("todo-items");
    expect(list.querySelectorAll("li")).toHaveLength(0);
  });

  it("renders item with empty text string without crashing", () => {
    const todo = makeTodo({
      items: [{ id: "i-empty", text: "", status: "pending" }],
    });
    render(<TodoCard todo={todo} />);
    const texts = screen.getAllByTestId("todo-item-text");
    expect(texts).toHaveLength(1);
    // Empty string should still render the span (textContent is empty, not missing)
    expect(texts[0].textContent).toBe("");
  });
});
