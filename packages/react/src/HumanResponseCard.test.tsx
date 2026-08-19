// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HumanResponseCard } from "./HumanResponseCard";
import type { DataHumanResponse } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeResponse(
  overrides: Partial<DataHumanResponse> = {}
): DataHumanResponse {
  return {
    id: "appr-1",
    seq: 7,
    response: "Use grep -r 'pattern' instead — safer.",
    createdAt: "2026-04-29T00:00:00Z",
    ...overrides,
  };
}

describe("HumanResponseCard — rendering", () => {
  it("renders the response text inside a blockquote", () => {
    render(<HumanResponseCard response={makeResponse()} />);
    expect(screen.getByTestId("human-response-text").textContent).toContain(
      "Use grep -r 'pattern' instead"
    );
    expect(screen.getByTestId("human-response-text").tagName).toBe("BLOCKQUOTE");
  });

  it("renders createdAt as a <time> with dateTime attribute", () => {
    render(
      <HumanResponseCard
        response={makeResponse({ createdAt: "2026-05-24T12:00:00Z" })}
      />
    );
    expect(
      screen.getByTestId("human-response-created-at").getAttribute("dateTime")
    ).toBe("2026-05-24T12:00:00Z");
  });

  it("exposes id and seq as data-* attributes for selector-based testing", () => {
    render(
      <HumanResponseCard response={makeResponse({ id: "appr-xyz", seq: 42 })} />
    );
    const card = screen.getByTestId("human-response-card");
    expect(card.getAttribute("data-human-response-id")).toBe("appr-xyz");
    expect(card.getAttribute("data-human-response-seq")).toBe("42");
  });

  it("blockquote carries cite={response.id} for assistive-tech provenance", () => {
    render(<HumanResponseCard response={makeResponse({ id: "appr-cite" })} />);
    expect(
      screen.getByTestId("human-response-text").getAttribute("cite")
    ).toBe("appr-cite");
  });

  it("renders an empty response (the server allows it; the schema permits any string)", () => {
    render(<HumanResponseCard response={makeResponse({ response: "" })} />);
    expect(screen.getByTestId("human-response-text").textContent).toBe("");
  });

  it("forwards className to the outer article", () => {
    render(<HumanResponseCard response={makeResponse()} className="my-hr" />);
    expect(screen.getByTestId("human-response-card").className).toContain(
      "my-hr"
    );
  });
});

describe("HumanResponseCard — accessibility", () => {
  it("outer article has role=note (it's a marginal/aside annotation) with an aria-label", () => {
    render(<HumanResponseCard response={makeResponse()} />);
    const card = screen.getByTestId("human-response-card");
    expect(card.getAttribute("role")).toBe("note");
    expect(card.getAttribute("aria-label")).toBe("Human response to approval");
  });

  it("uses an article element for semantic grouping", () => {
    render(<HumanResponseCard response={makeResponse()} />);
    expect(screen.getByTestId("human-response-card").tagName).toBe("ARTICLE");
  });
});
