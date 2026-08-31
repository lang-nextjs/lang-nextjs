// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useApprovalCardController } from "./useApprovalCardController";
import { ApprovalCard } from "./ApprovalCard";
import type { DataApproval } from "./schemas";

/**
 * A CLICK THAT DID NOTHING HAS TO SAY SO (#399).
 *
 * Measured in #399: a decision arriving for a thread the saver no longer holds
 * executes nothing and raises nothing. Failing closed on the effect is correct
 * — this is an availability problem, not a safety one — but the operator was
 * told nothing, and the reference shell made that concrete by destructuring the
 * hook's `error` and never rendering it.
 *
 * WHAT THESE TESTS ASSERT IS THE CARD, NOT THE RETURN VALUE. The suite already
 * had "non-2xx responses surface in `error` and `status` of the hook return",
 * and that test passes against exactly the shipped defect: the value existed,
 * nothing downstream read it. So every case here drives a rendered
 * <ApprovalCard> through a real click and asserts the DOM it produces.
 */

afterEach(() => {
  cleanup();
});

function makeApproval(overrides: Partial<DataApproval> = {}): DataApproval {
  return {
    id: "appr-1",
    seq: 0,
    actionName: "bash_execute",
    description: "Run this?",
    arguments: { cmd: "ls" },
    status: "waiting",
    createdAt: "2026-04-29T00:00:00Z",
    expiresAt: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The wiring a consumer actually writes: call cardPropsFor during render and
 * spread it. Anything that only exercises the hook through renderHook cannot
 * observe the defect, because the defect IS the gap between the two.
 */
function Surface({
  fetchImpl,
  approvals,
}: {
  fetchImpl: typeof fetch;
  approvals: DataApproval[];
}): React.JSX.Element {
  const { cardPropsFor } = useApprovalCardController({
    endpoint: "/api/approval",
    fetchImpl,
  });
  return (
    <>
      {approvals.map((a) => (
        <ApprovalCard key={a.id} {...cardPropsFor(a)} />
      ))}
    </>
  );
}

const card = () => screen.getByTestId("approval-card");
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const decisionOf = (el: HTMLElement) => el.getAttribute("data-decision");

describe("a decision for a LOST thread (#399)", () => {
  it("reports the failure and the card stops being answerable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(404, { error: "approval not found or expired" })
      );
    render(<Surface fetchImpl={fetchImpl} approvals={[makeApproval()]} />);

    // Before the click the card is answerable and says nothing about a failure.
    expect(decisionOf(card())).toBeNull();
    expect(btn("approve-button").disabled).toBe(false);

    fireEvent.click(screen.getByTestId("approve-button"));

    // THE CARD'S STATE MOVED — this is the assertion, not the returned error.
    await waitFor(() => expect(decisionOf(card())).toBe("unresolvable"));
    // The operator is told, in the route's own words.
    expect(screen.getByTestId("approval-decision-error").textContent).toContain(
      "approval not found or expired"
    );
    // And the affordance is gone, because retrying a vanished thread cannot work.
    expect(btn("approve-button").disabled).toBe(true);
    expect(btn("reject-button").disabled).toBe(true);
  });

  it("names the card that failed, not merely that something did", async () => {
    /*
     * The hook's own `error` is per-hook while cardPropsFor is per-approval, so
     * a consumer rendering that field would attribute the failure to whichever
     * card it happened to sit next to. With two cards open, only the one that
     * was clicked may change — otherwise "it reports the failure" is satisfied
     * by a banner that indicts every pending approval on screen.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(404, { error: "approval not found or expired" })
      );
    render(
      <Surface
        fetchImpl={fetchImpl}
        approvals={[
          makeApproval({ id: "appr-lost" }),
          makeApproval({ id: "appr-live" }),
        ]}
      />
    );

    const cards = () => screen.getAllByTestId("approval-card");
    const lost = () =>
      cards().find((c) => c.getAttribute("data-approval-id") === "appr-lost")!;
    const live = () =>
      cards().find((c) => c.getAttribute("data-approval-id") === "appr-live")!;

    fireEvent.click(
      lost().querySelector<HTMLButtonElement>('[data-testid="approve-button"]')!
    );

    await waitFor(() => expect(decisionOf(lost())).toBe("unresolvable"));
    // The untouched card is untouched.
    expect(decisionOf(live())).toBeNull();
    expect(
      live().querySelector('[data-testid="approval-decision-error"]')
    ).toBeNull();
    expect(
      live().querySelector<HTMLButtonElement>('[data-testid="approve-button"]')!
        .disabled
    ).toBe(false);
  });

  it("a retryable failure reports itself but keeps the buttons alive", async () => {
    // A 503 is a blip, not a vanished thread. Killing the affordance here would
    // turn a recoverable hiccup into a permanently dead card.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(503, { error: "backend unavailable" }));
    render(<Surface fetchImpl={fetchImpl} approvals={[makeApproval()]} />);

    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() => expect(decisionOf(card())).toBe("failed"));
    expect(screen.getByTestId("approval-decision-error").textContent).toContain(
      "backend unavailable"
    );
    expect(btn("approve-button").disabled).toBe(false);
  });

  it("a retry that succeeds clears the failure it replaces", async () => {
    // Otherwise the card keeps accusing itself after the decision landed.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(503, { error: "backend unavailable" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { id: "appr-1", decision: "approve", accepted: true })
      );
    render(<Surface fetchImpl={fetchImpl} approvals={[makeApproval()]} />);

    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(decisionOf(card())).toBe("failed"));

    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(decisionOf(card())).toBeNull());
    expect(screen.queryByTestId("approval-decision-error")).toBeNull();
  });
});

describe("a decision for a LIVE thread is unchanged (#399 presence companion)", () => {
  it("succeeds silently — no alert, no state change, and the POST still happened", async () => {
    /*
     * THE HALF THAT IS USUALLY SKIPPED. Without it, every assertion above is
     * satisfied by a change that reports failure for every decision, including
     * the ones that worked.
     *
     * It carries its own presence companion in turn: asserting only "no error
     * appeared" would pass against a button wired to nothing. So the request
     * itself is asserted — a decision was really sent — and only then the
     * absence of any failure state.
     */
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "approve", accepted: true })
      );
    render(<Surface fetchImpl={fetchImpl} approvals={[makeApproval()]} />);

    fireEvent.click(screen.getByTestId("approve-button"));

    // The click did something.
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/approval/appr-1");
    expect(JSON.parse(String(init!.body))).toEqual({ decision: "approve" });

    /*
     * WAIT FOR THE DECISION TO SETTLE, THEN ASSERT — the claim is about the card
     * AFTER a successful decision, and this used to sample it DURING one.
     *
     * `waitFor(fetch was called)` above proves the request was ISSUED, not that
     * it completed. In between, the controller reports `status === "submitting"`
     * and the card is correctly disabled, so a bare `expect(disabled).toBe(false)`
     * at that moment reads a true in-flight state as a failure. It passed only
     * because the assertions above it happened to give React time to flush.
     *
     * Measured, in the full tree with no eject involved: make the POST resolve
     * 5ms later and this fails with `expected true to be false` — the same
     * assertion and the same message CI produced on the ejected-rung-4 job,
     * whose only relevance was different timing.
     *
     * THIS IS NOT THE COMPANION LEARNING TO TOLERATE A DISABLED BUTTON. It
     * REQUIRES the button to become enabled and fails if it never does, so a
     * card that is genuinely stuck after a successful decision still goes red —
     * which is the defect this case exists to catch. What changed is only WHEN
     * the state is read: after the decision, which is when the claim applies.
     */
    await waitFor(() =>
      expect(
        btn("approve-button").disabled,
        "the card never became usable again after a decision the server accepted"
      ).toBe(false)
    );

    // And it did it silently.
    expect(screen.queryByTestId("approval-decision-error")).toBeNull();
    expect(decisionOf(card())).toBeNull();
  });

  it("a rejected decision that the server accepts is equally silent", async () => {
    // "reject" is a decision that SUCCEEDS. Conflating it with a failed
    // submission is an easy way to make the failure path look load-bearing
    // while it is really firing on every non-approve click.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "reject", accepted: true })
      );
    render(<Surface fetchImpl={fetchImpl} approvals={[makeApproval()]} />);

    fireEvent.click(screen.getByTestId("reject-button"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // Settle before reading the card, for the reason spelled out above: the
    // request being issued is not the decision being finished.
    await waitFor(() => expect(btn("reject-button").disabled).toBe(false));
    expect(screen.queryByTestId("approval-decision-error")).toBeNull();
    expect(decisionOf(card())).toBeNull();
  });
});
