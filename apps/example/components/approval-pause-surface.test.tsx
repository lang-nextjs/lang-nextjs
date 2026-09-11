// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";

/**
 * THE PAUSE REACHES THE SHIPPED SURFACE, NOT JUST THE COMPONENT (#420).
 *
 * #420 is "the gate withholds execution and tells nobody", so the deliverable
 * is that A USER SEES IT. An export, a component test and a mounted app are
 * three different claims, and this repo has closed a requirement on the first
 * while believing the third. `ApprovalPauseCard` was exported and unit-tested;
 * `ConversationSurface` — the app that ships at EVERY rung — dispatched nine
 * `data-*` types and this was not one of them, so on the reference app the
 * frame arrived, validated against nothing, and disappeared.
 *
 * SO THIS RENDERS THE REAL SURFACE. It mocks only the chat hook — the transport
 * is not the subject — and lets ConversationSurface's own dispatch, schema map
 * and card wiring run. A test that imported ApprovalPauseCard directly would
 * have passed against the unfixed app, which is the whole defect.
 *
 * WHY THE FIXTURE CARRIES TWO ACTIONS WITH DIFFERENT `allowed_decisions`.
 * The schema pairs `action_requests` with `review_configs` BY INDEX, and
 * `review_configs[i].allowed_decisions` is the client's only source for which
 * controls to offer. A card that renders without reading it shows no buttons
 * and looks plausible; a card that ignores the INDEX shows the same controls
 * twice and also looks plausible. Two actions whose allowed sets are disjoint
 * fail both of those and pass only if the pairing is real.
 */

const messages: Array<Record<string, unknown>> = [];

/*
 * THE CHAT'S SESSION ID, NOT A FRESHLY MINTED ONE (#1185/DEV1). The surface keeps
 * a stable id from useState (ConversationSurface.tsx:300) and forwards it via
 * `baseBody`. A prefix check would let a controller that minted its own
 * `example-…` id pass, and that is the failure this test exists to catch. So
 * we record the options the mock hook was CALLED WITH, and assert equality.
 */
const chatSpy = vi.hoisted(() => ({
  opts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    // Only the hook. The cards, schemas and controller are the code under test.
    useDeepAgentsChat: (opts: Record<string, unknown>) => {
      chatSpy.opts = opts;
      return {
        messages,
        sendMessage: vi.fn(),
        status: "ready",
        error: null,
      };
    },
  };
});

import { ConversationSurface } from "./ConversationSurface";

/**
 * Upstream's interrupt VERBATIM, taken from ApprovalPauseSchema and the
 * conformance test — NOT from the schema's prose description.
 *
 * The description names the keys correctly and says nothing about the
 * `interrupt` WRAPPER or about `review_configs[].action_name`, and my first
 * fixture had neither. It failed with "Cannot read properties of undefined
 * (reading 'action_requests')" rather than passing wrongly, but a fixture built
 * from prose is how a wrong shape gets written down twice.
 */
const PAUSE = {
  interrupt: {
    action_requests: [
      { name: "increment", args: { by: 1 }, description: "bump the counter" },
      { name: "delete_row", args: { id: 7 } },
    ],
    review_configs: [
      { action_name: "increment", allowed_decisions: ["approve", "reject"] },
      { action_name: "delete_row", allowed_decisions: ["respond"] },
    ],
  },
};

/**
 * The same pause with review_configs[1] naming the WRONG action. `allowedFor`
 * requires the index AND the name to agree, so this is "surfaced but
 * unanswerable" — the card still appears, with no controls and a reason.
 * Offering all four here would be a control that cannot keep its promise.
 */
const MISPAIRED = {
  interrupt: {
    action_requests: PAUSE.interrupt.action_requests,
    review_configs: [
      { action_name: "increment", allowed_decisions: ["approve", "reject"] },
      { action_name: "some_other_tool", allowed_decisions: ["approve"] },
    ],
  },
};

/**
 * ONE action. The sessionId test below answers a pause and asserts on the
 * resume POST; the two-action shape above stays open until BOTH actions are
 * answered (the controller sends when every action has a decision, never
 * sooner), so the resume would not fire and the assertion would time out
 * rather than fail informatively.
 */
const SINGLE_ACTION = {
  interrupt: {
    action_requests: [
      { name: "increment", args: { by: 1 }, description: "bump the counter" },
    ],
    review_configs: [
      { action_name: "increment", allowed_decisions: ["approve", "reject"] },
    ],
  },
};

