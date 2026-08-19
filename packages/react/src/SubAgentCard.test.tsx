// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SubAgentCard } from "./SubAgentCard";
import type { DataSubAgent } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeSubAgent(overrides: Partial<DataSubAgent> = {}): DataSubAgent {
  return {
    id: "sa-1",
    seq: 0,
    parentToolCallId: "tc-parent",
    name: "researcher",
    status: "running",
    prompt: "Find recent CVEs for openssl.",
    result: null,
    error: null,
    startedAt: "2026-04-29T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("SubAgentCard — rendering", () => {
  it("renders name, status, parentToolCallId, and startedAt", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} />);
    expect(screen.getByTestId("sub-agent-name").textContent).toBe("researcher");
    expect(screen.getByTestId("sub-agent-status").textContent).toBe("running");
    expect(
      screen
        .getByTestId("sub-agent-card")
        .getAttribute("data-parent-tool-call-id")
    ).toBe("tc-parent");
    expect(
      screen.getByTestId("sub-agent-started-at").getAttribute("dateTime")
    ).toBe("2026-04-29T00:00:00Z");
  });

  it("exposes id, seq, status as data-* attributes", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({ id: "sa-9", seq: 4, status: "done" })}
      />
    );
    const card = screen.getByTestId("sub-agent-card");
    expect(card.getAttribute("data-sub-agent-id")).toBe("sa-9");
    expect(card.getAttribute("data-sub-agent-seq")).toBe("4");
    expect(card.getAttribute("data-sub-agent-status")).toBe("done");
  });

  it("renders finishedAt only when set", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({
          finishedAt: "2026-04-29T00:05:00Z",
          status: "done",
        })}
      />
    );
    expect(
      screen.getByTestId("sub-agent-finished-at").getAttribute("dateTime")
    ).toBe("2026-04-29T00:05:00Z");
  });

  it("does not render finishedAt when null", () => {
    render(<SubAgentCard subAgent={makeSubAgent({ finishedAt: null })} />);
    expect(screen.queryByTestId("sub-agent-finished-at")).toBeNull();
  });

  it("forwards className to the outer article", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} className="my-sub-agent" />);
    expect(screen.getByTestId("sub-agent-card").className).toContain(
      "my-sub-agent"
    );
  });

  it("outer article has aria-label derived from name", () => {
    render(<SubAgentCard subAgent={makeSubAgent({ name: "code-reviewer" })} />);
    expect(
      screen.getByTestId("sub-agent-card").getAttribute("aria-label")
    ).toContain("code-reviewer");
  });
});

describe("SubAgentCard — expand/collapse", () => {
  it("details panel is hidden by default; clicking expand reveals the prompt toggle", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} />);
    expect(screen.queryByTestId("sub-agent-details")).toBeNull();
    expect(screen.getByTestId("sub-agent-expand-button").textContent).toContain(
      "Show"
    );

    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.getByTestId("sub-agent-details")).toBeTruthy();
    expect(screen.getByTestId("sub-agent-prompt-toggle")).toBeTruthy();
  });

  it("clicking prompt toggle reveals the prompt content", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} />);
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    fireEvent.click(screen.getByTestId("sub-agent-prompt-toggle"));
    expect(screen.getByTestId("sub-agent-prompt").textContent).toBe(
      "Find recent CVEs for openssl."
    );
  });

  it("expand toggle reflects aria-expanded state", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} />);
    const btn = screen.getByTestId("sub-agent-expand-button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("does NOT render expand button when allowExpand={false}", () => {
    render(<SubAgentCard subAgent={makeSubAgent()} allowExpand={false} />);
    expect(screen.queryByTestId("sub-agent-expand-button")).toBeNull();
    expect(screen.queryByTestId("sub-agent-details")).toBeNull();
  });
});

