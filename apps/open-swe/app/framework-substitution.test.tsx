// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The notice must actually REACH THE SCREEN (#211).
 *
 * `resolveFramework` is unit-tested in lib/frameworks.test.ts, but a correct resolution that
 * nothing renders is the same blank screen as the silent fallback it replaces — the defect was
 * never in the decision, it was that the decision was invisible. So these render the page.
 *
 * Watched failing before the notice was wired: the resolution was correct and
 * `framework-substituted` was absent from the document.
 */
vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    useDeepAgentsChat: () => ({
      messages: [],
      sendMessage: vi.fn(),
      status: "ready",
      error: null,
    }),
  };
});

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => searchParams,
  // #154 — the page reads usePathname so a framework switch stays on the
  // address the user arrived at. Absent here, the page throws on render.
  usePathname: () => "/",
}));

import ChatPage from "./page";

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("a framework this build cannot serve is named, not swallowed", () => {
  it("shows the notice and names WHAT WAS ASKED FOR", () => {
    searchParams = new URLSearchParams("framework=langraph");
    render(<ChatPage />);

    const notice = screen.getByTestId("framework-substituted");
    // Naming the requested value is the whole point: a notice that said only "showing
    // langchain" would not tell the user which of their links is wrong.
    expect(notice.getAttribute("data-requested")).toBe("langraph");
    expect(notice.textContent).toContain("langraph");
  });

  it("shows NO notice when the param is absent", () => {
    // The control. Without it, a page rendering the banner unconditionally passes the case
    // above — and defaulting on an absent param is correct, not a substitution.
    searchParams = new URLSearchParams();
    render(<ChatPage />);
    expect(screen.queryByTestId("framework-substituted")).toBeNull();
  });

  it("shows NO notice for a framework this build does serve", () => {
    searchParams = new URLSearchParams("framework=langchain");
    render(<ChatPage />);
    expect(screen.queryByTestId("framework-substituted")).toBeNull();
  });
});
