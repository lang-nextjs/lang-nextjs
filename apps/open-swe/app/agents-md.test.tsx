// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * A PART THAT PASSES ITS SCHEMA AND THEN HAS NO RENDERER.
 *
 * open-swe registered `AgentsMdSchema` and rendered no `AgentsMdCard`, so a `data-agents-md`
 * frame arrived, validated, and disappeared. Nothing failed — which is the problem. **A part
 * that vanishes and a part that never arrived produce the same screen**, and neither raises
 * an error, so no existing assertion in this app could have caught it.
 *
 * That is #140's family one step further along: #140 is about parts REJECTED by a schema,
 * this is about a part ACCEPTED by one and then dropped. Same blank screen, different cause.
 *
 * WHY THIS ASSERTS THE POSITIVE. "No errors were logged" is satisfied by a surface that
 * rendered nothing at all — a crashed panel has zero errors too. So these assert the card is
 * PRESENT and that the payload's own content reached the DOM. A test that only counted
 * errors would have passed against the unfixed code, which is the whole defect.
 *
 * Watched failing against the unfixed page before the card was wired: `agents-md-card` was
 * absent and the AGENTS.md text was nowhere in the document.
 */

const messages: Array<Record<string, unknown>> = [];

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    // The hook is mocked, not the network: the render path is what is under test, and
    // intercepting fetch would additionally depend on when the hook chooses to send.
    useDeepAgentsChat: () => ({
      messages,
      sendMessage: vi.fn(),
      status: "ready",
      error: null,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  // #154 — the page reads usePathname so a framework switch stays on the
  // address the user arrived at. Absent here, the page throws on render.
  usePathname: () => "/",
}));

import ChatPage from "./page";

const AGENTS_MD = {
  id: "amd-1",
  seq: 0,
  path: "AGENTS.md",
  content: "# House rules\n\nAlways run the severability matrix before merging.",
};

beforeEach(() => {
  messages.length = 0;
  window.localStorage.clear();
  // jsdom implements no layout, so Element.scrollIntoView does not exist. The page calls it
  // in an effect whenever messages change — so WITHOUT this stub all three cases below fail
  // with a TypeError, including the control that is supposed to pass against unfixed code.
  //
  // That is worth naming: the first RED here was three failures for a HARNESS reason, and
  // reading it as "the card is missing" would have been a confident wrong verdict about a
  // check that never ran. The control passing is what proves the stub is not hiding the
  // defect too.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("open-swe renders data-agents-md at parity with example", () => {
  it("renders the card when a data-agents-md part arrives", () => {
    messages.push({ type: "data-agents-md", id: "m1", data: AGENTS_MD });
    render(<ChatPage />);

    // POSITIVE claim: the card is in the document. Not "no error was thrown".
    expect(screen.getByTestId("agents-md-card")).toBeTruthy();
  });

  it("the payload's own content reaches the card, not just a container", () => {
    // A card rendering an empty shell would satisfy the case above, so this follows the data
    // through. The path shows immediately; the CONTENT is collapsed behind "Show content" by
    // the card's own design (`allowExpand` defaults true, `expanded` starts false).
    //
    // My first version asserted the content was in the DOM on first paint and failed — the
    // test was wrong about the component, not the wiring. Expanding is what actually proves
    // the payload survived the trip, and asserting it pre-expansion would have been a test
    // demanding behaviour the card deliberately does not have.
    messages.push({ type: "data-agents-md", id: "m1", data: AGENTS_MD });
    render(<ChatPage />);

    expect(screen.getByTestId("agents-md-path").textContent).toBe("AGENTS.md");
    expect(screen.queryByTestId("agents-md-content")).toBeNull();

    fireEvent.click(screen.getByTestId("agents-md-expand-button"));
    expect(screen.getByTestId("agents-md-content").textContent).toContain(
      "House rules"
    );
  });

  it("renders nothing for it when no such part arrives", () => {
    // The control. Without it, a page that rendered an AgentsMdCard unconditionally would
    // pass both cases above while being obviously wrong.
    messages.push({ type: "data-todo", id: "m1", data: { id: "t", seq: 0, items: [] } });
    render(<ChatPage />);

    expect(screen.queryByTestId("agents-md-card")).toBeNull();
  });
});
