// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentsMdCard } from "./AgentsMdCard";
import type { DataAgentsMd } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeAgentsMd(overrides: Partial<DataAgentsMd> = {}): DataAgentsMd {
  return {
    id: "amd-1",
    seq: 0,
    content: "# Project Guidelines\n\nUse TypeScript.",
    path: "AGENTS.md",
    ...overrides,
  };
}

describe("AgentsMdCard", () => {
  it("renders path in header", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} />);
    expect(screen.getByTestId("agents-md-path").textContent).toBe("AGENTS.md");
  });

  it("exposes id and seq as data-* attributes", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd({ id: "amd-9", seq: 3 })} />);
    const card = screen.getByTestId("agents-md-card");
    expect(card.getAttribute("data-agents-md-id")).toBe("amd-9");
    expect(card.getAttribute("data-agents-md-seq")).toBe("3");
  });

  it("is collapsed by default — content not visible", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} />);
    expect(screen.queryByTestId("agents-md-content")).toBeNull();
  });

  it("shows expand button when allowExpand is true (default)", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} />);
    expect(screen.getByTestId("agents-md-expand-button")).toBeDefined();
  });

  it("hides expand button when allowExpand is false", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} allowExpand={false} />);
    expect(screen.queryByTestId("agents-md-expand-button")).toBeNull();
  });

  it("always shows content when allowExpand is false", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} allowExpand={false} />);
    expect(screen.queryByTestId("agents-md-content")).toBeNull();
  });

  it("forwards className to the outer article", () => {
    render(<AgentsMdCard agentsMd={makeAgentsMd()} className="custom" />);
    expect(screen.getByTestId("agents-md-card").className).toContain("custom");
  });

  it("has aria-label derived from path", () => {
    render(
      <AgentsMdCard agentsMd={makeAgentsMd({ path: "docs/AGENTS.md" })} />
    );
    expect(
      screen.getByTestId("agents-md-card").getAttribute("aria-label")
    ).toContain("docs/AGENTS.md");
  });
});
