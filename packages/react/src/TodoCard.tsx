"use client";

import type { DataTodo, TodoItem } from "./schemas";

export interface TodoCardProps {
  todo: DataTodo;
  className?: string;
  onItemClick?: (item: TodoItem) => void;
}

function itemStatusLabel(status: TodoItem["status"]): string {
  if (status === "done") return "✓";
  if (status === "in-progress") return "◐";
  return "○";
}

export function TodoCard({
  todo,
  className,
  onItemClick,
}: TodoCardProps): React.JSX.Element {
  return (
    <article
      data-testid="todo-card"
      data-todo-id={todo.id}
      data-todo-seq={todo.seq}
      className={className}
      aria-label={`Todo list (${todo.items.length} items)`}
    >
      <header>
        <h4 data-testid="todo-count">{todo.items.length} items</h4>
      </header>
      <ul data-testid="todo-items">
        {todo.items.map((item) => (
          <li
            key={item.id}
            data-testid="todo-item"
            data-item-id={item.id}
            data-item-status={item.status}
          >
            {onItemClick ? (
              <button
                type="button"
                data-testid="todo-item-button"
                onClick={() => onItemClick(item)}
              >
                <span data-testid="todo-item-icon" aria-hidden>
                  {itemStatusLabel(item.status)}
                </span>
                <span data-testid="todo-item-text">{item.text}</span>
              </button>
            ) : (
              <>
                <span data-testid="todo-item-icon" aria-hidden>
                  {itemStatusLabel(item.status)}
                </span>
                <span data-testid="todo-item-text">{item.text}</span>
              </>
            )}
            {item.priority ? (
              <span data-testid="todo-item-priority">{item.priority}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
