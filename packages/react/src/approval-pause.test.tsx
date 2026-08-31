// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useApprovalPauseController } from "./useApprovalPauseController";
import { ApprovalPauseCard } from "./ApprovalPauseCard";
import { ApprovalPauseSchema, type DataApprovalPause } from "./schemas";

/**
 * A GATE THAT WITHHOLDS HAS TO BE ANSWERABLE (#420).
 *
 * Moving the gate upstream makes it genuinely withhold execution and makes the
 * old approval card structurally unreachable: an upstream interrupt emits no
 * tool frames, so the proxy transform that triggers on `tool-input-start` has
 * nothing to gate. Measured on a gated request: status 200, tool executed 0, and
 * one empty message frame — the user is told nothing.
 *
 * These cover pieces 2 and 3 — render the pause, answer it. Every case drives a
 * RENDERED card through a real click and asserts the DOM and the WIRE PAYLOAD.
 * Asserting that a handler returned a decision object would pass against a card
 * nothing renders, which is the same defect one layer up.
 *
 * The wire shape is not invented here. It is what the backends parse, read off
 * `_common.py`:
 *
 *     DECISIONS_FIELD  = "approvalDecisions"      non-empty list
 *     _DECISION_TYPES  = approve | edit | reject | respond
 *     edit             needs edited_action {name, args}
 *     respond          needs message
 */

afterEach(() => {
  cleanup();
});