describe("SubAgentCard — result / error sections", () => {
  it("status='done' with a result string shows the result section when output toggle is clicked", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({
          status: "done",
          result: "CVE-2024-1234 affects 3.x.",
          finishedAt: "2026-04-29T00:05:00Z",
        })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    fireEvent.click(screen.getByTestId("sub-agent-output-toggle"));
    expect(screen.getByTestId("sub-agent-result").textContent).toContain(
      "CVE-2024-1234"
    );
  });

  it("status='done' with empty/null result hides the result section", () => {
    render(
      <SubAgentCard subAgent={makeSubAgent({ status: "done", result: null })} />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-output-toggle")).toBeNull();
    expect(screen.queryByTestId("sub-agent-result")).toBeNull();
  });

  it("status='errored' shows the error section with role=alert when error toggle is clicked", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({
          status: "errored",
          error: "Sandbox timeout after 60s",
          finishedAt: "2026-04-29T00:05:00Z",
        })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    fireEvent.click(screen.getByTestId("sub-agent-error-toggle"));
    const errSection = screen.getByTestId("sub-agent-error-section");
    expect(errSection.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("sub-agent-error").textContent).toContain(
      "Sandbox timeout"
    );
  });

  it("status='errored' with empty/null error hides the error section", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({ status: "errored", error: null })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-error-toggle")).toBeNull();
    expect(screen.queryByTestId("sub-agent-error-section")).toBeNull();
  });

  it("status='running' shows neither result nor error sections", () => {
    render(<SubAgentCard subAgent={makeSubAgent({ status: "running" })} />);
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-result-section")).toBeNull();
    expect(screen.queryByTestId("sub-agent-error-section")).toBeNull();
  });

  it("status='starting' shows neither result nor error sections", () => {
    render(<SubAgentCard subAgent={makeSubAgent({ status: "starting" })} />);
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-result-section")).toBeNull();
    expect(screen.queryByTestId("sub-agent-error-section")).toBeNull();
  });

  it("renders valid JSON result as parsed JSON (not raw text) and reports type as json", () => {
    render(
      <SubAgentCard
        subAgent={makeSubAgent({
          status: "done",
          result: '{"cve": "CVE-2024-1234", "severity": "high"}',
          finishedAt: "2026-04-29T00:05:00Z",
        })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    fireEvent.click(screen.getByTestId("sub-agent-output-toggle"));

    // Should detect JSON and show the parsed version
    expect(screen.getByTestId("sub-agent-result-type").getAttribute("data-value")).toBe("json");
    const jsonResult = screen.getByTestId("sub-agent-result-json");
    // Parsed JSON should be pretty-printed
    expect(jsonResult.textContent).toContain('"cve"');
    expect(jsonResult.textContent).toContain('"CVE-2024-1234"');
    // The raw text result should NOT be rendered
    expect(screen.queryByTestId("sub-agent-result")).toBeNull();
  });

  it("handles malformed JSON that starts with { and ends with } but is invalid", () => {
    // tryParseJson only tries JSON.parse when string starts with { and ends with }.
    // A string like '{"key": }' is invalid JSON — the catch should return isJson:false.
    render(
      <SubAgentCard
        subAgent={makeSubAgent({
          status: "done",
          result: '{"key": }',
          finishedAt: "2026-04-29T00:05:00Z",
        })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    fireEvent.click(screen.getByTestId("sub-agent-output-toggle"));

    // Should fall back to text rendering, not crash
    expect(screen.getByTestId("sub-agent-result-type").getAttribute("data-value")).toBe("text");
    expect(screen.getByTestId("sub-agent-result").textContent).toBe('{"key": }');
    expect(screen.queryByTestId("sub-agent-result-json")).toBeNull();
  });

  it("treats empty string result as absent (no output toggle or result section)", () => {
    // An empty string "" is technically truthy in JS but hasResult checks .length > 0,
    // so the output toggle should not appear.
    render(
      <SubAgentCard
        subAgent={makeSubAgent({ status: "done", result: "", finishedAt: "2026-04-29T00:05:00Z" })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-output-toggle")).toBeNull();
    expect(screen.queryByTestId("sub-agent-result")).toBeNull();
  });

  it("treats empty string error as absent (no error toggle or error section)", () => {
    // Similarly, error="" should not trigger the error section.
    render(
      <SubAgentCard
        subAgent={makeSubAgent({ status: "errored", error: "", finishedAt: "2026-04-29T00:05:00Z" })}
      />
    );
    fireEvent.click(screen.getByTestId("sub-agent-expand-button"));
    expect(screen.queryByTestId("sub-agent-error-toggle")).toBeNull();
    expect(screen.queryByTestId("sub-agent-error-section")).toBeNull();
  });
});
