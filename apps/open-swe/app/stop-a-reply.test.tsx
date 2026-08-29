// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * A PERSON CAN STOP A REPLY (#154, residual of #262).
 *
 * `stop` shipped with no test at all. The affordance was present and unproven — the exact
 * shape that survives a move while quietly ceasing to work, which matters here because #154
 * moves this whole surface from rung-4-owned to `shared`. A promotion that carried the button
 * and not the wiring would look identical in a diff.
 *
 * IT LIVES IN apps/open-swe/app/, WHICH IS `shared`, ON PURPOSE. The open-swe e2e specs are
 * under e2e/rungs/open-swe/ and leave with rung 4, so a spec there could not protect a
 * capability the reparent exists to keep. This runs in every fork, including one that ejected
 * everything above rung 1 — which is where the promotion's value actually has to hold.
 *
 * WHAT IT ASSERTS, AND WHY EACH PART IS NOT THE PART BEFORE IT:
 *
 *   1. the control is VISIBLE while a reply is in flight   — not merely in the DOM
 *   2. clicking it calls `stop`                            — the wiring, which is what rots
 *   3. it is ABSENT when there is nothing to stop          — so (1) is not trivially true
 *
 * `toBeVisible`, not `toBeInTheDocument`. I shipped a test on this repo whose interaction was
 * a no-op and whose assertion passed on text inside a CLOSED <details>, because `textContent`
 * and `toBeInTheDocument` both see what a person cannot. A stop button rendered behind
 * `hidden` or `display:none` would satisfy presence and help nobody.
 */

const hookState: {
  status: string;
  stop: ReturnType<typeof vi.fn>;
} = { status: "ready", stop: vi.fn() };

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    // The real hook owns the abort; this test is about whether the BUTTON reaches it.
    // Asserting on the hook's own `stop` is what makes "the wrapper never passed it on" —
    // the #262 defect — expressible: that bug was a missing hand-off, not a missing abort.
    useDeepAgentsChat: () => ({
      messages: [],
      sendMessage: vi.fn(),
      status: hookState.status,
      error: null,
      stop: hookState.stop,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams("framework=deepagents"),
}));

import ChatPage from "./page";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  hookState.stop = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("stopping a reply (#262 residual)", () => {
  it.each(["submitted", "streaming"])(
    "while status is %s, the Stop control is VISIBLE",
    (status) => {
      // BOTH in-flight states, because they are reached differently and only one of them has
      // an assistant bubble. `submitted` is the window the caret indicator misses (#231); a
      // control that appeared only once tokens arrived would leave the slowest, most alarming
      // part of a reply uninterruptible — which is the half of #262 a person cannot work
      // around by waiting.
      hookState.status = status;
      render(<ChatPage />);
      expect(screen.getByTestId("chat-stop")).toBeVisible();
    }
  );

  it("clicking it calls the hook's stop — the hand-off, which is what rots", () => {
    hookState.status = "streaming";
    render(<ChatPage />);
    act(() => {
      screen.getByTestId("chat-stop").click();
    });
    expect(hookState.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "error"])(
    "while status is %s there is nothing to stop, and no control",
    (status) => {
      // THE CONTROL, and it is not optional. Without it a page that rendered Stop permanently
      // satisfies every case above — and a permanent Stop is its own defect, since it offers
      // to interrupt a reply that is not happening.
      hookState.status = status;
      render(<ChatPage />);
      expect(screen.queryByTestId("chat-stop")).toBeNull();
    }
  );
});