/** A pause exactly as the Python backend wraps it: {"interrupt": <value>}. */
function pause(
  overrides: Partial<DataApprovalPause["interrupt"]> = {}
): DataApprovalPause {
  return {
    interrupt: {
      action_requests: [
        {
          name: "increment",
          args: { by: 1 },
          description: "Tool execution requires approval",
        },
      ],
      review_configs: [
        {
          action_name: "increment",
          allowed_decisions: ["approve", "edit", "reject", "respond"],
        },
      ],
      ...overrides,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The wiring a consumer writes: cards come from the controller, per action. */
function Surface({
  fetchImpl,
  frame,
}: {
  fetchImpl: typeof fetch;
  /** `null` models an ORDINARY TURN — no pause arrived. */
  frame: DataApprovalPause | null;
}): React.JSX.Element {
  const { cardPropsFor } = useApprovalPauseController({
    endpoint: "/api/chat/stream",
    baseBody: () => ({ runtime: "fastapi", aiBackend: "langchain" }),
    fetchImpl,
  });
  if (!frame) return <p data-testid="no-pause">nothing pending</p>;
  return (
    <>
      {cardPropsFor(frame).map((props, i) => (
        <ApprovalPauseCard key={i} {...props} />
      ))}
    </>
  );
}

const card = () => screen.getByTestId("approval-pause-card");
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

/** The decisions list actually sent, parsed off the request body. */
function sentDecisions(fetchImpl: ReturnType<typeof vi.fn>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String((init as RequestInit).body));
}

describe("the pause is rendered (#420 piece 2)", () => {
  it("names the tool and shows the arguments the call would run with", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    expect(card().getAttribute("data-action-name")).toBe("increment");
    expect(screen.getByTestId("pause-action-name").textContent).toBe(
      "increment"
    );
    // The ARGS, not just the name: a decision is made against what will run.
    expect(screen.getByTestId("pause-arguments").textContent).toContain(
      '"by": 1'
    );
    expect(card().getAttribute("data-answerable")).toBe("yes");
  });

  it("offers exactly the decisions the FRAME allows, and no others", () => {
    /*
     * THE BINDING CONSTRAINT FROM THE RULING. The card must decide from the
     * frame and never ask "is this topology gated" — that fact lives in
     * GATED_TOPOLOGIES on the server, and a second copy in the client drifts the
     * first time someone edits one and not the other.
     *
     * `allowed_decisions` is per action name and arrives IN the pause, so this
     * is checkable directly: narrow it and the controls narrow with it.
     */
    const fetchImpl = vi.fn<typeof fetch>();
    render(
      <Surface
        fetchImpl={fetchImpl}
        frame={pause({
          review_configs: [
            {
              action_name: "increment",
              allowed_decisions: ["approve", "reject"],
            },
          ],
        })}
      />
    );

    expect(screen.queryByTestId("pause-approve-button")).not.toBeNull();
    expect(screen.queryByTestId("pause-reject-button")).not.toBeNull();
    expect(screen.queryByTestId("pause-show-edit-button")).toBeNull();
    expect(screen.queryByTestId("pause-show-respond-button")).toBeNull();
  });

  it("an action upstream said nothing about is surfaced but not answerable", () => {
    // Offering all four would be a control that may be refused; offering nothing
    // silently is the silence this issue exists to remove. So: pause shown, tool
    // named, gap stated.
    const fetchImpl = vi.fn<typeof fetch>();
    render(
      <Surface fetchImpl={fetchImpl} frame={pause({ review_configs: [] })} />
    );

    expect(screen.getByTestId("pause-action-name").textContent).toBe(
      "increment"
    );
    expect(card().getAttribute("data-answerable")).toBe("no");
    expect(screen.queryByTestId("pause-no-decisions")).not.toBeNull();
    expect(screen.queryByTestId("pause-approve-button")).toBeNull();
  });
});

describe("the pause is answered (#420 piece 3)", () => {
  it("approve resumes with the decision the backend parses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    fireEvent.click(btn("pause-approve-button"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/chat/stream");
    const body = JSON.parse(String((init as RequestInit).body));
    // The decisions ride on an ORDINARY CHAT REQUEST, keeping the conversation
    // context — not on a separate approval route.
    expect(body.runtime).toBe("fastapi");
    expect(body.approvalDecisions).toEqual([{ type: "approve" }]);
  });

  it("edit sends edited_action {name, args} — structure a boolean cannot carry", async () => {
    /*
     * This is why the wire diverges from the AI SDK's {id, approved, reason}.
     * The tool runs with DIFFERENT arguments; there is no truthful way to say
     * that with a boolean and a free-text string.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    fireEvent.click(btn("pause-show-edit-button"));
    fireEvent.change(screen.getByTestId("pause-args-input"), {
      target: { value: '{"by": 5}' },
    });
    fireEvent.click(btn("pause-submit-edit-button"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(sentDecisions(fetchImpl).approvalDecisions).toEqual([
      { type: "edit", edited_action: { name: "increment", args: { by: 5 } } },
    ]);
  });

  it("respond sends the text as the tool's RESULT, not as a refusal", async () => {
    /*
     * reject and respond both mean "do not run it" and produce OPPOSITE
     * ToolMessage statuses — error vs success. Collapsing respond into a deny
     * control would tell the model the user REFUSED when the user ANSWERED on
     * the tool's behalf. That is not lossy, it is false.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    fireEvent.click(btn("pause-show-respond-button"));
    fireEvent.change(screen.getByTestId("pause-reply-input"), {
      target: { value: "the user says 7" },
    });
    fireEvent.click(btn("pause-submit-respond-button"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(sentDecisions(fetchImpl).approvalDecisions).toEqual([
      { type: "respond", message: "the user says 7" },
    ]);
  });

  it("reject is its own decision, distinct from respond on the wire", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    fireEvent.click(btn("pause-reject-button"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const sent = sentDecisions(fetchImpl).approvalDecisions;
    expect(sent).toEqual([{ type: "reject" }]);
    // The pair that must never merge: no message field turns this into respond.
    expect(sent[0].message).toBeUndefined();
  });

  it("a refused resume says so ON THE CARD, and the action is answerable again", async () => {
    // Card state, not a returned error — the #399 lesson, applied here before it
    // can be got wrong again.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(400, { error: "unknown decision type 'approve '" })
      );
    render(<Surface fetchImpl={fetchImpl} frame={pause()} />);

    fireEvent.click(btn("pause-approve-button"));

    await waitFor(() =>
      expect(card().getAttribute("data-decision")).toBe("failed")
    );
    expect(screen.getByTestId("pause-decision-error").textContent).toContain(
      "unknown decision type"
    );
    // Not stranded: the decision did not land, so it can be made again.
    expect(card().getAttribute("data-answerable")).toBe("yes");
  });
});

describe("several actions in one pause resume together", () => {
  const two = (): DataApprovalPause => ({
    interrupt: {
      action_requests: [
        { name: "increment", args: { by: 1 }, description: null },
        { name: "write_file", args: { path: "/tmp/x" }, description: null },
      ],
      review_configs: [
        { action_name: "increment", allowed_decisions: ["approve", "reject"] },
        { action_name: "write_file", allowed_decisions: ["approve", "reject"] },
      ],
    },
  });

  it("a partly answered pause does NOT resume", async () => {
    /*
     * `approvalDecisions` is matched POSITIONALLY against `action_requests`, so
     * resuming with a shorter list is a different statement from the one the
     * operator made. A pause with one of two answered stays open.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={two()} />);

    const cards = screen.getAllByTestId("approval-pause-card");
    fireEvent.click(
      cards[0]!.querySelector<HTMLButtonElement>(
        '[data-testid="pause-approve-button"]'
      )!
    );

    // The answered card closes; the other stays open; nothing is sent.
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("approval-pause-card")[0]!
          .getAttribute("data-answerable")
      ).toBe("no")
    );
    expect(
      screen
        .getAllByTestId("approval-pause-card")[1]!
        .getAttribute("data-answerable")
    ).toBe("yes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answering both resumes once, in the pause's own order", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<Surface fetchImpl={fetchImpl} frame={two()} />);

    const clickOn = (index: number, testid: string) =>
      fireEvent.click(
        screen
          .getAllByTestId("approval-pause-card")
          [index]!.querySelector<HTMLButtonElement>(
            `[data-testid="${testid}"]`
          )!
      );

    clickOn(1, "pause-reject-button");
    await waitFor(() => expect(fetchImpl).not.toHaveBeenCalled());
    clickOn(0, "pause-approve-button");

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // Positional: index 0 is increment (approve), index 1 is write_file (reject)
    // — NOT the order they were clicked in.
    expect(sentDecisions(fetchImpl).approvalDecisions).toEqual([
      { type: "approve" },
      { type: "reject" },
    ]);
  });
});

describe("the two lists are aligned by INDEX, not matched by name", () => {
  /*
   * DEV1 measured that the middleware appends one `action_request` and one
   * `review_config` per interrupted call in lockstep, so they are aligned by
   * position. Nothing forbids the same tool appearing twice in one AI message,
   * and a name lookup answers the first entry for both — a silently wrong
   * allowed-set, which is worse than a crash because the card still renders.
   */
  it("the same tool twice gets ITS OWN allowed_decisions, not the first one's", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const twoOfTheSame: DataApprovalPause = {
      interrupt: {
        action_requests: [
          { name: "increment", args: { by: 1 }, description: null },
          { name: "increment", args: { by: 99 }, description: null },
        ],
        review_configs: [
          { action_name: "increment", allowed_decisions: ["approve"] },
          { action_name: "increment", allowed_decisions: ["reject"] },
        ],
      },
    };
    render(<Surface fetchImpl={fetchImpl} frame={twoOfTheSame} />);

    const cards = screen.getAllByTestId("approval-pause-card");
    // First permits approve only; second permits reject only. A name lookup
    // would give BOTH cards an Approve button and no Reject button.
    expect(
      cards[0]!.querySelector('[data-testid="pause-approve-button"]')
    ).not.toBeNull();
    expect(
      cards[0]!.querySelector('[data-testid="pause-reject-button"]')
    ).toBeNull();
    expect(
      cards[1]!.querySelector('[data-testid="pause-approve-button"]')
    ).toBeNull();
    expect(
      cards[1]!.querySelector('[data-testid="pause-reject-button"]')
    ).not.toBeNull();
  });

  it("a misaligned frame is surfaced but not answerable, rather than guessed", () => {
    // review_configs shorter than action_requests: the lists lost their
    // alignment in transit and nothing can say what is permitted for action 1.
    const fetchImpl = vi.fn<typeof fetch>();
    render(
      <Surface
        fetchImpl={fetchImpl}
        frame={{
          interrupt: {
            action_requests: [
              { name: "increment", args: {}, description: null },
              { name: "wipe", args: {}, description: null },
            ],
            review_configs: [
              { action_name: "increment", allowed_decisions: ["approve"] },
            ],
          },
        }}
      />
    );

    const cards = screen.getAllByTestId("approval-pause-card");
    expect(cards[0]!.getAttribute("data-answerable")).toBe("yes");
    expect(cards[1]!.getAttribute("data-answerable")).toBe("no");
    // Still SURFACED — the tool is named even though it cannot be answered.
    expect(cards[1]!.getAttribute("data-action-name")).toBe("wipe");
    expect(
      cards[1]!.querySelector('[data-testid="pause-no-decisions"]')
    ).not.toBeNull();
  });
});