beforeEach(() => {
  messages.length = 0;
  window.localStorage.clear();
  // jsdom implements no layout; the surface scrolls on new messages.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("the example app surfaces an upstream approval pause", () => {
  it("renders a pause card on the shipped conversation surface", () => {
    messages.push({ type: "data-approval-pause", id: "m1", data: PAUSE });
    render(<ConversationSurface />);

    // POSITIVE. Not "no error was logged" — a surface that rendered nothing
    // logs nothing either, and that is exactly the state #420 describes.
    expect(screen.getAllByTestId("approval-pause-card")).toHaveLength(2);
    expect(
      screen.getAllByTestId("pause-action-name").map((n) => n.textContent)
    ).toEqual(["increment", "delete_row"]);
  });

  it("offers only the decisions review_configs allows, paired BY INDEX", () => {
    messages.push({ type: "data-approval-pause", id: "m1", data: PAUSE });
    render(<ConversationSurface />);
    const [first, second] = screen.getAllByTestId("approval-pause-card");

    // action 0 -> ["approve","reject"]
    expect(within(first).queryByTestId("pause-approve-button")).not.toBeNull();
    expect(within(first).queryByTestId("pause-reject-button")).not.toBeNull();
    // and NOT the ones it does not allow — without this half, a card that
    // rendered all four controls would pass.
    expect(within(first).queryByTestId("pause-show-respond-button")).toBeNull();

    // action 1 -> ["respond"] ONLY. Disjoint from action 0, so a card that
    // read review_configs[0] for both would fail here.
    expect(
      within(second).queryByTestId("pause-show-respond-button")
    ).not.toBeNull();
    expect(within(second).queryByTestId("pause-approve-button")).toBeNull();
    expect(within(second).queryByTestId("pause-reject-button")).toBeNull();
  });

  it("a config whose action_name disagrees renders the pause UNANSWERABLE", () => {
    // Not "no card". The gate still withheld the call, so the user must still
    // be told; what it cannot do is offer a control upstream would reject.
    messages.push({ type: "data-approval-pause", id: "m1", data: MISPAIRED });
    render(<ConversationSurface />);
    const [, second] = screen.getAllByTestId("approval-pause-card");
    expect(within(second).queryByTestId("pause-no-decisions")).not.toBeNull();
    expect(within(second).queryByTestId("pause-approve-button")).toBeNull();
  });

  it("renders no pause card when no pause arrives", () => {
    // The control. Without it, a surface that rendered the card unconditionally
    // would satisfy both cases above.
    messages.push({
      type: "data-todo",
      id: "m1",
      data: { id: "t", seq: 0, items: [] },
    });
    render(<ConversationSurface />);
    expect(screen.queryByTestId("approval-pause-card")).toBeNull();
  });
});

describe("the decision POST carries the chat's sessionId (#1185)", () => {
  /*
   * DEV1's population sweep on #1188 found that the example UI's approve
   * button sent its decision without the chat's sessionId. fastapi keys the
   * decision to the thread, so without sessionId the dispatch returns 400
   * ("no sessionId was named"). After #1188 lands and the proxy mints one per
   * request, the same call becomes 409 — "the thread holding it is gone.
   * Pending approvals do not survive a backend restart." — a real-error
   * message blaming a restart that did not happen, right in the demo's
   * approval path.
   *
   * The fix: include `sessionId` in the controller's `baseBody`, so the
   * resume POST carries the same id the chat has been using. This is the
   * guard: dropping `sessionId` from baseBody makes this assertion red.
   *
   * The chat hook is mocked; the controller still uses the global `fetch`,
   * which is what the resume POST goes through. A surface that bypassed
   * `fetchImpl` would be exercised through the same channel the real app
   * uses — and that is the surface the demo breaks against.
   */
  it("approve POSTs the chat's sessionId alongside the decision", async () => {
    messages.push({
      type: "data-approval-pause",
      id: "m1",
      data: SINGLE_ACTION,
    });
    // Two fetches happen here: the config probe (`/api/config`) at mount, and
    // the resume POST the click triggers. Returning `"{}"` for the config
    // sets `availableBackends` to undefined and the runtime map throws on the
    // next render — the click triggers a re-render, which trips the throw.
    // So the spy distinguishes the two by URL and serves each its own shape.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.endsWith("/api/config"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                backends: { django: true, fastapi: true, node: true },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });
    try {
      render(<ConversationSurface />);

      const [first] = screen.getAllByTestId("approval-pause-card");
      fireEvent.click(within(first).getByTestId("pause-approve-button"));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      // The LAST call is the resume (the config probe happens first).
      const resumeCall = fetchSpy.mock.calls.find(
        ([c]) =>
          (typeof c === "string" ? c : (c as Request).url) ===
          "/api/chat/stream"
      )!;
      const [, init] = resumeCall;
      const body = JSON.parse(String((init as RequestInit).body));
      // The CHAT'S id, not a constant. ConversationSurface mints it via
      // `newSessionId("example")` (see lib/session-id.ts), so a sessionId
      // carrying that prefix is the one the resume has to thread to.
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId).toMatch(/^example-/);
      // EQUAL to the chat's id, not merely the same prefix: a controller that
      // minted its own `example-` id would satisfy the two lines above.
      expect(body.sessionId).toBe(chatSpy.opts?.sessionId);
      // And the rest of the chat body stays on the resumed turn — baseBody
      // SPREADS, it does not replace, and removing sessionId would still
      // leave these intact and the test would catch nothing.
      expect(body.runtime).toBeDefined();
      expect(body.aiBackend).toBeDefined();
      expect(body.topology).toBeDefined();
      expect(body.approvalDecisions).toEqual([{ type: "approve" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