describe("the sent list can never trip upstream's length check", () => {
  it("sends exactly one decision per action request", async () => {
    /*
     * `human_in_the_loop.py:459` raises on
     * `len(decisions) != len(interrupt_indices)`, and because the dispatch
     * parses the body without graph state, that failure returns as a data-error
     * inside a 200 rather than a 400 — a shape that is easy to read as success.
     * The client stays out of that path by construction, and this is the
     * assertion that says so.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    const three: DataApprovalPause = {
      interrupt: {
        action_requests: [
          { name: "a", args: {}, description: null },
          { name: "b", args: {}, description: null },
          { name: "c", args: {}, description: null },
        ],
        review_configs: [
          { action_name: "a", allowed_decisions: ["approve"] },
          { action_name: "b", allowed_decisions: ["approve"] },
          { action_name: "c", allowed_decisions: ["approve"] },
        ],
      },
    };
    render(<Surface fetchImpl={fetchImpl} frame={three} />);

    for (let i = 0; i < 3; i++) {
      const cards = screen.getAllByTestId("approval-pause-card");
      const live = cards.filter(
        (c) => c.getAttribute("data-answerable") === "yes"
      );
      fireEvent.click(
        live[0]!.querySelector<HTMLButtonElement>(
          '[data-testid="pause-approve-button"]'
        )!
      );
      if (i < 2) {
        // eslint-disable-next-line no-await-in-loop
        await waitFor(() => expect(fetchImpl).not.toHaveBeenCalled());
      }
    }

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(sentDecisions(fetchImpl).approvalDecisions).toHaveLength(3);
  });
});

describe("an ungated turn is unchanged (#420 presence companion)", () => {
  it("no pause frame means no card, no request, no new latency", () => {
    /*
     * THE HALF THAT IS USUALLY SKIPPED. Without it, everything above is
     * satisfied by something that pauses every turn.
     *
     * `frame={null}` is an ordinary turn. Nothing renders and — the part that
     * would actually cost a user — NOTHING IS FETCHED. A controller that probed
     * an endpoint to discover whether a pause exists would pass a
     * "no card is shown" assertion while adding a round trip to every turn.
     */
    const fetchImpl = vi.fn<typeof fetch>();
    render(<Surface fetchImpl={fetchImpl} frame={null} />);

    expect(screen.queryByTestId("approval-pause-card")).toBeNull();
    expect(screen.queryByTestId("no-pause")).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the pause schema carries upstream verbatim", () => {
  it("accepts the payload shape the Python backend emits", () => {
    // Guards the seam with the adapter: if the wrapper key or the snake_case
    // names change, this fails here rather than as a card that never renders.
    const parsed = ApprovalPauseSchema.safeParse(pause());
    expect(parsed.success).toBe(true);
  });

  it("rejects a decision vocabulary that is not upstream's four", () => {
    const bad = {
      interrupt: {
        action_requests: [{ name: "increment", args: {} }],
        review_configs: [
          { action_name: "increment", allowed_decisions: ["approved"] },
        ],
      },
    };
    expect(ApprovalPauseSchema.safeParse(bad).success).toBe(false);
  });
});
